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
