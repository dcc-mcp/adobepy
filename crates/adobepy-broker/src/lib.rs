use adobepy_protocol::{
    session_key, BootstrapBrokerBinding, BootstrapHostBinding, BootstrapPluginBinding,
    BridgeIdentityClaim, BridgeInbound, BridgeOutbound, BridgeRuntimeIdentity, BridgeSessionInfo,
    BrokerRuntimeIdentity, HostKind, HostRuntimeIdentity, PhotoshopBootstrapContinuation,
    PhotoshopBootstrapRequest, PhotoshopBootstrapResult, PhotoshopBootstrapStatus,
    PhotoshopBootstrapVerifyRequest, RequestId, RpcErrorResponse, RpcRequest, RpcResponse,
    RuntimeIdentityAttestation, RuntimeIdentityQuery, DEFAULT_TARGET, ERROR_BRIDGE_NOT_INSTALLED,
    ERROR_CAPABILITY, ERROR_IDENTITY_AMBIGUOUS, ERROR_IDENTITY_MISMATCH, ERROR_IDENTITY_STALE,
    ERROR_IDENTITY_UNAVAILABLE, ERROR_INVALID_REQUEST, ERROR_PARSE, ERROR_SERIALIZATION,
    ERROR_TIMEOUT, ERROR_UNAUTHORIZED, JSONRPC_VERSION, PHOTOSHOP_BOOTSTRAP_VERSION,
    RUNTIME_IDENTITY_VERSION,
};
use anyhow::{anyhow, Context};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, watch, Mutex, RwLock};
use uuid::Uuid;

#[doc(hidden)]
pub mod bootstrap_transaction;
mod photoshop_bootstrap;

use photoshop_bootstrap::{
    ObservedHostProcess, PhotoshopBootstrapBackend, PreparedBootstrap,
    SystemPhotoshopBootstrapBackend,
};

type DispatchResult = Result<RpcResponse, Box<RpcErrorResponse>>;
type ValidationResult = Result<(), Box<RpcErrorResponse>>;
type BootstrapResult = Result<PhotoshopBootstrapResult, Box<RpcErrorResponse>>;

#[doc(hidden)]
pub fn run_bootstrap_helper_stdio() -> anyhow::Result<()> {
    bootstrap_transaction::run_helper_stdio()
}

struct PendingRequest {
    original_id: RequestId,
    session_key: String,
    connection_id: u64,
    sender: oneshot::Sender<DispatchResult>,
}

#[derive(Clone)]
struct BridgeSender {
    connection_id: u64,
    sender: mpsc::UnboundedSender<BridgeOutbound>,
}

struct BootstrapGrant {
    request: PhotoshopBootstrapRequest,
    nonce: String,
    nonce_claimed: bool,
    observed: Option<ObservedHostProcess>,
    module_sha256: String,
    prepared: Option<PreparedBootstrap>,
    completion: watch::Sender<Option<BootstrapResult>>,
}

struct PreparedCleanupGuard {
    backend: Arc<dyn PhotoshopBootstrapBackend>,
    prepared: Option<PreparedBootstrap>,
}

impl PreparedCleanupGuard {
    fn new(backend: Arc<dyn PhotoshopBootstrapBackend>, prepared: PreparedBootstrap) -> Self {
        Self {
            backend,
            prepared: Some(prepared),
        }
    }

    fn take(&mut self) -> PreparedBootstrap {
        self.prepared.take().expect("prepared bootstrap is present")
    }
}

impl Drop for PreparedCleanupGuard {
    fn drop(&mut self) {
        if let Some(prepared) = self.prepared.take() {
            let _ = self.backend.rollback(prepared);
        }
    }
}

struct BootstrapTransactionGuard {
    key: String,
    grants: Arc<Mutex<HashMap<String, BootstrapGrant>>>,
    backend: Arc<dyn PhotoshopBootstrapBackend>,
    armed: bool,
}

impl BootstrapTransactionGuard {
    fn new(
        key: String,
        grants: Arc<Mutex<HashMap<String, BootstrapGrant>>>,
        backend: Arc<dyn PhotoshopBootstrapBackend>,
    ) -> Self {
        Self {
            key,
            grants,
            backend,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for BootstrapTransactionGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.armed = false;
        let key = self.key.clone();
        let grants = self.grants.clone();
        let backend = self.backend.clone();
        if let Ok(mut locked) = grants.try_lock() {
            cancel_bootstrap_grant(&mut locked, &key, backend.as_ref());
            return;
        }
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let mut locked = grants.lock().await;
                cancel_bootstrap_grant(&mut locked, &key, backend.as_ref());
            });
        }
    }
}

fn cancel_bootstrap_grant(
    grants: &mut HashMap<String, BootstrapGrant>,
    key: &str,
    backend: &dyn PhotoshopBootstrapBackend,
) {
    let Some(grant) = grants.get_mut(key) else {
        return;
    };
    let rollback_failed = grant
        .prepared
        .take()
        .is_some_and(|prepared| backend.rollback(prepared).is_err());
    let error = if rollback_failed {
        bootstrap_recovery_error("cancelled Photoshop bootstrap state could not be recovered")
    } else {
        identity_error(
            ERROR_IDENTITY_STALE,
            "Photoshop bootstrap transaction was cancelled",
            json!({"stage": "cancellation"}),
        )
    };
    grant.completion.send_replace(Some(Err(error)));
    grants.remove(key);
}

#[derive(Clone)]
struct BootstrapReceipt {
    identity: RuntimeIdentityAttestation,
    result: PhotoshopBootstrapResult,
    expires_at_epoch_ms: u128,
}

#[derive(Debug, Clone)]
pub struct BrokerConfig {
    pub bind: SocketAddr,
    pub token: String,
    pub default_timeout_ms: u64,
}

impl Default for BrokerConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], 47_391)),
            token: "dev-token".to_owned(),
            default_timeout_ms: 30_000,
        }
    }
}

#[derive(Clone)]
struct BrokerState {
    token: String,
    default_timeout_ms: u64,
    sessions: Arc<RwLock<HashMap<String, BridgeSessionInfo>>>,
    session_identities: Arc<RwLock<HashMap<String, BridgeIdentityClaim>>>,
    bridge_senders: Arc<RwLock<HashMap<String, BridgeSender>>>,
    pending: Arc<Mutex<HashMap<RequestId, PendingRequest>>>,
    next_dispatch_id: Arc<AtomicU64>,
    next_connection_id: Arc<AtomicU64>,
    broker_identity: Arc<BrokerRuntimeIdentity>,
    bootstrap_backend: Arc<dyn PhotoshopBootstrapBackend>,
    bootstrap_grants: Arc<Mutex<HashMap<String, BootstrapGrant>>>,
    bootstrap_receipts: Arc<Mutex<HashMap<String, BootstrapReceipt>>>,
    photoshop_websocket_url: String,
}

impl BrokerState {
    fn new(config: &BrokerConfig) -> anyhow::Result<Self> {
        Self::with_bootstrap_backend(config, Arc::new(SystemPhotoshopBootstrapBackend))
    }

    fn with_bootstrap_backend(
        config: &BrokerConfig,
        bootstrap_backend: Arc<dyn PhotoshopBootstrapBackend>,
    ) -> anyhow::Result<Self> {
        let host = match config.bind.ip() {
            std::net::IpAddr::V4(address) if address.is_loopback() => address.to_string(),
            std::net::IpAddr::V6(address) if address.is_loopback() => format!("[{address}]"),
            _ => {
                return Err(anyhow!(
                    "the adobepy broker must bind to a loopback address"
                ))
            }
        };
        Ok(Self {
            token: config.token.clone(),
            default_timeout_ms: config.default_timeout_ms,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            session_identities: Arc::new(RwLock::new(HashMap::new())),
            bridge_senders: Arc::new(RwLock::new(HashMap::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_dispatch_id: Arc::new(AtomicU64::new(1)),
            next_connection_id: Arc::new(AtomicU64::new(1)),
            broker_identity: Arc::new(capture_broker_identity()?),
            bootstrap_backend,
            bootstrap_grants: Arc::new(Mutex::new(HashMap::new())),
            bootstrap_receipts: Arc::new(Mutex::new(HashMap::new())),
            photoshop_websocket_url: format!(
                "ws://{host}:{}/v1/bridge/photoshop/ws",
                config.bind.port()
            ),
        })
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        self.token.is_empty()
            || headers
                .get("x-adobepy-token")
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value == self.token)
    }

    async fn dispatch_request(&self, request: RpcRequest) -> DispatchResult {
        validate_request(&request)?;
        let target = request.target_or_default().to_owned();
        let key = session_key(request.host, &target);
        let (sender, session) = {
            let senders = self.bridge_senders.read().await;
            let sessions = self.sessions.read().await;
            (senders.get(&key).cloned(), sessions.get(&key).cloned())
        };
        let Some(sender) = sender else {
            return Err(Box::new(RpcErrorResponse::new(
                Some(request.id.clone()),
                ERROR_BRIDGE_NOT_INSTALLED,
                format!(
                    "no bridge session is connected for host '{}' target '{}'",
                    request.host, target
                ),
            )));
        };
        let Some(session) = session else {
            return Err(Box::new(RpcErrorResponse::new(
                Some(request.id.clone()),
                ERROR_BRIDGE_NOT_INSTALLED,
                "bridge session metadata is unavailable",
            )));
        };
        validate_capability_contract(&request, &target, &session)?;
        let timeout_ms = request
            .options
            .timeout_ms
            .unwrap_or(self.default_timeout_ms);
        let original_id = request.id.clone();
        let dispatch_id = RequestId::from_string(format!(
            "broker_{}",
            self.next_dispatch_id.fetch_add(1, Ordering::Relaxed)
        ));
        let mut bridge_request = request;
        bridge_request.id = dispatch_id.clone();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(
            dispatch_id.clone(),
            PendingRequest {
                original_id: original_id.clone(),
                session_key: key.clone(),
                connection_id: sender.connection_id,
                sender: tx,
            },
        );
        if sender
            .sender
            .send(BridgeOutbound::Request {
                request: bridge_request,
            })
            .is_err()
        {
            self.pending.lock().await.remove(&dispatch_id);
            return Err(Box::new(RpcErrorResponse::new(
                Some(original_id),
                ERROR_BRIDGE_NOT_INSTALLED,
                "bridge disconnected before request could be sent",
            )));
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Box::new(RpcErrorResponse::new(
                Some(original_id),
                ERROR_BRIDGE_NOT_INSTALLED,
                "bridge response channel closed",
            ))),
            Err(_) => {
                self.pending.lock().await.remove(&dispatch_id);
                Err(Box::new(RpcErrorResponse::new(
                    Some(original_id),
                    ERROR_TIMEOUT,
                    format!("request timed out after {timeout_ms}ms"),
                )))
            }
        }
    }

    async fn runtime_identity(
        &self,
        query: RuntimeIdentityQuery,
    ) -> Result<RuntimeIdentityAttestation, Box<RpcErrorResponse>> {
        if query
            .target
            .as_deref()
            .is_some_and(|target| !is_bounded_identifier(target, 128))
        {
            return Err(identity_error(
                ERROR_INVALID_REQUEST,
                "runtime identity target is invalid",
                json!({"field": "target"}),
            ));
        }
        if let Some(expected) = query.expected.as_ref() {
            validate_runtime_identity_shape(expected)?;
        }
        let candidates = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| {
                session.capabilities.host == query.host
                    && query
                        .target
                        .as_ref()
                        .is_none_or(|target| target == &session.target)
            })
            .map(|(key, session)| (key.clone(), session.clone()))
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Err(identity_error(
                ERROR_IDENTITY_UNAVAILABLE,
                "runtime identity is unavailable for the selected host target",
                json!({"host": query.host.as_str(), "missingFields": ["bridge.session"]}),
            ));
        }
        if candidates.len() != 1 {
            return Err(identity_error(
                ERROR_IDENTITY_AMBIGUOUS,
                "multiple runtime identities match; select an exact target",
                json!({"host": query.host.as_str(), "matchCount": candidates.len()}),
            ));
        }
        let (key, session) = candidates.into_iter().next().expect("one candidate");
        let claim = self.session_identities.read().await.get(&key).cloned();
        let actual = complete_runtime_identity(
            self.broker_identity.as_ref().clone(),
            &session,
            claim.as_ref(),
        )?;
        if let Some(expected) = query.expected.as_ref() {
            validate_expected_identity(&actual, expected)?;
        }
        Ok(actual)
    }

    async fn bootstrap_photoshop(&self, request: PhotoshopBootstrapRequest) -> BootstrapResult {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(request.timeout_ms);
        validate_photoshop_bootstrap_request(&request)?;
        let attestation = self.bootstrap_backend.attest(&request);
        if tokio::time::Instant::now() >= deadline {
            return Err(bootstrap_timeout_error(&request, "attestation"));
        }
        let module_sha256 = attestation.map_err(|_| {
            identity_error(
                ERROR_IDENTITY_UNAVAILABLE,
                "the authenticated Photoshop product or fixed UXP bridge is unavailable",
                json!({"stage": "attestation"}),
            )
        })?;
        let key = session_key(HostKind::Photoshop, &request.target);
        let initial_waiter = {
            let grants = self.bootstrap_grants.lock().await;
            grants.get(&key).map(|grant| {
                if grant.request == request {
                    Ok(grant.completion.subscribe())
                } else {
                    Err(identity_error(
                        ERROR_IDENTITY_AMBIGUOUS,
                        "a different Photoshop bootstrap is already active for this target",
                        json!({"target": request.target}),
                    ))
                }
            })
        };
        if tokio::time::Instant::now() >= deadline {
            return Err(bootstrap_timeout_error(&request, "reservation"));
        }
        if let Some(waiter) = initial_waiter {
            return self
                .wait_for_bootstrap_completion(&request, deadline, waiter?)
                .await;
        }

        let has_session = self.sessions.read().await.contains_key(&key);
        if tokio::time::Instant::now() >= deadline {
            return Err(bootstrap_timeout_error(&request, "session"));
        }
        if has_session {
            let in_flight_waiter = {
                let grants = self.bootstrap_grants.lock().await;
                grants.get(&key).map(|grant| {
                    if grant.request == request {
                        Ok(grant.completion.subscribe())
                    } else {
                        Err(identity_error(
                            ERROR_IDENTITY_AMBIGUOUS,
                            "a different Photoshop bootstrap is already active for this target",
                            json!({"target": request.target}),
                        ))
                    }
                })
            };
            if tokio::time::Instant::now() >= deadline {
                return Err(bootstrap_timeout_error(&request, "reservation"));
            }
            if let Some(waiter) = in_flight_waiter {
                return self
                    .wait_for_bootstrap_completion(&request, deadline, waiter?)
                    .await;
            }
            let identity = self
                .runtime_identity(RuntimeIdentityQuery {
                    host: HostKind::Photoshop,
                    target: Some(request.target.clone()),
                    expected: None,
                })
                .await;
            if tokio::time::Instant::now() >= deadline {
                return Err(bootstrap_timeout_error(&request, "identity"));
            }
            let identity = identity?;
            let validation = self.validate_bootstrap_identity(&request, &identity, None);
            if tokio::time::Instant::now() >= deadline {
                return Err(bootstrap_timeout_error(&request, "identity_validation"));
            }
            validation?;
            return self
                .record_bootstrap_result(
                    identity,
                    &request,
                    &module_sha256,
                    PhotoshopBootstrapStatus::AlreadyReady,
                    deadline,
                    None,
                )
                .await;
        }

        let nonce = random_nonce();
        let follower = {
            let mut grants = self.bootstrap_grants.lock().await;
            if tokio::time::Instant::now() >= deadline {
                return Err(bootstrap_timeout_error(&request, "reservation"));
            }
            match grants.get(&key) {
                Some(grant) if grant.request != request => {
                    return Err(identity_error(
                        ERROR_IDENTITY_AMBIGUOUS,
                        "a different Photoshop bootstrap is already active for this target",
                        json!({"target": request.target}),
                    ));
                }
                Some(grant) => Some(grant.completion.subscribe()),
                None => {
                    let (completion, _) = watch::channel::<Option<BootstrapResult>>(None);
                    grants.insert(
                        key.clone(),
                        BootstrapGrant {
                            request: request.clone(),
                            nonce: nonce.clone(),
                            nonce_claimed: false,
                            observed: None,
                            module_sha256: module_sha256.clone(),
                            prepared: None,
                            completion,
                        },
                    );
                    None
                }
            }
        };
        if let Some(waiter) = follower {
            return self
                .wait_for_bootstrap_completion(&request, deadline, waiter)
                .await;
        }
        let mut transaction_guard = BootstrapTransactionGuard::new(
            key.clone(),
            self.bootstrap_grants.clone(),
            self.bootstrap_backend.clone(),
        );

        let owner_result: BootstrapResult = async {
            let prepared = self.bootstrap_backend.prepare(
                &request,
                &nonce,
                &self.token,
                &self.photoshop_websocket_url,
            );
            if tokio::time::Instant::now() >= deadline {
                if let Ok(prepared) = prepared {
                    let mut grants = self.bootstrap_grants.lock().await;
                    if let Some(grant) = grants.get_mut(&key) {
                        grant.prepared = Some(prepared);
                    } else {
                        let _ = self.bootstrap_backend.rollback(prepared);
                    }
                }
                return Err(bootstrap_timeout_error(&request, "prepare"));
            }
            let prepared = prepared.map_err(|_| {
                identity_error(
                    ERROR_IDENTITY_UNAVAILABLE,
                    "the fixed Photoshop UXP bridge could not be prepared",
                    json!({"stage": "prepare"}),
                )
            })?;
            let mut prepared_guard =
                PreparedCleanupGuard::new(self.bootstrap_backend.clone(), prepared);
            {
                let mut grants = self.bootstrap_grants.lock().await;
                let Some(grant) = grants.get_mut(&key) else {
                    return Err(identity_error(
                        ERROR_IDENTITY_STALE,
                        "Photoshop bootstrap reservation was cancelled",
                        json!({"stage": "prepare"}),
                    ));
                };
                let prepared = prepared_guard.take();
                grant.module_sha256 = prepared.module_sha256.clone();
                grant.prepared = Some(prepared);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(bootstrap_timeout_error(&request, "prepare"));
            }
            let observed = self.bootstrap_backend.launch(&request.host);
            if tokio::time::Instant::now() >= deadline {
                return Err(bootstrap_timeout_error(&request, "launch"));
            }
            let observed = observed.map_err(|_| {
                identity_error(
                    ERROR_IDENTITY_UNAVAILABLE,
                    "the selected Photoshop instance could not be launched",
                    json!({"stage": "launch"}),
                )
            })?;
            {
                let mut grants = self.bootstrap_grants.lock().await;
                let Some(grant) = grants.get_mut(&key) else {
                    return Err(identity_error(
                        ERROR_IDENTITY_STALE,
                        "Photoshop bootstrap reservation was cancelled",
                        json!({"stage": "launch"}),
                    ));
                };
                grant.observed = Some(observed);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(bootstrap_timeout_error(&request, "launch"));
            }

            loop {
                if tokio::time::Instant::now() >= deadline {
                    return Err(bootstrap_timeout_error(&request, "verify"));
                }
                let identity = self
                    .runtime_identity(RuntimeIdentityQuery {
                        host: HostKind::Photoshop,
                        target: Some(request.target.clone()),
                        expected: None,
                    })
                    .await;
                if tokio::time::Instant::now() >= deadline {
                    return Err(bootstrap_timeout_error(&request, "verify"));
                }
                match identity {
                    Ok(identity) => {
                        let observed = self
                            .bootstrap_grants
                            .lock()
                            .await
                            .get(&key)
                            .and_then(|grant| grant.observed.clone());
                        let validation = self.validate_bootstrap_identity(
                            &request,
                            &identity,
                            observed.as_ref(),
                        );
                        if tokio::time::Instant::now() >= deadline {
                            return Err(bootstrap_timeout_error(&request, "identity_validation"));
                        }
                        validation?;
                        let finalize = {
                            let grants = self.bootstrap_grants.lock().await;
                            let Some(prepared) =
                                grants.get(&key).and_then(|grant| grant.prepared.as_ref())
                            else {
                                return Err(identity_error(
                                    ERROR_IDENTITY_STALE,
                                    "Photoshop bootstrap reservation is unavailable",
                                    json!({"stage": "commit"}),
                                ));
                            };
                            self.bootstrap_backend.finalize(prepared)
                        };
                        if tokio::time::Instant::now() >= deadline {
                            return Err(bootstrap_timeout_error(&request, "commit"));
                        }
                        finalize.map_err(|_| {
                            identity_error(
                                ERROR_IDENTITY_UNAVAILABLE,
                                "Photoshop bootstrap could not be committed",
                                json!({"stage": "commit"}),
                            )
                        })?;
                        let grant_module_sha256 = self
                            .bootstrap_grants
                            .lock()
                            .await
                            .get(&key)
                            .map(|grant| grant.module_sha256.clone())
                            .ok_or_else(|| {
                                identity_error(
                                    ERROR_IDENTITY_STALE,
                                    "Photoshop bootstrap reservation is unavailable",
                                    json!({"stage": "commit"}),
                                )
                            })?;
                        return self
                            .record_bootstrap_result(
                                identity,
                                &request,
                                &grant_module_sha256,
                                PhotoshopBootstrapStatus::Ready,
                                deadline,
                                Some(&key),
                            )
                            .await;
                    }
                    Err(error)
                        if matches!(
                            error.error.code,
                            ERROR_IDENTITY_UNAVAILABLE | ERROR_BRIDGE_NOT_INSTALLED
                        ) => {}
                    Err(error) => return Err(error),
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        .await;

        let final_result = match owner_result {
            Ok(result) => Ok(result),
            Err(error) => self.complete_bootstrap_failure(&key, error).await,
        };
        transaction_guard.disarm();
        final_result
    }

    async fn wait_for_bootstrap_completion(
        &self,
        request: &PhotoshopBootstrapRequest,
        deadline: tokio::time::Instant,
        mut completion: watch::Receiver<Option<BootstrapResult>>,
    ) -> BootstrapResult {
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(bootstrap_timeout_error(request, "transaction"));
            }
            if let Some(outcome) = completion.borrow().clone() {
                return outcome;
            }
            match tokio::time::timeout_at(deadline, completion.changed()).await {
                Err(_) => return Err(bootstrap_timeout_error(request, "transaction")),
                Ok(Ok(())) => {}
                Ok(Err(_)) => {
                    if let Some(outcome) = completion.borrow().clone() {
                        return outcome;
                    }
                    return Err(identity_error(
                        ERROR_IDENTITY_STALE,
                        "Photoshop bootstrap transaction ended without a durable outcome",
                        json!({"stage": "transaction"}),
                    ));
                }
            }
        }
    }

    async fn complete_bootstrap_failure(
        &self,
        key: &str,
        primary_error: Box<RpcErrorResponse>,
    ) -> BootstrapResult {
        let mut grants = self.bootstrap_grants.lock().await;
        let Some(grant) = grants.get_mut(key) else {
            return Err(primary_error);
        };
        let rollback_failed = grant
            .prepared
            .take()
            .is_some_and(|prepared| self.bootstrap_backend.rollback(prepared).is_err());
        let error = if rollback_failed {
            bootstrap_recovery_error("Photoshop bootstrap state could not be recovered")
        } else {
            primary_error
        };
        grant.completion.send_replace(Some(Err(error.clone())));
        grants.remove(key);
        Err(error)
    }

    fn validate_bootstrap_identity(
        &self,
        request: &PhotoshopBootstrapRequest,
        identity: &RuntimeIdentityAttestation,
        observed: Option<&ObservedHostProcess>,
    ) -> Result<(), Box<RpcErrorResponse>> {
        let path_matches = normalized_paths_equal(
            &identity.host.executable_path,
            &request.host.executable_path,
        ) && normalized_paths_equal(
            &identity.bridge.installed_plugin_root,
            &request.plugin.installed_plugin_root,
        ) && normalized_paths_equal(
            &identity.bridge.module_origin,
            &request.plugin.module_origin,
        );
        let claimed_process = ObservedHostProcess {
            pid: identity.host.pid,
            process_start_identity: identity.host.process_start_identity.clone(),
            executable_path: identity.host.executable_path.clone(),
        };
        let observed_matches = self.bootstrap_backend.process_matches(&claimed_process)
            && observed.is_none_or(|expected| {
                self.bootstrap_backend.process_matches(expected)
                    && identity.host.pid == expected.pid
                    && identity.host.process_start_identity == expected.process_start_identity
                    && normalized_paths_equal(
                        &identity.host.executable_path,
                        &expected.executable_path,
                    )
            });
        if !path_matches
            || !observed_matches
            || identity.host.host_version != request.host.host_version
            || identity.host.profile_id != request.host.profile_id
            || identity.bridge.target != request.target
            || identity.bridge.bridge_kind != adobepy_protocol::BridgeKind::Uxp
            || identity.bridge.bridge_version != request.plugin.bridge_version
        {
            return Err(identity_error(
                ERROR_IDENTITY_MISMATCH,
                "Photoshop bootstrap resolved to a foreign or mismatched instance",
                json!({"field": "runtimeIdentity"}),
            ));
        }
        Ok(())
    }

    async fn record_bootstrap_result(
        &self,
        identity: RuntimeIdentityAttestation,
        request: &PhotoshopBootstrapRequest,
        module_sha256: &str,
        status: PhotoshopBootstrapStatus,
        deadline: tokio::time::Instant,
        owner_key: Option<&str>,
    ) -> BootstrapResult {
        let broker_attestation = self
            .bootstrap_backend
            .executable_sha256(&identity.broker.executable_path);
        if tokio::time::Instant::now() >= deadline {
            return Err(bootstrap_timeout_error(request, "broker_attestation"));
        }
        let broker_sha256 = broker_attestation.map_err(|_| {
            identity_error(
                ERROR_IDENTITY_UNAVAILABLE,
                "broker executable identity is unavailable",
                json!({"stage": "broker_attestation"}),
            )
        })?;
        let fingerprint = identity_fingerprint(&identity);
        if tokio::time::Instant::now() >= deadline {
            return Err(bootstrap_timeout_error(request, "fingerprint"));
        }
        let fingerprint = fingerprint?;
        let receipt_id = Uuid::new_v4().hyphenated().to_string();
        let result = PhotoshopBootstrapResult {
            bootstrap_version: PHOTOSHOP_BOOTSTRAP_VERSION,
            status,
            identity_fingerprint: fingerprint,
            broker: BootstrapBrokerBinding {
                pid: identity.broker.pid,
                process_start_identity: identity.broker.process_start_identity.clone(),
                runtime_version: identity.broker.runtime_version.clone(),
                instance_id: identity.broker.instance_id.clone(),
                executable_sha256: broker_sha256,
            },
            host: BootstrapHostBinding {
                pid: identity.host.pid,
                process_start_identity: identity.host.process_start_identity.clone(),
                host_version: identity.host.host_version.clone(),
                profile_id: identity.host.profile_id.clone(),
                executable_sha256: request.host.executable_sha256.clone(),
            },
            plugin: BootstrapPluginBinding {
                instance_id: identity.bridge.instance_id.clone(),
                bridge_version: identity.bridge.bridge_version.clone(),
                module_sha256: module_sha256.to_owned(),
            },
            continuation: PhotoshopBootstrapContinuation {
                method: "POST".into(),
                path: "/v1/photoshop/bootstrap/verify".into(),
                receipt_id: receipt_id.clone(),
                timeout_ms: request.timeout_ms,
            },
        };
        let receipt = BootstrapReceipt {
            identity,
            result: result.clone(),
            expires_at_epoch_ms: epoch_ms() + 120_000,
        };
        if let Some(key) = owner_key {
            let mut grants = self.bootstrap_grants.lock().await;
            if tokio::time::Instant::now() >= deadline {
                return Err(bootstrap_timeout_error(request, "receipt"));
            }
            if grants
                .get(key)
                .and_then(|grant| grant.prepared.as_ref())
                .is_none()
            {
                return Err(identity_error(
                    ERROR_IDENTITY_STALE,
                    "Photoshop bootstrap reservation is unavailable",
                    json!({"stage": "receipt"}),
                ));
            }
            let mut receipts = self.bootstrap_receipts.lock().await;
            if tokio::time::Instant::now() >= deadline {
                return Err(bootstrap_timeout_error(request, "receipt"));
            }
            let now = epoch_ms();
            receipts.retain(|_, receipt| receipt.expires_at_epoch_ms >= now);
            receipts.insert(receipt_id, receipt);
            let grant = grants
                .get_mut(key)
                .expect("owner grant remains locked through receipt persistence");
            let prepared = grant
                .prepared
                .take()
                .expect("owner prepared state remains locked through receipt persistence");
            drop(prepared);
            grant.completion.send_replace(Some(Ok(result.clone())));
            grants.remove(key);
        } else {
            let mut receipts = self.bootstrap_receipts.lock().await;
            if tokio::time::Instant::now() >= deadline {
                return Err(bootstrap_timeout_error(request, "receipt"));
            }
            let now = epoch_ms();
            receipts.retain(|_, receipt| receipt.expires_at_epoch_ms >= now);
            receipts.insert(receipt_id, receipt);
        }
        Ok(result)
    }

    async fn verify_photoshop_bootstrap(
        &self,
        receipt_id: &str,
    ) -> Result<PhotoshopBootstrapResult, Box<RpcErrorResponse>> {
        if !is_uuid(receipt_id) {
            return Err(identity_error(
                ERROR_INVALID_REQUEST,
                "Photoshop bootstrap receipt is invalid",
                json!({"field": "receiptId"}),
            ));
        }
        let receipt = self
            .bootstrap_receipts
            .lock()
            .await
            .get(receipt_id)
            .cloned()
            .filter(|receipt| receipt.expires_at_epoch_ms >= epoch_ms())
            .ok_or_else(|| {
                identity_error(
                    ERROR_IDENTITY_STALE,
                    "Photoshop bootstrap receipt is stale or unavailable",
                    json!({"field": "receiptId"}),
                )
            })?;
        let actual = self
            .runtime_identity(RuntimeIdentityQuery {
                host: HostKind::Photoshop,
                target: Some(receipt.identity.bridge.target.clone()),
                expected: Some(receipt.identity.clone()),
            })
            .await?;
        let observed = ObservedHostProcess {
            pid: actual.host.pid,
            process_start_identity: actual.host.process_start_identity.clone(),
            executable_path: actual.host.executable_path.clone(),
        };
        if !self.bootstrap_backend.process_matches(&observed) {
            return Err(identity_error(
                ERROR_IDENTITY_STALE,
                "Photoshop process identity changed after bootstrap",
                json!({"field": "host.processStartIdentity"}),
            ));
        }
        Ok(receipt.result)
    }

    async fn bind_photoshop_bootstrap_claim(
        &self,
        target: &str,
        capabilities: &adobepy_protocol::Capabilities,
        identity: Option<BridgeIdentityClaim>,
        bootstrap_nonce: Option<&str>,
    ) -> Result<Option<BridgeIdentityClaim>, Box<RpcErrorResponse>> {
        if capabilities.host != HostKind::Photoshop {
            if bootstrap_nonce.is_some() {
                return Err(identity_error(
                    ERROR_IDENTITY_MISMATCH,
                    "Photoshop bootstrap nonce was presented by a foreign host",
                    json!({"field": "host"}),
                ));
            }
            return Ok(identity);
        }
        let key = session_key(HostKind::Photoshop, target);
        let has_grant = self.bootstrap_grants.lock().await.contains_key(&key);
        if !has_grant {
            if bootstrap_nonce.is_some() {
                return Err(identity_error(
                    ERROR_IDENTITY_STALE,
                    "Photoshop bootstrap nonce is stale",
                    json!({"field": "bootstrapNonce"}),
                ));
            }
            return Ok(identity);
        }
        let Some(nonce) = bootstrap_nonce else {
            return Err(identity_error(
                ERROR_IDENTITY_MISMATCH,
                "Photoshop bootstrap connection omitted its one-time binding",
                json!({"field": "bootstrapNonce"}),
            ));
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let (request, observed) = loop {
            let value = self
                .bootstrap_grants
                .lock()
                .await
                .get(&key)
                .and_then(|grant| {
                    (grant.nonce == nonce)
                        .then(|| {
                            grant
                                .observed
                                .clone()
                                .map(|observed| (grant.request.clone(), observed))
                        })
                        .flatten()
                });
            if let Some(value) = value {
                break value;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(identity_error(
                    ERROR_IDENTITY_STALE,
                    "Photoshop bootstrap binding is stale or incomplete",
                    json!({"field": "bootstrapNonce"}),
                ));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        if !self.bootstrap_backend.process_matches(&observed) {
            return Err(identity_error(
                ERROR_IDENTITY_STALE,
                "selected Photoshop process identity changed before bridge connection",
                json!({"field": "host.processStartIdentity"}),
            ));
        }
        let Some(mut identity) = identity else {
            return Err(identity_error(
                ERROR_IDENTITY_UNAVAILABLE,
                "Photoshop UXP bridge omitted its plugin identity",
                json!({"missingFields": ["identity.bridge"]}),
            ));
        };
        let Some(profile_id) = identity.host.profile_id.as_ref() else {
            return Err(identity_error(
                ERROR_IDENTITY_UNAVAILABLE,
                "Photoshop bootstrap connection omitted its host profile identity",
                json!({"missingFields": ["identity.host.profileId"]}),
            ));
        };
        let claimed_host_matches = identity.host.pid.is_none_or(|pid| pid == observed.pid)
            && identity
                .host
                .process_start_identity
                .as_ref()
                .is_none_or(|value| value == &observed.process_start_identity)
            && identity
                .host
                .executable_path
                .as_deref()
                .is_none_or(|value| normalized_paths_equal(value, &observed.executable_path))
            && profile_id == &request.host.profile_id;
        let bridge_matches = identity
            .bridge
            .installed_plugin_root
            .as_deref()
            .is_some_and(|value| {
                normalized_paths_equal(value, &request.plugin.installed_plugin_root)
            })
            && identity
                .bridge
                .module_origin
                .as_deref()
                .is_some_and(|value| normalized_paths_equal(value, &request.plugin.module_origin))
            && capabilities.bridge_kind == adobepy_protocol::BridgeKind::Uxp
            && capabilities.bridge_version == request.plugin.bridge_version
            && capabilities.host_version.as_deref() == Some(request.host.host_version.as_str());
        if !claimed_host_matches || !bridge_matches {
            return Err(identity_error(
                ERROR_IDENTITY_MISMATCH,
                "Photoshop bootstrap connection is foreign or mismatched",
                json!({"field": "runtimeIdentity"}),
            ));
        }
        let nonce_consumed = {
            let mut grants = self.bootstrap_grants.lock().await;
            grants.get_mut(&key).is_some_and(|grant| {
                if grant.nonce != nonce || grant.nonce_claimed {
                    return false;
                }
                grant.nonce_claimed = true;
                true
            })
        };
        if !nonce_consumed {
            return Err(identity_error(
                ERROR_IDENTITY_STALE,
                "Photoshop bootstrap nonce was already consumed",
                json!({"field": "bootstrapNonce"}),
            ));
        }
        identity.host.pid = Some(observed.pid);
        identity.host.process_start_identity = Some(observed.process_start_identity);
        identity.host.executable_path = Some(observed.executable_path);
        identity.host.host_version = Some(request.host.host_version);
        Ok(Some(identity))
    }

    fn next_connection_id(&self) -> u64 {
        self.next_connection_id.fetch_add(1, Ordering::Relaxed)
    }

    async fn disconnect_session(&self, key: &str, connection_id: u64, message: impl Into<String>) {
        let message = message.into();
        let removed_current = {
            let mut senders = self.bridge_senders.write().await;
            if senders
                .get(key)
                .is_some_and(|current| current.connection_id == connection_id)
            {
                senders.remove(key);
                true
            } else {
                false
            }
        };
        if removed_current {
            self.sessions.write().await.remove(key);
            self.session_identities.write().await.remove(key);
        }
        let drained = {
            let mut pending = self.pending.lock().await;
            let ids: Vec<_> = pending
                .iter()
                .filter(|(_, request)| {
                    request.session_key == key && request.connection_id == connection_id
                })
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id))
                .collect::<Vec<_>>()
        };
        for request in drained {
            let _ = request.sender.send(Err(Box::new(RpcErrorResponse::new(
                Some(request.original_id),
                ERROR_BRIDGE_NOT_INSTALLED,
                message.clone(),
            ))));
        }
    }
}

pub async fn run_broker(config: BrokerConfig) -> anyhow::Result<()> {
    let app = broker_router(BrokerState::new(&config)?);
    let listener = TcpListener::bind(config.bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn broker_router(state: BrokerState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/capabilities", get(list_capabilities))
        .route("/v1/runtime-identity", post(runtime_identity))
        .route("/v1/photoshop/bootstrap", post(photoshop_bootstrap))
        .route(
            "/v1/photoshop/bootstrap/verify",
            post(verify_photoshop_bootstrap),
        )
        .route("/v1/rpc", post(http_rpc))
        .route("/v1/client/ws", get(client_ws))
        .route("/v1/bridge/{host}/ws", get(bridge_ws))
        .with_state(state)
}

async fn health(State(state): State<BrokerState>) -> impl IntoResponse {
    Json(
        json!({"status": "ok", "sessions": state.sessions.read().await.len(), "protocol": "jsonrpc-2.0"}),
    )
}

async fn list_capabilities(State(state): State<BrokerState>, headers: HeaderMap) -> Response {
    if !state.authorized(&headers) {
        return unauthorized_response();
    }
    Json(
        state
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>(),
    )
    .into_response()
}

async fn runtime_identity(
    State(state): State<BrokerState>,
    headers: HeaderMap,
    Json(query): Json<RuntimeIdentityQuery>,
) -> Response {
    if !state.authorized(&headers) {
        return unauthorized_response();
    }
    match state.runtime_identity(query).await {
        Ok(identity) => Json(identity).into_response(),
        Err(error) => Json(*error).into_response(),
    }
}

async fn photoshop_bootstrap(
    State(state): State<BrokerState>,
    headers: HeaderMap,
    Json(request): Json<PhotoshopBootstrapRequest>,
) -> Response {
    if !state.authorized(&headers) {
        return unauthorized_response();
    }
    match state.bootstrap_photoshop(request).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => Json(*error).into_response(),
    }
}

async fn verify_photoshop_bootstrap(
    State(state): State<BrokerState>,
    headers: HeaderMap,
    Json(request): Json<PhotoshopBootstrapVerifyRequest>,
) -> Response {
    if !state.authorized(&headers) {
        return unauthorized_response();
    }
    match state.verify_photoshop_bootstrap(&request.receipt_id).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => Json(*error).into_response(),
    }
}

async fn http_rpc(
    State(state): State<BrokerState>,
    headers: HeaderMap,
    Json(request): Json<RpcRequest>,
) -> Response {
    if !state.authorized(&headers) {
        return Json(RpcErrorResponse::new(
            Some(request.id),
            ERROR_UNAUTHORIZED,
            "invalid or missing x-adobepy-token header",
        ))
        .into_response();
    }
    match state.dispatch_request(request).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => Json(*error).into_response(),
    }
}

async fn client_ws(
    State(state): State<BrokerState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !state.authorized(&headers) {
        return unauthorized_response();
    }
    ws.on_upgrade(move |socket| client_socket(socket, state))
}

async fn bridge_ws(
    State(state): State<BrokerState>,
    Path(host): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    let Ok(host) = host.parse::<HostKind>() else {
        return (StatusCode::BAD_REQUEST, "unknown host").into_response();
    };
    ws.on_upgrade(move |socket| bridge_socket(socket, state, host))
}

async fn client_socket(mut socket: WebSocket, state: BrokerState) {
    while let Some(Ok(message)) = socket.next().await {
        let response = match message {
            Message::Text(text) => match serde_json::from_str::<RpcRequest>(&text) {
                Ok(request) => match state.dispatch_request(request).await {
                    Ok(response) => serde_json::to_string(&response),
                    Err(error) => serde_json::to_string(&error),
                },
                Err(error) => serde_json::to_string(&RpcErrorResponse::new(
                    None,
                    ERROR_PARSE,
                    format!("invalid JSON-RPC request: {error}"),
                )),
            },
            Message::Close(_) => break,
            _ => continue,
        };
        let response = response.unwrap_or_else(|_| serialization_error_text(None));
        if socket.send(Message::Text(response.into())).await.is_err() {
            break;
        }
    }
}

async fn bridge_socket(mut socket: WebSocket, state: BrokerState, expected_host: HostKind) {
    let Some(Ok(Message::Text(first))) = socket.next().await else {
        return;
    };
    let Ok(BridgeInbound::Hello {
        token,
        target,
        capabilities,
        identity,
        bootstrap_nonce,
    }) = serde_json::from_str::<BridgeInbound>(&first)
    else {
        return;
    };
    if !state.token.is_empty() && token != state.token {
        let _ = socket
            .send(Message::Text(
                serialize_wire(&RpcErrorResponse::new(
                    None,
                    ERROR_UNAUTHORIZED,
                    "invalid bridge token",
                ))
                .into(),
            ))
            .await;
        return;
    }
    if capabilities.host != expected_host {
        let _ = socket
            .send(Message::Text(
                serialize_wire(&RpcErrorResponse::new(
                    None,
                    ERROR_INVALID_REQUEST,
                    "bridge host mismatch",
                ))
                .into(),
            ))
            .await;
        return;
    }
    let target = target.unwrap_or_else(|| DEFAULT_TARGET.to_owned());
    let identity = match state
        .bind_photoshop_bootstrap_claim(
            &target,
            &capabilities,
            identity,
            bootstrap_nonce.as_deref(),
        )
        .await
    {
        Ok(identity) => identity,
        Err(error) => {
            let _ = socket
                .send(Message::Text(serialize_wire(&error).into()))
                .await;
            return;
        }
    };
    if let Err(error) = validate_bridge_identity_claim(&target, &capabilities, identity.as_ref()) {
        let _ = socket
            .send(Message::Text(serialize_wire(&error).into()))
            .await;
        return;
    }
    let key = session_key(expected_host, &target);
    let connection_id = state.next_connection_id();
    let (tx, mut rx) = mpsc::unbounded_channel();
    state.sessions.write().await.insert(
        key.clone(),
        BridgeSessionInfo {
            target,
            capabilities,
            connected_at_epoch_ms: epoch_ms(),
        },
    );
    if let Some(identity) = identity {
        state
            .session_identities
            .write()
            .await
            .insert(key.clone(), identity);
    } else {
        state.session_identities.write().await.remove(&key);
    }
    state.bridge_senders.write().await.insert(
        key.clone(),
        BridgeSender {
            connection_id,
            sender: tx,
        },
    );
    let (mut sender, mut receiver) = socket.split();
    loop {
        tokio::select! {
            Some(outbound) = rx.recv() => {
                if sender.send(Message::Text(serialize_wire(&outbound).into())).await.is_err() { break; }
            }
            Some(message) = receiver.next() => {
                match message {
                    Ok(Message::Text(text)) => handle_bridge_message(&state, &text).await,
                    Ok(Message::Close(_)) => break,
                    _ => {}
                }
            }
            else => break,
        }
    }
    state
        .disconnect_session(&key, connection_id, "bridge disconnected before response")
        .await;
}

async fn handle_bridge_message(state: &BrokerState, text: &str) {
    match serde_json::from_str::<BridgeInbound>(text) {
        Ok(BridgeInbound::Response { mut response }) => {
            if let Some(pending) = state.pending.lock().await.remove(&response.id) {
                response.id = pending.original_id;
                let _ = pending.sender.send(Ok(response));
            }
        }
        Ok(BridgeInbound::Error { mut error }) => {
            if let Some(id) = error.id.clone() {
                if let Some(pending) = state.pending.lock().await.remove(&id) {
                    error.id = Some(pending.original_id);
                    let _ = pending.sender.send(Err(Box::new(error)));
                }
            }
        }
        _ => {}
    }
}

fn identity_error(code: i32, message: &str, data: serde_json::Value) -> Box<RpcErrorResponse> {
    Box::new(RpcErrorResponse::new(None, code, message).with_data(data))
}

fn bootstrap_timeout_error(
    request: &PhotoshopBootstrapRequest,
    stage: &str,
) -> Box<RpcErrorResponse> {
    identity_error(
        ERROR_TIMEOUT,
        "Photoshop UXP bootstrap exceeded its bounded operation deadline",
        json!({"stage": stage, "timeoutMs": request.timeout_ms}),
    )
}

fn bootstrap_recovery_error(message: &str) -> Box<RpcErrorResponse> {
    identity_error(ERROR_IDENTITY_STALE, message, json!({"stage": "recovery"}))
}

fn validate_photoshop_bootstrap_request(
    request: &PhotoshopBootstrapRequest,
) -> Result<(), Box<RpcErrorResponse>> {
    let module_is_fixed = normalized_absolute_path(&request.plugin.installed_plugin_root)
        .zip(normalized_absolute_path(&request.plugin.module_origin))
        .is_some_and(|(root, module)| {
            let case_insensitive = root.as_bytes().get(1) == Some(&b':');
            let (root, module) = if case_insensitive {
                (root.to_ascii_lowercase(), module.to_ascii_lowercase())
            } else {
                (root, module)
            };
            module == format!("{root}/dist/main.js")
        });
    if request.bootstrap_version != PHOTOSHOP_BOOTSTRAP_VERSION
        || !is_bounded_identifier(&request.target, 128)
        || !(50..=30_000).contains(&request.timeout_ms)
        || request.host.executable_bytes == 0
        || request.host.executable_bytes > 4 * 1024 * 1024 * 1024
        || normalized_absolute_path(&request.host.executable_path).is_none()
        || !is_sha256(&request.host.executable_sha256)
        || !is_canonical_version(&request.host.host_version)
        || !is_bounded_text(&request.host.profile_id, 256)
        || !module_is_fixed
        || !is_canonical_version(&request.plugin.bridge_version)
        || request.plugin.manifest_bytes == 0
        || request.plugin.manifest_bytes > 1024 * 1024
        || !is_sha256(&request.plugin.manifest_sha256)
        || request.plugin.index_bytes == 0
        || request.plugin.index_bytes > 1024 * 1024
        || !is_sha256(&request.plugin.index_sha256)
        || request.plugin.module_bytes == 0
        || request.plugin.module_bytes > 256 * 1024 * 1024
        || !is_sha256(&request.plugin.module_sha256)
    {
        return Err(identity_error(
            ERROR_INVALID_REQUEST,
            "Photoshop bootstrap request is malformed or unbounded",
            json!({"field": "request"}),
        ));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_canonical_version(value: &str) -> bool {
    if !is_bounded_text(value, 32) {
        return false;
    }
    let components = value.split('.').collect::<Vec<_>>();
    (2..=4).contains(&components.len())
        && components.iter().all(|component| {
            !component.is_empty()
                && component.len() <= 4
                && component.bytes().all(|byte| byte.is_ascii_digit())
                && (component == &"0" || !component.starts_with('0'))
        })
}

fn normalized_paths_equal(left: &str, right: &str) -> bool {
    let Some(left) = normalized_absolute_path(left) else {
        return false;
    };
    let Some(right) = normalized_absolute_path(right) else {
        return false;
    };
    if left.as_bytes().get(1) == Some(&b':') || right.as_bytes().get(1) == Some(&b':') {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

fn random_nonce() -> String {
    let mut digest = Sha256::new();
    digest.update(Uuid::new_v4().as_bytes());
    digest.update(Uuid::new_v4().as_bytes());
    format!("{:x}", digest.finalize())
}

fn identity_fingerprint(
    identity: &RuntimeIdentityAttestation,
) -> Result<String, Box<RpcErrorResponse>> {
    let bytes = serde_json::to_vec(identity).map_err(|_| {
        identity_error(
            ERROR_SERIALIZATION,
            "runtime identity fingerprint could not be serialized",
            json!({"stage": "fingerprint"}),
        )
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn is_uuid(value: &str) -> bool {
    Uuid::parse_str(value)
        .is_ok_and(|parsed| !parsed.is_nil() && parsed.hyphenated().to_string() == value)
}

fn is_bounded_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn is_bounded_identifier(value: &str, max_bytes: usize) -> bool {
    is_bounded_text(value, max_bytes)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn is_bounded_start_identity(value: &str) -> bool {
    is_bounded_text(value, 256)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_' | b'.'))
}

fn normalized_absolute_path(value: &str) -> Option<String> {
    if !is_bounded_text(value, 32_768) {
        return None;
    }
    let normalized = value.replace('\\', "/");
    let absolute = normalized.starts_with('/')
        || (normalized.len() >= 3
            && normalized.as_bytes()[0].is_ascii_alphabetic()
            && normalized.as_bytes()[1] == b':'
            && normalized.as_bytes()[2] == b'/');
    if !absolute
        || normalized
            .split('/')
            .any(|component| matches!(component, "." | ".."))
    {
        return None;
    }
    Some(normalized.trim_end_matches('/').to_owned())
}

fn module_belongs_to_plugin(module_origin: &str, plugin_root: &str) -> bool {
    let Some(module) = normalized_absolute_path(module_origin) else {
        return false;
    };
    let Some(root) = normalized_absolute_path(plugin_root) else {
        return false;
    };
    let case_insensitive = root.as_bytes().get(1) == Some(&b':');
    let (module, root) = if case_insensitive {
        (module.to_ascii_lowercase(), root.to_ascii_lowercase())
    } else {
        (module, root)
    };
    module
        .strip_prefix(&root)
        .is_some_and(|suffix| suffix.starts_with('/') && suffix.len() > 1)
}

fn validate_bridge_identity_claim(
    target: &str,
    capabilities: &adobepy_protocol::Capabilities,
    identity: Option<&BridgeIdentityClaim>,
) -> Result<(), Box<RpcErrorResponse>> {
    if !is_bounded_identifier(target, 128) {
        return Err(identity_error(
            ERROR_INVALID_REQUEST,
            "bridge target is invalid",
            json!({"field": "target"}),
        ));
    }
    if !is_bounded_text(&capabilities.bridge_version, 64)
        || capabilities
            .host_version
            .as_deref()
            .is_some_and(|version| !is_bounded_text(version, 64))
    {
        return Err(identity_error(
            ERROR_INVALID_REQUEST,
            "bridge version identity is invalid",
            json!({"field": "capabilities"}),
        ));
    }
    let Some(identity) = identity else {
        return Ok(());
    };
    let host = &identity.host;
    let bridge = &identity.bridge;
    if host.pid.is_some_and(|pid| pid == 0)
        || host
            .process_start_identity
            .as_deref()
            .is_some_and(|value| !is_bounded_start_identity(value))
        || host
            .executable_path
            .as_deref()
            .is_some_and(|value| normalized_absolute_path(value).is_none())
        || host
            .host_version
            .as_deref()
            .is_some_and(|value| !is_bounded_text(value, 64))
        || host
            .profile_id
            .as_deref()
            .is_some_and(|value| !is_bounded_text(value, 256))
    {
        return Err(identity_error(
            ERROR_INVALID_REQUEST,
            "host runtime identity claim is invalid",
            json!({"field": "identity.host"}),
        ));
    }
    if host.host_version.as_ref() != capabilities.host_version.as_ref() {
        return Err(identity_error(
            ERROR_IDENTITY_MISMATCH,
            "host runtime version does not match bridge capabilities",
            json!({"field": "host.hostVersion"}),
        ));
    }
    if bridge
        .instance_id
        .as_deref()
        .is_some_and(|value| Uuid::parse_str(value).map_or(true, |instance| instance.is_nil()))
        || bridge
            .installed_plugin_root
            .as_deref()
            .is_some_and(|value| normalized_absolute_path(value).is_none())
        || bridge
            .module_origin
            .as_deref()
            .is_some_and(|value| normalized_absolute_path(value).is_none())
    {
        return Err(identity_error(
            ERROR_INVALID_REQUEST,
            "bridge runtime identity claim is invalid",
            json!({"field": "identity.bridge"}),
        ));
    }
    if let (Some(module_origin), Some(plugin_root)) = (
        bridge.module_origin.as_deref(),
        bridge.installed_plugin_root.as_deref(),
    ) {
        if !module_belongs_to_plugin(module_origin, plugin_root) {
            return Err(identity_error(
                ERROR_IDENTITY_MISMATCH,
                "bridge module origin is outside the installed plugin root",
                json!({"field": "bridge.moduleOrigin"}),
            ));
        }
    }
    Ok(())
}

fn complete_runtime_identity(
    broker: BrokerRuntimeIdentity,
    session: &BridgeSessionInfo,
    identity: Option<&BridgeIdentityClaim>,
) -> Result<RuntimeIdentityAttestation, Box<RpcErrorResponse>> {
    validate_bridge_identity_claim(&session.target, &session.capabilities, identity)?;
    let Some(identity) = identity else {
        return Err(identity_error(
            ERROR_IDENTITY_UNAVAILABLE,
            "bridge did not attest runtime identity",
            json!({"host": session.capabilities.host.as_str(), "target": session.target, "missingFields": ["identity"]}),
        ));
    };
    let mut missing = Vec::new();
    if identity.host.pid.is_none() {
        missing.push("host.pid");
    }
    if identity.host.process_start_identity.is_none() {
        missing.push("host.processStartIdentity");
    }
    if identity.host.executable_path.is_none() {
        missing.push("host.executablePath");
    }
    if identity.host.host_version.is_none() || session.capabilities.host_version.is_none() {
        missing.push("host.hostVersion");
    }
    if identity.host.profile_id.is_none() {
        missing.push("host.profileId");
    }
    if identity.bridge.instance_id.is_none() {
        missing.push("bridge.instanceId");
    }
    if identity.bridge.installed_plugin_root.is_none() {
        missing.push("bridge.installedPluginRoot");
    }
    if identity.bridge.module_origin.is_none() {
        missing.push("bridge.moduleOrigin");
    }
    if !missing.is_empty() {
        return Err(identity_error(
            ERROR_IDENTITY_UNAVAILABLE,
            "runtime identity claim is incomplete",
            json!({"host": session.capabilities.host.as_str(), "target": session.target, "missingFields": missing}),
        ));
    }
    if session.capabilities.host == HostKind::Photoshop
        && session.capabilities.bridge_kind != adobepy_protocol::BridgeKind::Uxp
    {
        return Err(identity_error(
            ERROR_IDENTITY_MISMATCH,
            "Photoshop runtime identity requires the UXP bridge",
            json!({"field": "bridge.bridgeKind"}),
        ));
    }
    Ok(RuntimeIdentityAttestation {
        identity_version: RUNTIME_IDENTITY_VERSION,
        broker,
        host: HostRuntimeIdentity {
            pid: identity.host.pid.expect("checked"),
            process_start_identity: identity
                .host
                .process_start_identity
                .clone()
                .expect("checked"),
            executable_path: identity.host.executable_path.clone().expect("checked"),
            host_version: identity.host.host_version.clone().expect("checked"),
            profile_id: identity.host.profile_id.clone().expect("checked"),
        },
        bridge: BridgeRuntimeIdentity {
            target: session.target.clone(),
            bridge_kind: session.capabilities.bridge_kind,
            bridge_version: session.capabilities.bridge_version.clone(),
            connected_at_epoch_ms: session.connected_at_epoch_ms,
            instance_id: identity.bridge.instance_id.clone().expect("checked"),
            installed_plugin_root: identity
                .bridge
                .installed_plugin_root
                .clone()
                .expect("checked"),
            module_origin: identity.bridge.module_origin.clone().expect("checked"),
        },
    })
}

fn validate_runtime_identity_shape(
    identity: &RuntimeIdentityAttestation,
) -> Result<(), Box<RpcErrorResponse>> {
    let broker_uuid = Uuid::parse_str(&identity.broker.instance_id);
    let host_valid = identity.host.pid > 0
        && is_bounded_start_identity(&identity.host.process_start_identity)
        && normalized_absolute_path(&identity.host.executable_path).is_some()
        && is_bounded_text(&identity.host.host_version, 64)
        && is_bounded_text(&identity.host.profile_id, 256);
    let broker_valid = identity.broker.pid > 0
        && is_bounded_start_identity(&identity.broker.process_start_identity)
        && normalized_absolute_path(&identity.broker.executable_path).is_some()
        && is_bounded_text(&identity.broker.runtime_version, 64)
        && broker_uuid.is_ok_and(|instance| !instance.is_nil());
    let bridge_uuid = Uuid::parse_str(&identity.bridge.instance_id);
    let bridge_valid = is_bounded_identifier(&identity.bridge.target, 128)
        && is_bounded_text(&identity.bridge.bridge_version, 64)
        && identity.bridge.connected_at_epoch_ms > 0
        && bridge_uuid.is_ok_and(|instance| !instance.is_nil())
        && module_belongs_to_plugin(
            &identity.bridge.module_origin,
            &identity.bridge.installed_plugin_root,
        );
    if !broker_valid || !host_valid || !bridge_valid {
        return Err(identity_error(
            ERROR_INVALID_REQUEST,
            "expected runtime identity is malformed or unbounded",
            json!({"field": "expected"}),
        ));
    }
    Ok(())
}

fn validate_expected_identity(
    actual: &RuntimeIdentityAttestation,
    expected: &RuntimeIdentityAttestation,
) -> Result<(), Box<RpcErrorResponse>> {
    if actual == expected {
        return Ok(());
    }
    let stale_field = if actual.broker.instance_id != expected.broker.instance_id {
        Some("broker.instanceId")
    } else if actual.broker.pid == expected.broker.pid
        && actual.broker.process_start_identity != expected.broker.process_start_identity
    {
        Some("broker.processStartIdentity")
    } else if actual.host.pid == expected.host.pid
        && actual.host.process_start_identity != expected.host.process_start_identity
    {
        Some("host.processStartIdentity")
    } else if actual.bridge.connected_at_epoch_ms != expected.bridge.connected_at_epoch_ms {
        Some("bridge.connectedAtEpochMs")
    } else if actual.bridge.instance_id != expected.bridge.instance_id {
        Some("bridge.instanceId")
    } else {
        None
    };
    if let Some(field) = stale_field {
        return Err(identity_error(
            ERROR_IDENTITY_STALE,
            "runtime identity expectation is stale",
            json!({"field": field}),
        ));
    }
    let actual_value = serde_json::to_value(actual).unwrap_or_default();
    let expected_value = serde_json::to_value(expected).unwrap_or_default();
    let paths = [
        "identityVersion",
        "broker.pid",
        "broker.processStartIdentity",
        "broker.executablePath",
        "broker.runtimeVersion",
        "host.pid",
        "host.processStartIdentity",
        "host.executablePath",
        "host.hostVersion",
        "host.profileId",
        "bridge.target",
        "bridge.bridgeKind",
        "bridge.bridgeVersion",
        "bridge.installedPluginRoot",
        "bridge.moduleOrigin",
    ];
    let field = paths
        .into_iter()
        .find(|path| json_path(&actual_value, path) != json_path(&expected_value, path))
        .unwrap_or("identity");
    Err(identity_error(
        ERROR_IDENTITY_MISMATCH,
        "runtime identity does not match the expected instance",
        json!({"field": field}),
    ))
}

fn json_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    path.split('.')
        .try_fold(value, |current, component| current.get(component))
}

fn validate_request(request: &RpcRequest) -> ValidationResult {
    if request.jsonrpc != JSONRPC_VERSION {
        return Err(Box::new(RpcErrorResponse::new(
            Some(request.id.clone()),
            ERROR_INVALID_REQUEST,
            "unsupported JSON-RPC version",
        )));
    }
    if request.namespace.trim().is_empty() || request.method.trim().is_empty() {
        return Err(Box::new(RpcErrorResponse::new(
            Some(request.id.clone()),
            ERROR_INVALID_REQUEST,
            "request namespace and method must not be empty",
        )));
    }
    Ok(())
}

fn validate_capability_contract(
    request: &RpcRequest,
    target: &str,
    session: &BridgeSessionInfo,
) -> ValidationResult {
    let capabilities = &session.capabilities;
    if capabilities.host != request.host {
        return Err(Box::new(RpcErrorResponse::new(
            Some(request.id.clone()),
            ERROR_CAPABILITY,
            "connected bridge host mismatch",
        )));
    }
    if !capabilities
        .namespaces
        .iter()
        .any(|namespace| namespace == &request.namespace)
    {
        return Err(Box::new(RpcErrorResponse::new(
            Some(request.id.clone()),
            ERROR_CAPABILITY,
            format!(
                "host '{}' target '{}' bridge does not support namespace '{}'",
                request.host, target, request.namespace
            ),
        )));
    }
    if !capabilities
        .methods
        .get(&request.namespace)
        .is_some_and(|methods| methods.iter().any(|method| method == &request.method))
    {
        return Err(Box::new(RpcErrorResponse::new(
            Some(request.id.clone()),
            ERROR_CAPABILITY,
            format!(
                "host '{}' target '{}' bridge does not support method '{}.{}'",
                request.host, target, request.namespace, request.method
            ),
        )));
    }
    Ok(())
}

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        "invalid or missing x-adobepy-token header",
    )
        .into_response()
}

fn serialize_wire<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| serialization_error_text(None))
}

fn serialization_error_text(id: Option<&RequestId>) -> String {
    let id_json = id
        .map(|request_id| request_id.to_string())
        .and_then(|value| serde_json::to_string(&value).ok())
        .unwrap_or_else(|| "null".to_owned());
    format!(
        r#"{{"jsonrpc":"{}","id":{},"error":{{"code":{},"message":"failed to serialize broker response"}}}}"#,
        JSONRPC_VERSION, id_json, ERROR_SERIALIZATION
    )
}

fn capture_broker_identity() -> anyhow::Result<BrokerRuntimeIdentity> {
    let executable = fs::canonicalize(std::env::current_exe()?)?;
    let executable_path = executable
        .to_str()
        .context("broker executable path is not valid UTF-8")?
        .to_owned();
    if normalized_absolute_path(&executable_path).is_none() {
        return Err(anyhow!("broker executable path is invalid"));
    }
    Ok(BrokerRuntimeIdentity {
        pid: std::process::id(),
        process_start_identity: current_process_start_identity()?,
        executable_path,
        runtime_version: env!("CARGO_PKG_VERSION").to_owned(),
        instance_id: Uuid::new_v4().hyphenated().to_string(),
    })
}

#[cfg(target_os = "linux")]
fn current_process_start_identity() -> anyhow::Result<String> {
    let process_stat = fs::read_to_string("/proc/self/stat")?;
    let command_end = process_stat
        .rfind(')')
        .context("/proc/self/stat omitted the process command terminator")?;
    let start_ticks = process_stat[command_end + 1..]
        .split_whitespace()
        .nth(19)
        .context("/proc/self/stat omitted process start ticks")?;
    if start_ticks.is_empty() || !start_ticks.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(anyhow!("/proc/self/stat process start ticks are invalid"));
    }
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    let boot_id = boot_id.trim();
    if Uuid::parse_str(boot_id).is_err() {
        return Err(anyhow!("Linux boot identity is invalid"));
    }
    Ok(format!("linux:{boot_id}:{start_ticks}"))
}

#[cfg(windows)]
fn current_process_start_identity() -> anyhow::Result<String> {
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn GetProcessTimes(
            process: isize,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
    }
    let mut creation = FileTime { low: 0, high: 0 };
    let mut exit = FileTime { low: 0, high: 0 };
    let mut kernel = FileTime { low: 0, high: 0 };
    let mut user = FileTime { low: 0, high: 0 };
    let success = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if success == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let creation_ticks = (u64::from(creation.high) << 32) | u64::from(creation.low);
    Ok(format!("windows:{creation_ticks}"))
}

#[cfg(target_os = "macos")]
fn current_process_start_identity() -> anyhow::Result<String> {
    #[repr(C)]
    struct ProcBsdInfo {
        flags: u32,
        status: u32,
        xstatus: u32,
        pid: u32,
        ppid: u32,
        uid: u32,
        gid: u32,
        ruid: u32,
        rgid: u32,
        svuid: u32,
        svgid: u32,
        reserved: u32,
        command: [u8; 16],
        name: [u8; 32],
        nfiles: u32,
        pgid: u32,
        pjobc: u32,
        controlling_tty: u32,
        foreground_pgid: u32,
        nice: i32,
        start_seconds: u64,
        start_microseconds: u64,
    }
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            size: i32,
        ) -> i32;
    }
    const PROC_PIDTBSDINFO: i32 = 3;
    let mut info: ProcBsdInfo = unsafe { std::mem::zeroed() };
    let size = i32::try_from(std::mem::size_of::<ProcBsdInfo>())?;
    let read = unsafe {
        proc_pidinfo(
            i32::try_from(std::process::id())?,
            PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut ProcBsdInfo).cast(),
            size,
        )
    };
    if read != size || info.start_seconds == 0 {
        return Err(anyhow!("macOS process start identity is unavailable"));
    }
    Ok(format!(
        "macos:{}:{:06}",
        info.start_seconds, info.start_microseconds
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn current_process_start_identity() -> anyhow::Result<String> {
    Err(anyhow!(
        "process start identity is unsupported on this platform"
    ))
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use adobepy_protocol::{BridgeKind, Capabilities, RpcOptions};
    use axum::body::Body;
    use axum::http::Request;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use tower::ServiceExt;

    fn state() -> BrokerState {
        BrokerState::new(&BrokerConfig {
            bind: SocketAddr::from(([127, 0, 0, 1], 0)),
            token: "t".into(),
            default_timeout_ms: 1,
        })
        .expect("capture test broker identity")
    }

    #[derive(Default)]
    struct FakeBootstrapBackend {
        attest_arrivals: AtomicUsize,
        attest_wait_for: AtomicUsize,
        attest_delay_ms: AtomicU64,
        first_attest_delay_ms: AtomicU64,
        prepares: AtomicUsize,
        prepare_delay_ms: AtomicU64,
        prepare_fails: AtomicBool,
        launches: AtomicUsize,
        launch_delay_ms: AtomicU64,
        launch_fails: AtomicBool,
        finalizes: AtomicUsize,
        finalize_delay_ms: AtomicU64,
        finalize_fails: AtomicBool,
        rollbacks: AtomicUsize,
        rollback_delay_ms: AtomicU64,
        rollback_fails: AtomicBool,
        process_valid: AtomicBool,
        config_state: AtomicUsize,
        executable_sha256_delay_ms: AtomicU64,
    }

    impl FakeBootstrapBackend {
        fn ready() -> Arc<Self> {
            Arc::new(Self {
                process_valid: AtomicBool::new(true),
                config_state: AtomicUsize::new(1),
                ..Self::default()
            })
        }
    }

    impl PhotoshopBootstrapBackend for FakeBootstrapBackend {
        fn attest(&self, _request: &PhotoshopBootstrapRequest) -> anyhow::Result<String> {
            let arrival = self.attest_arrivals.fetch_add(1, Ordering::SeqCst) + 1;
            let wait_for = self.attest_wait_for.load(Ordering::SeqCst);
            while wait_for > 0 && self.attest_arrivals.load(Ordering::SeqCst) < wait_for {
                std::thread::yield_now();
            }
            let delay_ms = if arrival == 1 {
                self.first_attest_delay_ms
                    .load(Ordering::SeqCst)
                    .max(self.attest_delay_ms.load(Ordering::SeqCst))
            } else {
                self.attest_delay_ms.load(Ordering::SeqCst)
            };
            std::thread::sleep(Duration::from_millis(delay_ms));
            Ok("d".repeat(64))
        }

        fn prepare(
            &self,
            _request: &PhotoshopBootstrapRequest,
            _nonce: &str,
            _token: &str,
            _websocket_url: &str,
        ) -> anyhow::Result<PreparedBootstrap> {
            self.prepares.fetch_add(1, Ordering::SeqCst);
            self.config_state.store(2, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(
                self.prepare_delay_ms.load(Ordering::SeqCst),
            ));
            if self.prepare_fails.load(Ordering::SeqCst) {
                self.rollbacks.fetch_add(1, Ordering::SeqCst);
                self.config_state.store(1, Ordering::SeqCst);
                return Err(anyhow!("deterministic prepare failure"));
            }
            Ok(PreparedBootstrap::fake("d".repeat(64)))
        }

        fn launch(
            &self,
            target: &adobepy_protocol::PhotoshopHostTarget,
        ) -> anyhow::Result<ObservedHostProcess> {
            self.launches.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(
                self.launch_delay_ms.load(Ordering::SeqCst),
            ));
            if self.launch_fails.load(Ordering::SeqCst) {
                return Err(anyhow!("deterministic launch failure"));
            }
            Ok(ObservedHostProcess {
                pid: 4200,
                process_start_identity: "windows:133700000000000100".into(),
                executable_path: target.executable_path.clone(),
            })
        }

        fn process_matches(&self, _observed: &ObservedHostProcess) -> bool {
            self.process_valid.load(Ordering::SeqCst)
        }

        fn rollback(&self, _prepared: PreparedBootstrap) -> anyhow::Result<()> {
            self.rollbacks.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(
                self.rollback_delay_ms.load(Ordering::SeqCst),
            ));
            if self.rollback_fails.load(Ordering::SeqCst) {
                return Err(anyhow!("deterministic rollback failure"));
            }
            self.config_state.store(1, Ordering::SeqCst);
            Ok(())
        }

        fn finalize(&self, _prepared: &PreparedBootstrap) -> anyhow::Result<()> {
            self.finalizes.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(
                self.finalize_delay_ms.load(Ordering::SeqCst),
            ));
            if self.finalize_fails.load(Ordering::SeqCst) {
                return Err(anyhow!("deterministic finalize failure"));
            }
            self.config_state.store(3, Ordering::SeqCst);
            Ok(())
        }

        fn executable_sha256(&self, _path: &str) -> anyhow::Result<String> {
            std::thread::sleep(Duration::from_millis(
                self.executable_sha256_delay_ms.load(Ordering::SeqCst),
            ));
            Ok("c".repeat(64))
        }
    }

    fn bootstrap_state(backend: Arc<FakeBootstrapBackend>) -> BrokerState {
        BrokerState::with_bootstrap_backend(
            &BrokerConfig {
                bind: SocketAddr::from(([127, 0, 0, 1], 47_391)),
                token: "t".into(),
                default_timeout_ms: 1,
            },
            backend,
        )
        .expect("capture test broker identity")
    }

    fn bootstrap_request(timeout_ms: u64) -> PhotoshopBootstrapRequest {
        PhotoshopBootstrapRequest {
            bootstrap_version: PHOTOSHOP_BOOTSTRAP_VERSION,
            target: "retouch".into(),
            timeout_ms,
            host: adobepy_protocol::PhotoshopHostTarget {
                executable_path: "C:/Adobe/Photoshop.exe".into(),
                executable_bytes: 42,
                executable_sha256: "a".repeat(64),
                host_version: "26.5.1".into(),
                profile_id: "profile-production".into(),
            },
            plugin: adobepy_protocol::PhotoshopPluginTarget {
                installed_plugin_root: "C:/UXP/External/com.adobepy.bridge.photoshop".into(),
                module_origin: "C:/UXP/External/com.adobepy.bridge.photoshop/dist/main.js".into(),
                bridge_version: "0.1.0".into(),
                manifest_bytes: 640,
                manifest_sha256: "d".repeat(64),
                index_bytes: 180,
                index_sha256: "e".repeat(64),
                module_bytes: 47_901,
                module_sha256: "f".repeat(64),
            },
        }
    }

    fn run_simultaneous_bootstraps_without_session(
        state: &BrokerState,
        request: &PhotoshopBootstrapRequest,
    ) -> [BootstrapResult; 2] {
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let first = std::thread::spawn({
            let state = state.clone();
            let request = request.clone();
            let barrier = barrier.clone();
            move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(request))
            }
        });
        let second = std::thread::spawn({
            let state = state.clone();
            let request = request.clone();
            let barrier = barrier.clone();
            move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(request))
            }
        });
        barrier.wait();
        [first.join().unwrap(), second.join().unwrap()]
    }

    fn request() -> RpcRequest {
        RpcRequest {
            jsonrpc: JSONRPC_VERSION.into(),
            id: RequestId::from_string("x"),
            host: HostKind::Photoshop,
            target: Some(DEFAULT_TARGET.into()),
            namespace: "app".into(),
            method: "getVersion".into(),
            args: vec![],
            options: RpcOptions::default(),
        }
    }

    fn caps() -> Capabilities {
        let mut methods = BTreeMap::new();
        methods.insert("app".into(), vec!["getVersion".into()]);
        Capabilities {
            host: HostKind::Photoshop,
            bridge_kind: BridgeKind::Uxp,
            bridge_version: "0.1.0".into(),
            host_version: Some("26.5.1".into()),
            namespaces: vec!["app".into()],
            features: vec![],
            methods,
        }
    }

    fn identity_claim() -> BridgeIdentityClaim {
        BridgeIdentityClaim {
            host: adobepy_protocol::HostIdentityClaim {
                pid: Some(4200),
                process_start_identity: Some("windows:133700000000000100".into()),
                executable_path: Some("C:/Adobe/Photoshop.exe".into()),
                host_version: Some("26.5.1".into()),
                profile_id: Some("profile-production".into()),
            },
            bridge: adobepy_protocol::BridgeInstanceClaim {
                instance_id: Some("9d31eb71-26cb-4c87-8b5a-4cadcc8e2f99".into()),
                installed_plugin_root: Some("C:/UXP/External/com.adobepy.bridge.photoshop".into()),
                module_origin: Some(
                    "C:/UXP/External/com.adobepy.bridge.photoshop/dist/main.js".into(),
                ),
            },
        }
    }

    async fn insert_identity_session(
        state: &BrokerState,
        target: &str,
        connected_at_epoch_ms: u128,
        identity: Option<BridgeIdentityClaim>,
    ) {
        let key = session_key(HostKind::Photoshop, target);
        state.sessions.write().await.insert(
            key.clone(),
            BridgeSessionInfo {
                target: target.into(),
                capabilities: caps(),
                connected_at_epoch_ms,
            },
        );
        if let Some(identity) = identity {
            state.session_identities.write().await.insert(key, identity);
        }
    }

    async fn publish_matching_bootstrap_session(state: &BrokerState) -> ObservedHostProcess {
        let (nonce, observed) = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let value = state
                    .bootstrap_grants
                    .lock()
                    .await
                    .get(&session_key(HostKind::Photoshop, "retouch"))
                    .and_then(|grant| {
                        grant
                            .observed
                            .clone()
                            .map(|observed| (grant.nonce.clone(), observed))
                    });
                if let Some(value) = value {
                    return value;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("bootstrap owner must publish its observed process");
        let bound = state
            .bind_photoshop_bootstrap_claim(
                "retouch",
                &caps(),
                Some(identity_claim()),
                Some(&nonce),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bound.host.pid, Some(observed.pid));
        insert_identity_session(state, "retouch", 1_720_000_000_000, Some(bound)).await;
        observed
    }

    fn identity_query(target: Option<&str>) -> RuntimeIdentityQuery {
        RuntimeIdentityQuery {
            host: HostKind::Photoshop,
            target: target.map(str::to_owned),
            expected: None,
        }
    }

    #[tokio::test]
    async fn endpoints_and_dispatch_errors() {
        let app = broker_router(state());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/capabilities")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let state = state();
        let error = state.dispatch_request(request()).await.unwrap_err();
        assert_eq!(error.error.code, ERROR_BRIDGE_NOT_INSTALLED);

        let mut invalid = request();
        invalid.jsonrpc = "1.0".into();
        let error = state.dispatch_request(invalid).await.unwrap_err();
        assert_eq!(error.error.code, ERROR_INVALID_REQUEST);
    }

    #[tokio::test]
    async fn dispatch_roundtrip_restores_id() {
        let state = state();
        let key = session_key(HostKind::Photoshop, DEFAULT_TARGET);
        let (tx, mut rx) = mpsc::unbounded_channel();
        state.bridge_senders.write().await.insert(
            key.clone(),
            BridgeSender {
                connection_id: 1,
                sender: tx,
            },
        );
        state.sessions.write().await.insert(
            key,
            BridgeSessionInfo {
                target: DEFAULT_TARGET.into(),
                capabilities: caps(),
                connected_at_epoch_ms: 1,
            },
        );
        let s = state.clone();
        let task = tokio::spawn(async move { s.dispatch_request(request()).await });
        let BridgeOutbound::Request { request } = rx.recv().await.unwrap();
        handle_bridge_message(
            &state,
            &serde_json::to_string(&BridgeInbound::Response {
                response: RpcResponse {
                    jsonrpc: JSONRPC_VERSION.into(),
                    id: request.id,
                    result: json!("ok"),
                    diagnostics: None,
                },
            })
            .unwrap(),
        )
        .await;
        assert_eq!(task.await.unwrap().unwrap().id, RequestId::from_string("x"));
    }

    #[tokio::test]
    async fn dispatch_enforces_capabilities_and_timeout() {
        let state = state();
        let key = session_key(HostKind::Photoshop, DEFAULT_TARGET);
        let (tx, mut rx) = mpsc::unbounded_channel();
        state.bridge_senders.write().await.insert(
            key.clone(),
            BridgeSender {
                connection_id: 1,
                sender: tx,
            },
        );
        state.sessions.write().await.insert(
            key,
            BridgeSessionInfo {
                target: DEFAULT_TARGET.into(),
                capabilities: caps(),
                connected_at_epoch_ms: 1,
            },
        );

        let mut missing = request();
        missing.method = "missing".into();
        let error = state.dispatch_request(missing).await.unwrap_err();
        assert_eq!(error.error.code, ERROR_CAPABILITY);

        let task = tokio::spawn({
            let state = state.clone();
            async move { state.dispatch_request(request()).await }
        });
        assert!(matches!(
            rx.recv().await.unwrap(),
            BridgeOutbound::Request { .. }
        ));
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.error.code, ERROR_TIMEOUT);
    }

    #[tokio::test]
    async fn disconnect_drains_pending_requests_for_current_connection() {
        let state = state();
        let key = session_key(HostKind::Photoshop, DEFAULT_TARGET);
        let (tx, mut rx) = mpsc::unbounded_channel();
        state.bridge_senders.write().await.insert(
            key.clone(),
            BridgeSender {
                connection_id: 7,
                sender: tx,
            },
        );
        state.sessions.write().await.insert(
            key.clone(),
            BridgeSessionInfo {
                target: DEFAULT_TARGET.into(),
                capabilities: caps(),
                connected_at_epoch_ms: 1,
            },
        );
        let task = tokio::spawn({
            let state = state.clone();
            async move { state.dispatch_request(request()).await }
        });
        assert!(matches!(
            rx.recv().await.unwrap(),
            BridgeOutbound::Request { .. }
        ));
        state.disconnect_session(&key, 7, "bridge closed").await;
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.error.code, ERROR_BRIDGE_NOT_INSTALLED);
        assert_eq!(state.sessions.read().await.len(), 0);
    }

    #[tokio::test]
    async fn runtime_identity_requires_one_complete_selected_claim() {
        let state = state();
        let error = state
            .runtime_identity(identity_query(Some(DEFAULT_TARGET)))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_UNAVAILABLE);

        insert_identity_session(&state, DEFAULT_TARGET, 10, None).await;
        let error = state
            .runtime_identity(identity_query(Some(DEFAULT_TARGET)))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_UNAVAILABLE);

        let mut incomplete = identity_claim();
        incomplete.host.pid = None;
        state
            .session_identities
            .write()
            .await
            .insert(session_key(HostKind::Photoshop, DEFAULT_TARGET), incomplete);
        let error = state
            .runtime_identity(identity_query(Some(DEFAULT_TARGET)))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_UNAVAILABLE);
        assert_eq!(error.error.data.unwrap()["missingFields"][0], "host.pid");

        insert_identity_session(&state, "second", 11, Some(identity_claim())).await;
        let error = state
            .runtime_identity(identity_query(None))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_AMBIGUOUS);
    }

    #[tokio::test]
    async fn runtime_identity_detects_pid_reuse_foreign_target_and_shadowing() {
        let state = state();
        insert_identity_session(&state, "retouch", 1_720_000_000_000, Some(identity_claim())).await;
        let actual = state
            .runtime_identity(identity_query(Some("retouch")))
            .await
            .unwrap();
        assert_eq!(actual.broker.pid, std::process::id());
        assert!(is_bounded_start_identity(
            &actual.broker.process_start_identity
        ));
        assert!(normalized_absolute_path(&actual.broker.executable_path).is_some());
        assert_eq!(actual.host.pid, 4200);
        assert_eq!(actual.bridge.target, "retouch");
        assert!(!serde_json::to_string(&actual).unwrap().contains("token"));

        let mut exact_query = identity_query(Some("retouch"));
        exact_query.expected = Some(actual.clone());
        assert_eq!(state.runtime_identity(exact_query).await.unwrap(), actual);

        let mut stale = actual.clone();
        stale.host.process_start_identity = "windows:133700000000000101".into();
        let mut stale_query = identity_query(Some("retouch"));
        stale_query.expected = Some(stale);
        let error = state.runtime_identity(stale_query).await.unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_STALE);
        assert_eq!(
            error.error.data.unwrap()["field"],
            "host.processStartIdentity"
        );

        let mut stale_connection = actual.clone();
        stale_connection.bridge.connected_at_epoch_ms += 1;
        let mut stale_connection_query = identity_query(Some("retouch"));
        stale_connection_query.expected = Some(stale_connection);
        let error = state
            .runtime_identity(stale_connection_query)
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_STALE);
        assert_eq!(
            error.error.data.unwrap()["field"],
            "bridge.connectedAtEpochMs"
        );

        let mut wrong_executable = actual.clone();
        wrong_executable.host.executable_path = "C:/Foreign/Photoshop.exe".into();
        let mut wrong_executable_query = identity_query(Some("retouch"));
        wrong_executable_query.expected = Some(wrong_executable);
        let error = state
            .runtime_identity(wrong_executable_query)
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_MISMATCH);
        assert_eq!(error.error.data.unwrap()["field"], "host.executablePath");

        let mut shadowed = actual.clone();
        shadowed.bridge.module_origin =
            "C:/UXP/External/com.adobepy.bridge.photoshop/dist/shadow.js".into();
        let mut shadowed_query = identity_query(Some("retouch"));
        shadowed_query.expected = Some(shadowed);
        let error = state.runtime_identity(shadowed_query).await.unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_MISMATCH);
        assert_eq!(error.error.data.unwrap()["field"], "bridge.moduleOrigin");

        let mut wrong_profile = actual.clone();
        wrong_profile.host.profile_id = "foreign-profile".into();
        let mut wrong_profile_query = identity_query(Some("retouch"));
        wrong_profile_query.expected = Some(wrong_profile);
        let error = state
            .runtime_identity(wrong_profile_query)
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_MISMATCH);
        assert_eq!(error.error.data.unwrap()["field"], "host.profileId");

        let error = state
            .runtime_identity(identity_query(Some("foreign")))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_UNAVAILABLE);
    }

    #[tokio::test]
    async fn runtime_identity_rejects_unbounded_or_unowned_bridge_claims() {
        let mut shadowed = identity_claim();
        shadowed.bridge.module_origin = Some("C:/Foreign/dist/main.js".into());
        let error =
            validate_bridge_identity_claim("default", &caps(), Some(&shadowed)).unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_MISMATCH);

        let mut unbounded = identity_claim();
        unbounded.host.profile_id = Some("x".repeat(257));
        let error =
            validate_bridge_identity_claim("default", &caps(), Some(&unbounded)).unwrap_err();
        assert_eq!(error.error.code, ERROR_INVALID_REQUEST);

        let mut version_mismatch = identity_claim();
        version_mismatch.host.host_version = Some("25.0".into());
        let error = validate_bridge_identity_claim("default", &caps(), Some(&version_mismatch))
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_MISMATCH);
    }

    #[tokio::test]
    async fn runtime_identity_endpoint_is_authenticated_and_secret_free() {
        let state = state();
        insert_identity_session(&state, "retouch", 1_720_000_000_000, Some(identity_claim())).await;
        let app = broker_router(state);
        let body = serde_json::to_vec(&identity_query(Some("retouch"))).unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/runtime-identity")
                    .header("content-type", "application/json")
                    .header("x-adobepy-token", "t")
                    .body(Body::from(body.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let response_text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(!response_text.contains("token"));
        assert!(!response_text.contains("top-secret"));

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/runtime-identity")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn photoshop_bootstrap_binds_exact_instance_and_is_idempotent() {
        let backend = FakeBootstrapBackend::ready();
        let state = bootstrap_state(backend.clone());
        let request = bootstrap_request(1_000);
        let task = tokio::spawn({
            let state = state.clone();
            let request = request.clone();
            async move { state.bootstrap_photoshop(request).await }
        });
        let (nonce, observed) = loop {
            let value = state
                .bootstrap_grants
                .lock()
                .await
                .get(&session_key(HostKind::Photoshop, "retouch"))
                .and_then(|grant| {
                    grant
                        .observed
                        .clone()
                        .map(|observed| (grant.nonce.clone(), observed))
                });
            if let Some(value) = value {
                break value;
            }
            tokio::task::yield_now().await;
        };
        let mut claim = identity_claim();
        let profile_id = claim.host.profile_id.clone();
        claim.host = adobepy_protocol::HostIdentityClaim::default();
        claim.host.profile_id = profile_id;
        let bound = state
            .bind_photoshop_bootstrap_claim("retouch", &caps(), Some(claim), Some(&nonce))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bound.host.pid, Some(observed.pid));
        assert_eq!(
            bound.host.process_start_identity.as_deref(),
            Some("windows:133700000000000100")
        );
        let replay = state
            .bind_photoshop_bootstrap_claim(
                "retouch",
                &caps(),
                Some(identity_claim()),
                Some(&nonce),
            )
            .await
            .unwrap_err();
        assert_eq!(replay.error.code, ERROR_IDENTITY_STALE);
        insert_identity_session(&state, "retouch", 1_720_000_000_000, Some(bound)).await;

        let result = task.await.unwrap().unwrap();
        assert_eq!(result.status, PhotoshopBootstrapStatus::Ready);
        assert_eq!(backend.launches.load(Ordering::SeqCst), 1);
        let wire = serde_json::to_string(&result).unwrap();
        assert!(!wire.contains("C:/"));
        assert!(!wire.to_ascii_lowercase().contains("token"));

        let verified = state
            .verify_photoshop_bootstrap(&result.continuation.receipt_id)
            .await
            .unwrap();
        assert_eq!(verified.identity_fingerprint, result.identity_fingerprint);
        let repeated = state.bootstrap_photoshop(request).await.unwrap();
        assert_eq!(repeated.status, PhotoshopBootstrapStatus::AlreadyReady);
        assert_eq!(backend.launches.load(Ordering::SeqCst), 1);
        assert!(state.bootstrap_grants.lock().await.is_empty());
        let error = state
            .bind_photoshop_bootstrap_claim(
                "retouch",
                &caps(),
                Some(identity_claim()),
                Some(&nonce),
            )
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_STALE);
        backend.process_valid.store(false, Ordering::SeqCst);
        let error = state
            .verify_photoshop_bootstrap(&result.continuation.receipt_id)
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_STALE);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_identical_bootstrap_requests_share_one_launch() {
        let backend = FakeBootstrapBackend::ready();
        backend.attest_wait_for.store(2, Ordering::SeqCst);
        backend.prepare_delay_ms.store(100, Ordering::SeqCst);
        let state = bootstrap_state(backend.clone());
        let request = bootstrap_request(1_000);
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let first = std::thread::spawn({
            let state = state.clone();
            let request = request.clone();
            let barrier = barrier.clone();
            move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(request))
            }
        });
        let second = std::thread::spawn({
            let state = state.clone();
            let barrier = barrier.clone();
            move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(request))
            }
        });
        barrier.wait();
        let (nonce, observed) = loop {
            let value = state
                .bootstrap_grants
                .lock()
                .await
                .get(&session_key(HostKind::Photoshop, "retouch"))
                .and_then(|grant| {
                    grant
                        .observed
                        .clone()
                        .map(|observed| (grant.nonce.clone(), observed))
                });
            if let Some(value) = value {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        };
        let mut claim = identity_claim();
        let profile_id = claim.host.profile_id.clone();
        claim.host = adobepy_protocol::HostIdentityClaim::default();
        claim.host.profile_id = profile_id;
        let bound = state
            .bind_photoshop_bootstrap_claim("retouch", &caps(), Some(claim), Some(&nonce))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bound.host.pid, Some(observed.pid));
        insert_identity_session(&state, "retouch", 1_720_000_000_000, Some(bound)).await;

        let first = first.join().unwrap().unwrap();
        let second = second.join().unwrap().unwrap();
        assert_eq!(second, first);
        assert_eq!(state.bootstrap_receipts.lock().await.len(), 1);
        let verified = state
            .verify_photoshop_bootstrap(&first.continuation.receipt_id)
            .await
            .unwrap();
        assert_eq!(verified, first);
        assert_eq!(backend.prepares.load(Ordering::SeqCst), 1);
        assert_eq!(backend.launches.load(Ordering::SeqCst), 1);
        assert_eq!(backend.finalizes.load(Ordering::SeqCst), 1);
        assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 0);
        assert!(state.bootstrap_grants.lock().await.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn staggered_follower_uses_its_own_entry_deadline_without_cancelling_owner() {
        let backend = FakeBootstrapBackend::ready();
        backend.first_attest_delay_ms.store(300, Ordering::SeqCst);
        backend.prepare_delay_ms.store(400, Ordering::SeqCst);
        let state = bootstrap_state(backend.clone());
        let request = bootstrap_request(500);

        let first = tokio::spawn({
            let state = state.clone();
            let request = request.clone();
            async move { state.bootstrap_photoshop(request).await }
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while backend.attest_arrivals.load(Ordering::SeqCst) < 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the first caller must enter attestation");
        tokio::time::sleep(Duration::from_millis(150)).await;

        let owner = tokio::spawn({
            let state = state.clone();
            async move { state.bootstrap_photoshop(request).await }
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let receivers = state
                    .bootstrap_grants
                    .lock()
                    .await
                    .get(&session_key(HostKind::Photoshop, "retouch"))
                    .map(|grant| grant.completion.receiver_count())
                    .unwrap_or_default();
                if receivers == 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("the earlier caller must subscribe to the later owner's grant");

        let first_error = tokio::time::timeout(Duration::from_millis(400), first)
            .await
            .expect("the follower must stop at its own handler-entry deadline")
            .unwrap()
            .unwrap_err();
        assert_eq!(first_error.error.code, ERROR_TIMEOUT);
        assert_eq!(
            first_error
                .error
                .data
                .as_ref()
                .and_then(|data| data["stage"].as_str()),
            Some("transaction")
        );
        assert!(!owner.is_finished());
        assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 0);
        assert!(state.bootstrap_receipts.lock().await.is_empty());
        assert!(state
            .bootstrap_grants
            .lock()
            .await
            .contains_key(&session_key(HostKind::Photoshop, "retouch")));

        publish_matching_bootstrap_session(&state).await;
        let owner_result = owner.await.unwrap().unwrap();
        assert_eq!(owner_result.status, PhotoshopBootstrapStatus::Ready);
        assert_eq!(backend.prepares.load(Ordering::SeqCst), 1);
        assert_eq!(backend.launches.load(Ordering::SeqCst), 1);
        assert_eq!(backend.finalizes.load(Ordering::SeqCst), 1);
        assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 0);
        assert_eq!(state.bootstrap_receipts.lock().await.len(), 1);
        assert_eq!(
            state
                .verify_photoshop_bootstrap(&owner_result.continuation.receipt_id)
                .await
                .unwrap(),
            owner_result
        );
        assert!(state.bootstrap_grants.lock().await.is_empty());
    }

    #[tokio::test]
    async fn follower_wait_is_race_safe_for_terminal_close_and_its_local_deadline() {
        let state = bootstrap_state(FakeBootstrapBackend::ready());
        let request = bootstrap_request(500);
        let terminal = identity_error(
            ERROR_IDENTITY_UNAVAILABLE,
            "the owner failed deterministically",
            json!({"stage": "commit"}),
        );
        let (completion, receiver) = watch::channel::<Option<BootstrapResult>>(None);
        completion.send_replace(Some(Err(terminal.clone())));
        drop(completion);
        let observed = state
            .wait_for_bootstrap_completion(
                &request,
                tokio::time::Instant::now() + Duration::from_secs(1),
                receiver,
            )
            .await
            .unwrap_err();
        assert_eq!(observed.error.code, terminal.error.code);
        assert_eq!(observed.error.data, terminal.error.data);

        let (completion, receiver) = watch::channel::<Option<BootstrapResult>>(None);
        drop(completion);
        let closed = state
            .wait_for_bootstrap_completion(
                &request,
                tokio::time::Instant::now() + Duration::from_secs(1),
                receiver,
            )
            .await
            .unwrap_err();
        assert_eq!(closed.error.code, ERROR_IDENTITY_STALE);
        assert_eq!(
            closed
                .error
                .data
                .as_ref()
                .and_then(|data| data["stage"].as_str()),
            Some("transaction")
        );

        let (completion, receiver) = watch::channel::<Option<BootstrapResult>>(None);
        let late_owner = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            completion.send_replace(Some(Err(terminal)));
        });
        let timed_out = state
            .wait_for_bootstrap_completion(
                &request,
                tokio::time::Instant::now() + Duration::from_millis(30),
                receiver,
            )
            .await
            .unwrap_err();
        assert_eq!(timed_out.error.code, ERROR_TIMEOUT);
        assert_eq!(
            timed_out
                .error
                .data
                .as_ref()
                .and_then(|data| data["stage"].as_str()),
            Some("transaction")
        );
        late_owner.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn identical_waiter_observes_the_owners_durable_commit_failure() {
        let backend = FakeBootstrapBackend::ready();
        backend.attest_wait_for.store(2, Ordering::SeqCst);
        backend.finalize_delay_ms.store(150, Ordering::SeqCst);
        backend.finalize_fails.store(true, Ordering::SeqCst);
        let state = bootstrap_state(backend.clone());
        let request = bootstrap_request(1_000);
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        let first = std::thread::spawn({
            let state = state.clone();
            let request = request.clone();
            let barrier = barrier.clone();
            let completed_tx = completed_tx.clone();
            move || {
                barrier.wait();
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(request));
                completed_tx.send(result).unwrap();
            }
        });
        let second = std::thread::spawn({
            let state = state.clone();
            let barrier = barrier.clone();
            let completed_tx = completed_tx.clone();
            move || {
                barrier.wait();
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(request));
                completed_tx.send(result).unwrap();
            }
        });
        drop(completed_tx);
        barrier.wait();

        publish_matching_bootstrap_session(&state).await;

        tokio::time::timeout(Duration::from_secs(2), async {
            while backend.finalizes.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("owner must enter finalize");
        let premature = completed_rx.recv_timeout(Duration::from_millis(40)).ok();
        let had_premature = premature.is_some();
        let mut outcomes = premature.into_iter().collect::<Vec<_>>();
        while outcomes.len() < 2 {
            outcomes.push(
                completed_rx
                    .recv_timeout(Duration::from_secs(2))
                    .expect("both bootstrap calls must finish"),
            );
        }
        first.join().unwrap();
        second.join().unwrap();

        assert!(
            !had_premature,
            "an identical waiter returned before the owner finished finalize"
        );
        let errors = outcomes
            .into_iter()
            .map(Result::unwrap_err)
            .collect::<Vec<_>>();
        assert_eq!(errors[0].error.code, ERROR_IDENTITY_UNAVAILABLE);
        assert_eq!(errors[1].error.code, errors[0].error.code);
        assert_eq!(errors[1].error.data, errors[0].error.data);
        assert_eq!(backend.prepares.load(Ordering::SeqCst), 1);
        assert_eq!(backend.launches.load(Ordering::SeqCst), 1);
        assert_eq!(backend.finalizes.load(Ordering::SeqCst), 1);
        assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 1);
        assert_eq!(backend.config_state.load(Ordering::SeqCst), 1);
        assert!(state.bootstrap_grants.lock().await.is_empty());
        assert!(state.bootstrap_receipts.lock().await.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn late_finalize_failure_is_one_timeout_outcome_for_owner_and_waiter() {
        let backend = FakeBootstrapBackend::ready();
        backend.attest_wait_for.store(2, Ordering::SeqCst);
        backend.finalize_delay_ms.store(250, Ordering::SeqCst);
        backend.finalize_fails.store(true, Ordering::SeqCst);
        let state = bootstrap_state(backend.clone());
        let request = bootstrap_request(200);
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let first = std::thread::spawn({
            let state = state.clone();
            let request = request.clone();
            let barrier = barrier.clone();
            move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(request))
            }
        });
        let second = std::thread::spawn({
            let state = state.clone();
            let barrier = barrier.clone();
            move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(request))
            }
        });
        barrier.wait();

        publish_matching_bootstrap_session(&state).await;

        let outcomes = [first.join().unwrap(), second.join().unwrap()];
        let errors = outcomes
            .into_iter()
            .map(Result::unwrap_err)
            .collect::<Vec<_>>();
        assert!(errors.iter().all(|error| error.error.code == ERROR_TIMEOUT));
        let mut stages = errors
            .iter()
            .map(|error| {
                error
                    .error
                    .data
                    .as_ref()
                    .and_then(|data| data["stage"].as_str())
                    .unwrap()
            })
            .collect::<Vec<_>>();
        stages.sort_unstable();
        assert_eq!(stages, ["commit", "transaction"]);
        assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 1);
        assert_eq!(backend.config_state.load(Ordering::SeqCst), 1);
        assert!(state.bootstrap_grants.lock().await.is_empty());
        assert!(state.bootstrap_receipts.lock().await.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn receipt_deadline_failure_is_shared_only_after_rollback() {
        let backend = FakeBootstrapBackend::ready();
        backend.attest_wait_for.store(2, Ordering::SeqCst);
        let state = bootstrap_state(backend.clone());
        let receipt_lock = state.bootstrap_receipts.lock().await;
        let request = bootstrap_request(200);
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let first = std::thread::spawn({
            let state = state.clone();
            let request = request.clone();
            let barrier = barrier.clone();
            move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(request))
            }
        });
        let second = std::thread::spawn({
            let state = state.clone();
            let barrier = barrier.clone();
            move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(request))
            }
        });
        barrier.wait();

        publish_matching_bootstrap_session(&state).await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while backend.finalizes.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("owner must enter finalize");
        tokio::time::sleep(Duration::from_millis(250)).await;
        drop(receipt_lock);

        let outcomes = [first.join().unwrap(), second.join().unwrap()];
        let errors = outcomes
            .into_iter()
            .map(Result::unwrap_err)
            .collect::<Vec<_>>();
        assert!(errors.iter().all(|error| error.error.code == ERROR_TIMEOUT));
        let mut stages = errors
            .iter()
            .map(|error| {
                error
                    .error
                    .data
                    .as_ref()
                    .and_then(|data| data["stage"].as_str())
                    .unwrap()
            })
            .collect::<Vec<_>>();
        stages.sort_unstable();
        assert_eq!(stages, ["receipt", "transaction"]);
        assert_eq!(backend.finalizes.load(Ordering::SeqCst), 1);
        assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 1);
        assert_eq!(backend.config_state.load(Ordering::SeqCst), 1);
        assert!(state.bootstrap_grants.lock().await.is_empty());
        assert!(state.bootstrap_receipts.lock().await.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn simultaneous_conflicting_bootstraps_have_one_owner_and_no_second_effects() {
        let backend = FakeBootstrapBackend::ready();
        backend.attest_wait_for.store(2, Ordering::SeqCst);
        backend.prepare_delay_ms.store(100, Ordering::SeqCst);
        let state = bootstrap_state(backend.clone());
        let first_request = bootstrap_request(1_000);
        let mut second_request = first_request.clone();
        second_request.host.profile_id = "profile-conflict".into();
        let barrier = Arc::new(std::sync::Barrier::new(3));

        let first = std::thread::spawn({
            let state = state.clone();
            let barrier = barrier.clone();
            move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(first_request))
            }
        });
        let second = std::thread::spawn({
            let state = state.clone();
            let barrier = barrier.clone();
            move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(second_request))
            }
        });
        barrier.wait();

        let (nonce, observed, profile_id) = loop {
            let value = state
                .bootstrap_grants
                .lock()
                .await
                .get(&session_key(HostKind::Photoshop, "retouch"))
                .and_then(|grant| {
                    grant.observed.clone().map(|observed| {
                        (
                            grant.nonce.clone(),
                            observed,
                            grant.request.host.profile_id.clone(),
                        )
                    })
                });
            if let Some(value) = value {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        };
        let mut claim = identity_claim();
        claim.host.profile_id = Some(profile_id);
        let bound = state
            .bind_photoshop_bootstrap_claim("retouch", &caps(), Some(claim), Some(&nonce))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bound.host.pid, Some(observed.pid));
        insert_identity_session(&state, "retouch", 1_720_000_000_000, Some(bound)).await;

        let outcomes = [first.join().unwrap(), second.join().unwrap()];
        assert_eq!(outcomes.iter().filter(|value| value.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|value| {
                    value
                        .as_ref()
                        .is_err_and(|error| error.error.code == ERROR_IDENTITY_AMBIGUOUS)
                })
                .count(),
            1
        );
        assert_eq!(backend.prepares.load(Ordering::SeqCst), 1);
        assert_eq!(backend.launches.load(Ordering::SeqCst), 1);
        assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn bootstrap_rejects_an_unobserved_profile_without_request_fallback() {
        let backend = FakeBootstrapBackend::ready();
        let state = bootstrap_state(backend.clone());
        let request = bootstrap_request(50);
        let task = tokio::spawn({
            let state = state.clone();
            async move { state.bootstrap_photoshop(request).await }
        });
        let nonce = loop {
            let value = state
                .bootstrap_grants
                .lock()
                .await
                .get(&session_key(HostKind::Photoshop, "retouch"))
                .and_then(|grant| grant.observed.as_ref().map(|_| grant.nonce.clone()));
            if let Some(value) = value {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        };
        let mut missing_profile = identity_claim();
        missing_profile.host.profile_id = None;
        let error = state
            .bind_photoshop_bootstrap_claim("retouch", &caps(), Some(missing_profile), Some(&nonce))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_UNAVAILABLE);
        assert!(error
            .error
            .data
            .as_ref()
            .is_some_and(|data| data.to_string().contains("identity.host.profileId")));
        assert_eq!(task.await.unwrap().unwrap_err().error.code, ERROR_TIMEOUT);
        assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn timeout_budget_starts_at_entry_and_cleans_every_mutating_phase() {
        let attest_backend = FakeBootstrapBackend::ready();
        attest_backend.attest_delay_ms.store(80, Ordering::SeqCst);
        let error = bootstrap_state(attest_backend.clone())
            .bootstrap_photoshop(bootstrap_request(50))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_TIMEOUT);
        assert_eq!(attest_backend.prepares.load(Ordering::SeqCst), 0);
        assert_eq!(attest_backend.launches.load(Ordering::SeqCst), 0);

        let hash_backend = FakeBootstrapBackend::ready();
        hash_backend
            .executable_sha256_delay_ms
            .store(80, Ordering::SeqCst);
        let hash_state = bootstrap_state(hash_backend.clone());
        insert_identity_session(
            &hash_state,
            "retouch",
            1_720_000_000_000,
            Some(identity_claim()),
        )
        .await;
        let error = hash_state
            .bootstrap_photoshop(bootstrap_request(50))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_TIMEOUT);
        assert_eq!(
            error
                .error
                .data
                .as_ref()
                .and_then(|data| data["stage"].as_str()),
            Some("broker_attestation")
        );
        assert_eq!(hash_backend.prepares.load(Ordering::SeqCst), 0);
        assert_eq!(hash_backend.launches.load(Ordering::SeqCst), 0);

        let prepare_backend = FakeBootstrapBackend::ready();
        prepare_backend.prepare_delay_ms.store(80, Ordering::SeqCst);
        let prepare_state = bootstrap_state(prepare_backend.clone());
        let error = prepare_state
            .bootstrap_photoshop(bootstrap_request(50))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_TIMEOUT);
        assert_eq!(prepare_backend.prepares.load(Ordering::SeqCst), 1);
        assert_eq!(prepare_backend.launches.load(Ordering::SeqCst), 0);
        assert_eq!(prepare_backend.rollbacks.load(Ordering::SeqCst), 1);
        assert_eq!(prepare_backend.config_state.load(Ordering::SeqCst), 1);
        assert!(prepare_state.bootstrap_grants.lock().await.is_empty());

        let launch_backend = FakeBootstrapBackend::ready();
        launch_backend.launch_delay_ms.store(80, Ordering::SeqCst);
        let launch_state = bootstrap_state(launch_backend.clone());
        let error = launch_state
            .bootstrap_photoshop(bootstrap_request(50))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_TIMEOUT);
        assert_eq!(launch_backend.prepares.load(Ordering::SeqCst), 1);
        assert_eq!(launch_backend.launches.load(Ordering::SeqCst), 1);
        assert_eq!(launch_backend.rollbacks.load(Ordering::SeqCst), 1);
        assert_eq!(launch_backend.config_state.load(Ordering::SeqCst), 1);
        assert!(launch_state.bootstrap_grants.lock().await.is_empty());

        let rollback_backend = FakeBootstrapBackend::ready();
        rollback_backend
            .rollback_delay_ms
            .store(80, Ordering::SeqCst);
        let rollback_state = bootstrap_state(rollback_backend.clone());
        let error = rollback_state
            .bootstrap_photoshop(bootstrap_request(50))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_TIMEOUT);
        assert_eq!(rollback_backend.rollbacks.load(Ordering::SeqCst), 1);
        assert_eq!(rollback_backend.config_state.load(Ordering::SeqCst), 1);
        assert!(rollback_state.bootstrap_grants.lock().await.is_empty());
    }

    #[test]
    fn late_prepare_and_launch_failures_share_timeout_after_exact_recovery() {
        for (stage, backend) in [
            ("prepare", {
                let backend = FakeBootstrapBackend::ready();
                backend.attest_wait_for.store(2, Ordering::SeqCst);
                backend.prepare_delay_ms.store(250, Ordering::SeqCst);
                backend.prepare_fails.store(true, Ordering::SeqCst);
                backend
            }),
            ("launch", {
                let backend = FakeBootstrapBackend::ready();
                backend.attest_wait_for.store(2, Ordering::SeqCst);
                backend.launch_delay_ms.store(250, Ordering::SeqCst);
                backend.launch_fails.store(true, Ordering::SeqCst);
                backend
            }),
        ] {
            let state = bootstrap_state(backend.clone());
            let outcomes =
                run_simultaneous_bootstraps_without_session(&state, &bootstrap_request(200));
            let errors = outcomes
                .into_iter()
                .map(Result::unwrap_err)
                .collect::<Vec<_>>();
            assert!(
                errors.iter().all(|error| error.error.code == ERROR_TIMEOUT),
                "{stage}"
            );
            let mut stages = errors
                .iter()
                .map(|error| {
                    error
                        .error
                        .data
                        .as_ref()
                        .and_then(|data| data["stage"].as_str())
                        .unwrap()
                })
                .collect::<Vec<_>>();
            stages.sort_unstable();
            assert_eq!(stages, [stage, "transaction"], "{stage}");
            assert_eq!(backend.prepares.load(Ordering::SeqCst), 1, "{stage}");
            assert_eq!(
                backend.launches.load(Ordering::SeqCst),
                usize::from(stage == "launch"),
                "{stage}"
            );
            assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 1, "{stage}");
            assert_eq!(backend.config_state.load(Ordering::SeqCst), 1, "{stage}");
            assert!(state.bootstrap_grants.blocking_lock().is_empty(), "{stage}");
            assert!(
                state.bootstrap_receipts.blocking_lock().is_empty(),
                "{stage}"
            );
        }
    }

    #[test]
    fn recovery_failure_reaches_a_waiter_that_is_still_within_its_own_deadline() {
        let backend = FakeBootstrapBackend::ready();
        backend.launch_delay_ms.store(250, Ordering::SeqCst);
        backend.rollback_fails.store(true, Ordering::SeqCst);
        let state = bootstrap_state(backend.clone());
        let request = bootstrap_request(200);
        let owner = std::thread::spawn({
            let state = state.clone();
            let request = request.clone();
            move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(request))
            }
        });
        let wait_deadline = std::time::Instant::now() + Duration::from_secs(2);
        while backend.launches.load(Ordering::SeqCst) == 0 {
            assert!(
                std::time::Instant::now() < wait_deadline,
                "the owner must enter launch"
            );
            std::thread::yield_now();
        }
        std::thread::sleep(Duration::from_millis(80));
        let waiter = std::thread::spawn({
            let state = state.clone();
            move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(state.bootstrap_photoshop(request))
            }
        });
        let outcomes = [owner.join().unwrap(), waiter.join().unwrap()];
        let errors = outcomes
            .into_iter()
            .map(Result::unwrap_err)
            .collect::<Vec<_>>();
        assert_eq!(errors[0].error.code, ERROR_IDENTITY_STALE);
        assert_eq!(errors[1].error.code, errors[0].error.code);
        assert_eq!(errors[1].error.data, errors[0].error.data);
        assert_eq!(
            errors[0]
                .error
                .data
                .as_ref()
                .and_then(|data| data["stage"].as_str()),
            Some("recovery")
        );
        assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 1);
        assert_eq!(backend.config_state.load(Ordering::SeqCst), 2);
        assert!(state.bootstrap_grants.blocking_lock().is_empty());
        assert!(state.bootstrap_receipts.blocking_lock().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn abort_after_prepare_rolls_back_once_and_removes_the_grant() {
        let backend = FakeBootstrapBackend::ready();
        backend.launch_delay_ms.store(250, Ordering::SeqCst);
        let state = bootstrap_state(backend.clone());
        let task = tokio::spawn({
            let state = state.clone();
            async move { state.bootstrap_photoshop(bootstrap_request(1_000)).await }
        });
        while backend.config_state.load(Ordering::SeqCst) != 2 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert_eq!(backend.config_state.load(Ordering::SeqCst), 2);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), async {
            while backend.rollbacks.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled transaction must finish rollback");
        assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 1);
        assert_eq!(backend.config_state.load(Ordering::SeqCst), 1);
        assert!(state.bootstrap_grants.lock().await.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn owner_cancellation_rolls_back_before_releasing_identical_waiters() {
        let backend = FakeBootstrapBackend::ready();
        backend.launch_delay_ms.store(250, Ordering::SeqCst);
        let state = bootstrap_state(backend.clone());
        let request = bootstrap_request(1_000);
        let owner = tokio::spawn({
            let state = state.clone();
            let request = request.clone();
            async move { state.bootstrap_photoshop(request).await }
        });
        while backend.config_state.load(Ordering::SeqCst) != 2 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        let waiter = tokio::spawn({
            let state = state.clone();
            async move { state.bootstrap_photoshop(request).await }
        });
        loop {
            let receivers = state
                .bootstrap_grants
                .lock()
                .await
                .get(&session_key(HostKind::Photoshop, "retouch"))
                .map(|grant| grant.completion.receiver_count())
                .unwrap_or_default();
            if receivers == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }

        owner.abort();
        assert!(owner.await.unwrap_err().is_cancelled());
        let error = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("waiter must be released after cancellation cleanup")
            .unwrap()
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_STALE);
        assert_eq!(
            error
                .error
                .data
                .as_ref()
                .and_then(|data| data["stage"].as_str()),
            Some("cancellation")
        );
        assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 1);
        assert_eq!(backend.config_state.load(Ordering::SeqCst), 1);
        assert!(state.bootstrap_grants.lock().await.is_empty());
        assert!(state.bootstrap_receipts.lock().await.is_empty());
    }

    #[tokio::test]
    async fn photoshop_bootstrap_rejects_foreign_stale_and_timed_out_connections() {
        let backend = FakeBootstrapBackend::ready();
        let state = bootstrap_state(backend.clone());
        let request = bootstrap_request(50);
        let task = tokio::spawn({
            let state = state.clone();
            let request = request.clone();
            async move { state.bootstrap_photoshop(request).await }
        });
        let nonce = loop {
            let value = state
                .bootstrap_grants
                .lock()
                .await
                .get(&session_key(HostKind::Photoshop, "retouch"))
                .and_then(|grant| grant.observed.as_ref().map(|_| grant.nonce.clone()));
            if let Some(value) = value {
                break value;
            }
            tokio::task::yield_now().await;
        };
        let mut foreign = identity_claim();
        foreign.bridge.module_origin = Some("C:/Foreign/dist/main.js".into());
        let error = state
            .bind_photoshop_bootstrap_claim("retouch", &caps(), Some(foreign), Some(&nonce))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_MISMATCH);
        let mut wrong_profile = identity_claim();
        wrong_profile.host.profile_id = Some("foreign-profile".into());
        let error = state
            .bind_photoshop_bootstrap_claim("retouch", &caps(), Some(wrong_profile), Some(&nonce))
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_MISMATCH);

        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.error.code, ERROR_TIMEOUT);
        assert_eq!(backend.rollbacks.load(Ordering::SeqCst), 1);

        let state = bootstrap_state(backend.clone());
        let request = bootstrap_request(1_000);
        let task = tokio::spawn({
            let state = state.clone();
            async move { state.bootstrap_photoshop(request).await }
        });
        let nonce = loop {
            let value = state
                .bootstrap_grants
                .lock()
                .await
                .get(&session_key(HostKind::Photoshop, "retouch"))
                .and_then(|grant| grant.observed.as_ref().map(|_| grant.nonce.clone()));
            if let Some(value) = value {
                break value;
            }
            tokio::task::yield_now().await;
        };
        backend.process_valid.store(false, Ordering::SeqCst);
        let error = state
            .bind_photoshop_bootstrap_claim(
                "retouch",
                &caps(),
                Some(identity_claim()),
                Some(&nonce),
            )
            .await
            .unwrap_err();
        assert_eq!(error.error.code, ERROR_IDENTITY_STALE);
        task.abort();
    }
}
