use adobepy_broker::bootstrap_transaction::{
    BootstrapProbe, ConfigTransactionError, ConfigTransactionOwner, FileReceipt, HelperPoolError,
    HelperProcessPool, HelperProgram, HelperRequest, HelperResponse, HostProcessBroker,
    StagedArtifact,
};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

fn helper_program() -> HelperProgram {
    HelperProgram::new(
        std::path::PathBuf::from(env!("CARGO_BIN_EXE_adobepy-bootstrap-helper")),
        Vec::new(),
    )
}

fn isolated_dir(label: &str) -> std::path::PathBuf {
    let path =
        std::env::temp_dir().join(format!("adobepy-{label}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&path).unwrap();
    path
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn non_cooperative_helper_is_killed_reaped_and_times_out_within_the_slo() {
    let pool = HelperProcessPool::new(helper_program(), 1, 0).unwrap();
    let started = std::time::Instant::now();
    let result = pool
        .execute(
            HelperRequest::Sleep { millis: 1_000 },
            tokio::time::Instant::now() + Duration::from_millis(50),
        )
        .await;

    assert_eq!(result.unwrap_err(), HelperPoolError::TimedOut);
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "50 ms helper deadline settled in {:?}",
        started.elapsed()
    );
    let replacement = pool
        .execute(
            HelperRequest::Sleep { millis: 0 },
            tokio::time::Instant::now() + Duration::from_millis(50),
        )
        .await;
    assert!(matches!(
        replacement,
        Ok(HelperResponse::Completed)
            | Err(HelperPoolError::Overloaded)
            | Err(HelperPoolError::TimedOut)
            | Err(HelperPoolError::ShuttingDown)
    ));
    assert_eq!(pool.snapshot().maximum_running_helpers, 1);
    assert!(
        pool.shutdown(tokio::time::Instant::now() + Duration::from_secs(2))
            .await
    );
    assert_eq!(pool.snapshot().active_jobs, 0);
    assert_eq!(pool.snapshot().running_helpers, 0);
}

#[tokio::test]
async fn helper_deadline_race_at_45_50_and_55_milliseconds_always_quiesces() {
    for delay in [45, 50, 55] {
        let pool = HelperProcessPool::new(helper_program(), 1, 0).unwrap();
        let result = pool
            .execute(
                HelperRequest::Sleep { millis: delay },
                tokio::time::Instant::now() + Duration::from_millis(50),
            )
            .await;
        assert!(matches!(
            result,
            Ok(HelperResponse::Completed) | Err(HelperPoolError::TimedOut)
        ));
        assert!(
            pool.shutdown(tokio::time::Instant::now() + Duration::from_secs(2))
                .await
        );
        assert_eq!(pool.snapshot().active_jobs, 0);
        assert_eq!(pool.snapshot().running_helpers, 0);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn admission_queue_process_count_and_shutdown_are_bounded() {
    let pool = HelperProcessPool::new(helper_program(), 2, 1).unwrap();
    let tasks = (0..3)
        .map(|_| {
            let pool = pool.clone();
            tokio::spawn(async move {
                pool.execute(
                    HelperRequest::Sleep { millis: 1_000 },
                    tokio::time::Instant::now() + Duration::from_secs(5),
                )
                .await
            })
        })
        .collect::<Vec<_>>();
    tokio::time::timeout(Duration::from_secs(1), async {
        while pool.snapshot().active_jobs != 3 || pool.snapshot().running_helpers != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("two helpers and one queued job must be owned by the pool");

    let overloaded = pool
        .execute(
            HelperRequest::Sleep { millis: 1 },
            tokio::time::Instant::now() + Duration::from_secs(1),
        )
        .await;
    assert_eq!(overloaded.unwrap_err(), HelperPoolError::Overloaded);
    let shutdown = pool
        .shutdown(tokio::time::Instant::now() + Duration::from_millis(500))
        .await;
    assert!(
        shutdown,
        "shutdown did not quiesce every phase: {:?}",
        pool.snapshot()
    );
    for task in tasks {
        let result = task.await.unwrap();
        assert!(
            matches!(result, Err(HelperPoolError::ShuttingDown)),
            "shutdown task returned {result:?}"
        );
    }
    let snapshot = pool.snapshot();
    assert_eq!(snapshot.active_jobs, 0);
    assert_eq!(snapshot.queued_jobs, 0);
    assert_eq!(snapshot.running_helpers, 0);
    assert_eq!(snapshot.preparing_helpers, 0);
    assert_eq!(snapshot.spawning_helpers, 0);
    assert_eq!(snapshot.owned_children, 0);
    assert_eq!(snapshot.reaping_children, 0);
    assert!(snapshot.maximum_active_jobs <= 3);
    assert!(snapshot.maximum_running_helpers <= 2);
}

#[tokio::test]
async fn helper_staging_is_generation_scoped_and_inert() {
    let pool = HelperProcessPool::new(helper_program(), 1, 0).unwrap();
    let generation = 42;
    let transaction_id = uuid::Uuid::new_v4().hyphenated().to_string();
    let staging_id = uuid::Uuid::new_v4().hyphenated().to_string();
    let response = pool
        .execute(
            HelperRequest::Stage {
                generation,
                transaction_id: transaction_id.clone(),
                staging_id: staging_id.clone(),
                bytes: b"PRIVATE_STAGED_CONFIGURATION".to_vec(),
            },
            tokio::time::Instant::now() + Duration::from_secs(10),
        )
        .await
        .unwrap();
    let HelperResponse::Staged {
        generation: actual_generation,
        transaction_id: actual_transaction_id,
        staging_id: actual_staging_id,
        path,
        bytes,
        ..
    } = response
    else {
        panic!("expected an inert staged response")
    };
    assert_eq!(actual_generation, generation);
    assert_eq!(actual_transaction_id, transaction_id);
    assert_eq!(actual_staging_id, staging_id);
    assert_eq!(bytes, 28);
    assert_eq!(
        std::fs::read(&path).unwrap(),
        b"PRIVATE_STAGED_CONFIGURATION"
    );
    assert!(path.starts_with(std::env::temp_dir().join("adobepy-bootstrap-staging")));
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_dir(path.parent().unwrap()).unwrap();
    assert!(
        pool.shutdown(tokio::time::Instant::now() + Duration::from_millis(500))
            .await
    );
    assert_eq!(pool.snapshot().owned_children, 0);
}

#[tokio::test]
async fn persistent_helper_is_reused_without_replacement_or_capacity_growth() {
    let pool = HelperProcessPool::new(helper_program(), 1, 0).unwrap();
    let initial = pool.snapshot();
    assert_eq!(initial.owned_children, 1);
    assert_eq!(initial.spawning_helpers, 0);

    for _ in 0..3 {
        assert_eq!(
            pool.execute(
                HelperRequest::Sleep { millis: 0 },
                tokio::time::Instant::now() + Duration::from_millis(250),
            )
            .await
            .unwrap(),
            HelperResponse::Completed
        );
        let snapshot = pool.snapshot();
        assert_eq!(snapshot.owned_children, 1);
        assert_eq!(snapshot.spawning_helpers, 0);
    }

    assert!(
        pool.shutdown(tokio::time::Instant::now() + Duration::from_millis(500))
            .await
    );
    assert_eq!(pool.snapshot().owned_children, 0);
}

#[tokio::test]
async fn helper_stage_can_only_be_redeemed_by_its_exact_config_generation() {
    let root = isolated_dir("helper-config-generation");
    let config = root.join("config.js");
    std::fs::write(&config, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&config).unwrap();
    let mut lease = owner.begin(&config, &expected).unwrap();
    let probe = BootstrapProbe::new(helper_program(), 1, 0).unwrap();
    let staged = probe
        .stage(
            lease.identity(),
            b"transient".to_vec(),
            tokio::time::Instant::now() + Duration::from_secs(10),
        )
        .await
        .unwrap();
    lease.activate(&staged).unwrap();
    lease.rollback().unwrap();
    assert_eq!(std::fs::read(&config).unwrap(), b"old");
    std::fs::remove_file(&staged.path).unwrap();
    std::fs::remove_dir(staged.path.parent().unwrap()).unwrap();
    std::fs::remove_dir_all(root).unwrap();
    assert!(
        probe
            .shutdown(tokio::time::Instant::now() + Duration::from_millis(500))
            .await
    );
}

#[tokio::test]
async fn host_owner_retains_original_process_and_reaps_the_job_tree() {
    let broker = HostProcessBroker::default();
    let process = broker
        .spawn(
            std::path::Path::new(env!("CARGO_BIN_EXE_adobepy-bootstrap-helper")),
            &["--hold-ms".into(), "1000".into()],
        )
        .unwrap();
    let identity = process.identity().clone();
    assert!(process.matches(&identity));
    assert!(identity.pid() > 0);
    let started = std::time::Instant::now();
    process
        .terminate_and_reap(tokio::time::Instant::now() + Duration::from_millis(200))
        .await
        .unwrap();
    assert!(started.elapsed() < Duration::from_millis(250));
    assert!(
        broker
            .quiesce(tokio::time::Instant::now() + Duration::from_millis(50))
            .await
    );
}

#[tokio::test]
async fn host_owner_drop_is_nonblocking_and_keeps_reap_ownership() {
    let broker = HostProcessBroker::default();
    let process = broker
        .spawn(
            std::path::Path::new(env!("CARGO_BIN_EXE_adobepy-bootstrap-helper")),
            &["--hold-ms".into(), "1000".into()],
        )
        .unwrap();
    let started = std::time::Instant::now();
    drop(process);
    assert!(started.elapsed() < Duration::from_millis(50));
    assert!(
        broker
            .quiesce(tokio::time::Instant::now() + Duration::from_millis(250))
            .await,
        "dropped host owner did not retain ownership until the child was reaped"
    );
}

#[tokio::test]
async fn host_supervisor_bounds_capacity_and_shutdown_reaps_every_owned_child() {
    let broker = HostProcessBroker::default();
    let mut processes = Vec::new();
    for _ in 0..8 {
        processes.push(
            broker
                .spawn(
                    std::path::Path::new(env!("CARGO_BIN_EXE_adobepy-bootstrap-helper")),
                    &["--hold-ms".into(), "10000".into()],
                )
                .unwrap(),
        );
    }
    assert_eq!(broker.snapshot().active_processes, 8);
    assert_eq!(broker.snapshot().maximum_active_processes, 8);
    assert_eq!(broker.snapshot().capacity, 8);
    assert!(broker
        .spawn(
            std::path::Path::new(env!("CARGO_BIN_EXE_adobepy-bootstrap-helper")),
            &["--hold-ms".into(), "10000".into()],
        )
        .is_err());

    assert!(
        broker
            .shutdown(tokio::time::Instant::now() + Duration::from_millis(500))
            .await,
        "bounded host shutdown did not retain ownership through wait/reap"
    );
    let snapshot = broker.snapshot();
    assert_eq!(snapshot.active_processes, 0);
    assert_eq!(snapshot.platform_process_owners, 0);
    assert!(snapshot.closed);
    drop(processes);
}

#[cfg(windows)]
#[tokio::test]
async fn windows_host_supervisor_closes_every_job_and_child_handle_across_reuse() {
    let broker = HostProcessBroker::default();
    for _ in 0..20 {
        let process = broker
            .spawn(
                std::path::Path::new(env!("CARGO_BIN_EXE_adobepy-bootstrap-helper")),
                &["--hold-ms".into(), "1000".into()],
            )
            .unwrap();
        process
            .terminate_and_reap(tokio::time::Instant::now() + Duration::from_millis(500))
            .await
            .unwrap();
        let snapshot = broker.snapshot();
        assert_eq!(snapshot.active_processes, 0);
        assert_eq!(snapshot.platform_process_owners, 0);
    }
    assert_eq!(broker.snapshot().maximum_active_processes, 1);
}

#[test]
fn host_owner_drop_outside_an_entered_runtime_still_reaps_and_quiesces() {
    let broker = HostProcessBroker::default();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let process = {
        let _entered = runtime.enter();
        broker
            .spawn(
                std::path::Path::new(env!("CARGO_BIN_EXE_adobepy-bootstrap-helper")),
                &["--hold-ms".into(), "1000".into()],
            )
            .unwrap()
    };
    drop(runtime);

    let started = std::time::Instant::now();
    drop(process);
    assert!(started.elapsed() < Duration::from_millis(50));

    let verifier = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    assert!(
        verifier.block_on(broker.quiesce(tokio::time::Instant::now() + Duration::from_millis(500))),
        "runtime-independent host ownership did not reach actual wait/reap"
    );
}

#[tokio::test]
async fn host_ownership_cannot_be_redirected_to_a_foreign_process_identity() {
    let broker = HostProcessBroker::default();
    let first = broker
        .spawn(
            std::path::Path::new(env!("CARGO_BIN_EXE_adobepy-bootstrap-helper")),
            &["--hold-ms".into(), "1000".into()],
        )
        .unwrap();
    let second = broker
        .spawn(
            std::path::Path::new(env!("CARGO_BIN_EXE_adobepy-bootstrap-helper")),
            &["--hold-ms".into(), "1000".into()],
        )
        .unwrap();
    assert!(!first.matches(second.identity()));
    assert!(!second.matches(first.identity()));
    first
        .terminate_and_reap(tokio::time::Instant::now() + Duration::from_millis(200))
        .await
        .unwrap();
    second
        .terminate_and_reap(tokio::time::Instant::now() + Duration::from_millis(200))
        .await
        .unwrap();
    assert!(
        broker
            .quiesce(tokio::time::Instant::now() + Duration::from_millis(50))
            .await
    );
}

#[test]
fn sensitive_helper_panic_is_redacted_at_the_process_stderr_boundary() {
    let request_id = uuid::Uuid::new_v4().hyphenated().to_string();
    let encoded = serde_json::to_vec(&serde_json::json!({
        "protocol_version": 1,
        "request_id": request_id,
        "request": HelperRequest::PanicProbe,
    }))
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_adobepy-bootstrap-helper"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&encoded).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        response["response"],
        serde_json::to_value(HelperResponse::Failed {
            code: "worker_panicked".into(),
        })
        .unwrap()
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("sensitive bootstrap worker panicked"));
    assert!(!stderr.contains("PRIVATE_HOSTILE_BOOTSTRAP_TOKEN"));
    assert!(!stderr.contains("C:/private/plugin.js"));
}

#[test]
fn ordinary_panic_hook_behavior_is_preserved_outside_sensitive_work() {
    let output = Command::new(env!("CARGO_BIN_EXE_adobepy-bootstrap-helper"))
        .arg("--ordinary-panic")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("ORDINARY_PANIC_HOOK_MARKER"));
    assert!(!stderr.contains("sensitive bootstrap worker panicked"));
}

#[test]
fn helper_rejects_an_oversized_request_before_newline_or_eof() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_adobepy-bootstrap-helper"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&vec![b'x'; 600 * 1024]);
        let _ = stdin.flush();
        let _ = release_rx.recv_timeout(Duration::from_secs(2));
    });
    let deadline = std::time::Instant::now() + Duration::from_millis(500);
    let exited = loop {
        if child.try_wait().unwrap().is_some() {
            break true;
        }
        if std::time::Instant::now() >= deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    if !exited {
        child.kill().unwrap();
        child.wait().unwrap();
    }
    let _ = release_tx.send(());
    writer.join().unwrap();
    assert!(exited, "oversized unterminated request remained buffered");
}

#[test]
fn config_generation_rejects_late_staging_and_drop_is_nonblocking() {
    let root = isolated_dir("config-generation");
    let config = root.join("config.js");
    std::fs::write(&config, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&config).unwrap();
    let first = owner.begin(&config, &expected).unwrap();
    let first_identity = first.identity();
    let started = std::time::Instant::now();
    drop(first);
    assert!(started.elapsed() < Duration::from_millis(10));
    assert!(owner.is_quiescent());

    let expected = FileReceipt::capture(&config).unwrap();
    let mut second = owner.begin(&config, &expected).unwrap();
    let staged_path = root.join("late.js");
    std::fs::write(&staged_path, b"late").unwrap();
    let stale = StagedArtifact::capture(first_identity, &staged_path).unwrap();
    assert_eq!(
        second.activate(&stale).unwrap_err(),
        ConfigTransactionError::Stale
    );
    assert_eq!(std::fs::read(&config).unwrap(), b"old");
    second.revoke().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn staged_artifact_from_another_owner_with_the_same_generation_is_stale() {
    let root = isolated_dir("config-cross-owner-generation");
    let first_config = root.join("first.js");
    let second_config = root.join("second.js");
    let staged_path = root.join("staged.js");
    std::fs::write(&first_config, b"first").unwrap();
    std::fs::write(&second_config, b"second").unwrap();
    std::fs::write(&staged_path, b"foreign").unwrap();

    let first_owner = ConfigTransactionOwner::default();
    let first_expected = FileReceipt::capture(&first_config).unwrap();
    let first = first_owner.begin(&first_config, &first_expected).unwrap();
    let foreign = StagedArtifact::capture(first.identity(), &staged_path).unwrap();
    first.revoke().unwrap();

    let second_owner = ConfigTransactionOwner::default();
    let second_expected = FileReceipt::capture(&second_config).unwrap();
    let mut second = second_owner
        .begin(&second_config, &second_expected)
        .unwrap();
    assert!(first_owner.is_quiescent());
    assert_eq!(first_expected.path(), first_config);
    assert_eq!(second.generation(), 1);
    assert_eq!(
        second.activate(&foreign).unwrap_err(),
        ConfigTransactionError::Stale
    );
    assert_eq!(std::fs::read(&second_config).unwrap(), b"second");
    second.revoke().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn config_claim_is_atomic_and_failed_identity_or_competing_claim_does_not_consume_it() {
    let root = isolated_dir("config-claim");
    let config = root.join("config.js");
    std::fs::write(&config, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let stale = FileReceipt::capture(&config).unwrap();
    std::fs::write(&config, b"external").unwrap();
    assert_eq!(
        owner.begin(&config, &stale).unwrap_err(),
        ConfigTransactionError::IdentityChanged
    );
    let current = FileReceipt::capture(&config).unwrap();
    let first = owner.begin(&config, &current).unwrap();
    assert_eq!(first.generation(), 1);
    assert_eq!(
        owner.begin(&config, &current).unwrap_err(),
        ConfigTransactionError::Busy
    );
    first.revoke().unwrap();
    let second = owner.begin(&config, &current).unwrap();
    assert_eq!(second.generation(), 2);
    second.revoke().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn config_finalize_fails_closed_on_same_bytes_new_identity() {
    let root = isolated_dir("config-identity");
    let config = root.join("config.js");
    std::fs::write(&config, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&config).unwrap();
    let mut lease = owner.begin(&config, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
    lease.activate(&staged).unwrap();

    let replacement = root.join("replacement.js");
    std::fs::write(&replacement, b"transient").unwrap();
    std::fs::remove_file(&config).unwrap();
    std::fs::rename(&replacement, &config).unwrap();
    assert_eq!(
        lease.finalize(b"committed").unwrap_err(),
        ConfigTransactionError::IdentityChanged
    );
    assert_eq!(std::fs::read(&config).unwrap(), b"transient");
    drop(lease);
    assert!(!owner.is_quiescent());
    assert_eq!(
        owner
            .begin(&config, &FileReceipt::capture(&config).unwrap())
            .unwrap_err(),
        ConfigTransactionError::Busy
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn config_finalize_commits_the_exact_receipt_and_quiesces_the_owner() {
    let root = isolated_dir("config-finalize");
    let config = root.join("config.js");
    std::fs::write(&config, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&config).unwrap();
    let mut lease = owner.begin(&config, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();

    lease.activate(&staged).unwrap();
    let receipt = lease.finalize(b"committed").unwrap();

    assert_eq!(receipt, FileReceipt::capture(&config).unwrap());
    assert_eq!(std::fs::read(&config).unwrap(), b"committed");
    assert!(owner.is_quiescent());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn config_commit_remains_rollback_capable_until_confirmation() {
    let root = isolated_dir("config-commit-pending");
    let destination = root.join("config.js");
    std::fs::write(&destination, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&destination).unwrap();
    let mut lease = owner.begin(&destination, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
    lease.activate(&staged).unwrap();

    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let receipt = lease
        .prepare_commit_cancellable(b"committed", &cancelled)
        .unwrap();
    let confirmation = lease.prepare_commit_confirmation(&receipt).unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"committed");
    assert!(!owner.is_quiescent());

    drop(confirmation);
    lease.rollback().unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"old");
    assert!(owner.is_quiescent());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn confirmed_pending_publication_remains_rollback_capable() {
    let root = isolated_dir("config-confirmed-pending-rollback");
    let destination = root.join("config.js");
    std::fs::write(&destination, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&destination).unwrap();
    let mut lease = owner.begin(&destination, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
    lease.activate(&staged).unwrap();
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let receipt = lease
        .prepare_commit_cancellable(b"committed", &cancelled)
        .unwrap();
    let confirmation = lease.prepare_commit_confirmation(&receipt).unwrap();
    let publication = lease.confirm_prevalidated(confirmation).unwrap();
    drop(publication);

    lease.rollback().unwrap();

    assert_eq!(std::fs::read(&destination).unwrap(), b"old");
    assert!(owner.is_quiescent());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn publication_and_rollback_have_one_atomic_winner() {
    for iteration in 0..50 {
        let root = isolated_dir(&format!("config-publication-race-{iteration}"));
        let destination = root.join("config.js");
        std::fs::write(&destination, b"old").unwrap();
        let owner = ConfigTransactionOwner::default();
        let expected = FileReceipt::capture(&destination).unwrap();
        let mut lease = owner.begin(&destination, &expected).unwrap();
        let staged_path = root.join("staged.js");
        std::fs::write(&staged_path, b"transient").unwrap();
        let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
        lease.activate(&staged).unwrap();
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let receipt = lease
            .prepare_commit_cancellable(b"committed", &cancelled)
            .unwrap();
        let confirmation = lease.prepare_commit_confirmation(&receipt).unwrap();
        let publication = lease.confirm_prevalidated(confirmation).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let publish_barrier = barrier.clone();
        let publish = std::thread::spawn(move || {
            publish_barrier.wait();
            publication.publish()
        });
        let rollback = std::thread::spawn(move || {
            barrier.wait();
            lease.rollback()
        });

        let published = publish.join().unwrap();
        let rolled_back = rollback.join().unwrap();

        assert_ne!(published.is_ok(), rolled_back.is_ok());
        assert!(owner.is_quiescent());
        let expected_bytes: &[u8] = if published.is_ok() {
            b"committed"
        } else {
            b"old"
        };
        assert_eq!(std::fs::read(&destination).unwrap(), expected_bytes);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn config_confirmation_rejects_a_same_identity_edit_after_preflight() {
    let root = isolated_dir("config-confirmation-edit");
    let destination = root.join("config.js");
    std::fs::write(&destination, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&destination).unwrap();
    let mut lease = owner.begin(&destination, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
    lease.activate(&staged).unwrap();

    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let receipt = lease
        .prepare_commit_cancellable(b"committed", &cancelled)
        .unwrap();
    let confirmation = lease.prepare_commit_confirmation(&receipt).unwrap();
    std::fs::write(&destination, b"foreign-after-preflight").unwrap();

    assert_eq!(
        lease.confirm_prevalidated(confirmation).unwrap_err(),
        ConfigTransactionError::IdentityChanged
    );
    assert!(!owner.is_quiescent());
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"foreign-after-preflight"
    );
    let current = FileReceipt::capture(&destination).unwrap();
    assert_eq!(
        owner.begin(&destination, &current).unwrap_err(),
        ConfigTransactionError::Busy
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn config_confirmation_rejects_same_bytes_with_a_new_identity_after_preflight() {
    let root = isolated_dir("config-confirmation-identity");
    let destination = root.join("config.js");
    std::fs::write(&destination, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&destination).unwrap();
    let mut lease = owner.begin(&destination, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
    lease.activate(&staged).unwrap();

    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let receipt = lease
        .prepare_commit_cancellable(b"committed", &cancelled)
        .unwrap();
    let confirmation = lease.prepare_commit_confirmation(&receipt).unwrap();
    let replacement = root.join("replacement.js");
    std::fs::write(&replacement, b"committed").unwrap();
    std::fs::remove_file(&destination).unwrap();
    std::fs::rename(&replacement, &destination).unwrap();

    assert_eq!(
        lease.confirm_prevalidated(confirmation).unwrap_err(),
        ConfigTransactionError::IdentityChanged
    );
    assert!(!owner.is_quiescent());
    assert_eq!(std::fs::read(&destination).unwrap(), b"committed");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn config_confirmation_defines_the_commit_instant_before_lock_free_publication() {
    let root = isolated_dir("config-confirmation-instant");
    let destination = root.join("config.js");
    std::fs::write(&destination, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&destination).unwrap();
    let mut lease = owner.begin(&destination, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
    lease.activate(&staged).unwrap();

    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let receipt = lease
        .prepare_commit_cancellable(b"committed", &cancelled)
        .unwrap();
    let confirmation = lease.prepare_commit_confirmation(&receipt).unwrap();
    let publication = lease.confirm_prevalidated(confirmation).unwrap();
    assert!(!owner.is_quiescent());

    std::fs::write(&destination, b"external-after-commit-instant").unwrap();
    let acknowledgement = publication.publish().unwrap();

    assert_eq!(acknowledgement.generation, lease.generation());
    assert!(owner.is_quiescent());
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"external-after-commit-instant"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn duplicate_confirmation_tickets_cannot_publish_the_same_transaction() {
    let root = isolated_dir("config-confirmation-duplicate");
    let destination = root.join("config.js");
    std::fs::write(&destination, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&destination).unwrap();
    let mut lease = owner.begin(&destination, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
    lease.activate(&staged).unwrap();
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let receipt = lease
        .prepare_commit_cancellable(b"committed", &cancelled)
        .unwrap();
    let first = lease.prepare_commit_confirmation(&receipt).unwrap();
    let duplicate = lease.prepare_commit_confirmation(&receipt).unwrap();

    let publication = lease.confirm_prevalidated(first).unwrap();
    assert_eq!(
        lease.confirm_prevalidated(duplicate).unwrap_err(),
        ConfigTransactionError::Stale
    );
    publication.publish().unwrap();
    assert!(owner.is_quiescent());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_confirmation_ticket_cannot_be_reused_by_a_later_transaction() {
    let root = isolated_dir("config-confirmation-reuse");
    let destination = root.join("config.js");
    std::fs::write(&destination, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&destination).unwrap();
    let mut first = owner.begin(&destination, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(first.identity(), &staged_path).unwrap();
    first.activate(&staged).unwrap();
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let receipt = first
        .prepare_commit_cancellable(b"committed", &cancelled)
        .unwrap();
    let stale = first.prepare_commit_confirmation(&receipt).unwrap();
    first.rollback().unwrap();

    let expected = FileReceipt::capture(&destination).unwrap();
    let mut second = owner.begin(&destination, &expected).unwrap();
    assert_eq!(
        second.confirm_prevalidated(stale).unwrap_err(),
        ConfigTransactionError::Stale
    );
    second.revoke().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn config_confirmation_rejects_a_reparse_parent_swap_after_preflight() {
    let root = isolated_dir("config-confirmation-reparse");
    let owned_parent = root.join("owned");
    let original_parent = root.join("original");
    let foreign_parent = root.join("foreign");
    std::fs::create_dir(&owned_parent).unwrap();
    std::fs::create_dir(&foreign_parent).unwrap();
    let destination = owned_parent.join("config.js");
    std::fs::write(&destination, b"old").unwrap();
    std::fs::write(foreign_parent.join("config.js"), b"committed").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&destination).unwrap();
    let mut lease = owner.begin(&destination, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
    lease.activate(&staged).unwrap();

    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let receipt = lease
        .prepare_commit_cancellable(b"committed", &cancelled)
        .unwrap();
    let confirmation = lease.prepare_commit_confirmation(&receipt).unwrap();
    std::fs::rename(&owned_parent, &original_parent).unwrap();
    let status = Command::new("cmd")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&owned_parent)
        .arg(&foreign_parent)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());

    assert_eq!(
        lease.confirm_prevalidated(confirmation).unwrap_err(),
        ConfigTransactionError::IdentityChanged
    );
    assert!(!owner.is_quiescent());
    assert_eq!(std::fs::read(&destination).unwrap(), b"committed");
    std::fs::remove_dir(&owned_parent).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn config_confirmation_rejects_a_symlink_parent_swap_after_preflight() {
    use std::os::unix::fs::symlink;

    let root = isolated_dir("config-confirmation-symlink");
    let owned_parent = root.join("owned");
    let original_parent = root.join("original");
    let foreign_parent = root.join("foreign");
    std::fs::create_dir(&owned_parent).unwrap();
    std::fs::create_dir(&foreign_parent).unwrap();
    let destination = owned_parent.join("config.js");
    std::fs::write(&destination, b"old").unwrap();
    std::fs::write(foreign_parent.join("config.js"), b"committed").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&destination).unwrap();
    let mut lease = owner.begin(&destination, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
    lease.activate(&staged).unwrap();

    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let receipt = lease
        .prepare_commit_cancellable(b"committed", &cancelled)
        .unwrap();
    let confirmation = lease.prepare_commit_confirmation(&receipt).unwrap();
    std::fs::rename(&owned_parent, &original_parent).unwrap();
    symlink(&foreign_parent, &owned_parent).unwrap();

    assert_eq!(
        lease.confirm_prevalidated(confirmation).unwrap_err(),
        ConfigTransactionError::IdentityChanged
    );
    assert!(!owner.is_quiescent());
    assert_eq!(std::fs::read(&destination).unwrap(), b"committed");
    std::fs::remove_file(&owned_parent).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn config_rollback_only_restores_the_receipt_it_owns() {
    let root = isolated_dir("config-rollback");
    let config = root.join("config.js");
    std::fs::write(&config, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&config).unwrap();
    let mut lease = owner.begin(&config, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
    lease.activate(&staged).unwrap();
    std::fs::write(&config, b"external-edit").unwrap();

    assert_eq!(
        lease.rollback().unwrap_err(),
        ConfigTransactionError::IdentityChanged
    );
    assert_eq!(std::fs::read(&config).unwrap(), b"external-edit");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn config_activate_and_rollback_return_an_explicit_quiescence_ack() {
    let root = isolated_dir("config-quiescence");
    let config = root.join("config.js");
    std::fs::write(&config, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&config).unwrap();
    let mut lease = owner.begin(&config, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
    lease.activate(&staged).unwrap();
    let generation = lease.generation();
    let acknowledgement = lease.rollback().unwrap();
    assert_eq!(acknowledgement.generation, generation);
    assert_eq!(std::fs::read(&config).unwrap(), b"old");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn config_rollback_removes_only_the_owned_file_created_from_an_absent_receipt() {
    let root = isolated_dir("config-absent-rollback");
    let config = root.join("config.js");
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&config).unwrap();
    let mut lease = owner.begin(&config, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();

    lease.activate(&staged).unwrap();
    assert_eq!(std::fs::read(&config).unwrap(), b"transient");
    lease.rollback().unwrap();

    assert!(!config.exists());
    assert!(owner.is_quiescent());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn dropping_an_activated_config_lease_is_nonblocking_and_fail_stops_the_owner() {
    let root = isolated_dir("config-dirty-drop");
    let config = root.join("config.js");
    std::fs::write(&config, b"old").unwrap();
    let owner = ConfigTransactionOwner::default();
    let expected = FileReceipt::capture(&config).unwrap();
    let mut lease = owner.begin(&config, &expected).unwrap();
    let staged_path = root.join("staged.js");
    std::fs::write(&staged_path, b"transient").unwrap();
    let staged = StagedArtifact::capture(lease.identity(), &staged_path).unwrap();
    lease.activate(&staged).unwrap();
    let started = std::time::Instant::now();
    drop(lease);
    assert!(started.elapsed() < Duration::from_millis(10));
    assert!(!owner.is_quiescent());
    let current = FileReceipt::capture(&config).unwrap();
    assert_eq!(
        owner.begin(&config, &current).unwrap_err(),
        ConfigTransactionError::Busy
    );
    assert_eq!(std::fs::read(&config).unwrap(), b"transient");
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn config_owner_rejects_a_redirected_parent_path_on_unix() {
    use std::os::unix::fs::symlink;
    let root = isolated_dir("config-unix-redirect");
    let real = root.join("real");
    let redirect = root.join("redirect");
    std::fs::create_dir(&real).unwrap();
    std::fs::write(real.join("config.js"), b"old").unwrap();
    symlink(&real, &redirect).unwrap();
    assert!(FileReceipt::capture(&redirect.join("config.js")).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn config_owner_rejects_a_reparse_parent_path_on_windows() {
    let root = isolated_dir("config-windows-reparse");
    let real = root.join("real");
    let redirect = root.join("redirect");
    std::fs::create_dir(&real).unwrap();
    std::fs::write(real.join("config.js"), b"old").unwrap();
    let status = Command::new("cmd")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&redirect)
        .arg(&real)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    assert!(FileReceipt::capture(&redirect.join("config.js")).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
