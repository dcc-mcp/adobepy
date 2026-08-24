use adobepy_protocol::{
    session_key, BridgeIdentityClaim, BridgeInbound, BridgeOutbound, BridgeRuntimeIdentity,
    BridgeSessionInfo, BrokerRuntimeIdentity, HostKind, HostRuntimeIdentity, RequestId,
    RpcErrorResponse, RpcRequest, RpcResponse, RuntimeIdentityAttestation, RuntimeIdentityQuery,
    DEFAULT_TARGET, ERROR_BRIDGE_NOT_INSTALLED, ERROR_CAPABILITY, ERROR_IDENTITY_AMBIGUOUS,
    ERROR_IDENTITY_MISMATCH, ERROR_IDENTITY_STALE, ERROR_IDENTITY_UNAVAILABLE,
    ERROR_INVALID_REQUEST, ERROR_PARSE, ERROR_SERIALIZATION, ERROR_TIMEOUT, ERROR_UNAUTHORIZED,
    JSONRPC_VERSION, RUNTIME_IDENTITY_VERSION,
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
use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use uuid::Uuid;

type DispatchResult = Result<RpcResponse, RpcErrorResponse>;
type ValidationResult = Result<(), Box<RpcErrorResponse>>;

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
}

impl BrokerState {
    fn new(config: &BrokerConfig) -> anyhow::Result<Self> {
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
        validate_request(&request).map_err(|error| *error)?;
        let target = request.target_or_default().to_owned();
        let key = session_key(request.host, &target);
        let (sender, session) = {
            let senders = self.bridge_senders.read().await;
            let sessions = self.sessions.read().await;
            (senders.get(&key).cloned(), sessions.get(&key).cloned())
        };
        let Some(sender) = sender else {
            return Err(RpcErrorResponse::new(
                Some(request.id.clone()),
                ERROR_BRIDGE_NOT_INSTALLED,
                format!(
                    "no bridge session is connected for host '{}' target '{}'",
                    request.host, target
                ),
            ));
        };
        let Some(session) = session else {
            return Err(RpcErrorResponse::new(
                Some(request.id.clone()),
                ERROR_BRIDGE_NOT_INSTALLED,
                "bridge session metadata is unavailable",
            ));
        };
        validate_capability_contract(&request, &target, &session).map_err(|error| *error)?;
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
            return Err(RpcErrorResponse::new(
                Some(original_id),
                ERROR_BRIDGE_NOT_INSTALLED,
                "bridge disconnected before request could be sent",
            ));
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcErrorResponse::new(
                Some(original_id),
                ERROR_BRIDGE_NOT_INSTALLED,
                "bridge response channel closed",
            )),
            Err(_) => {
                self.pending.lock().await.remove(&dispatch_id);
                Err(RpcErrorResponse::new(
                    Some(original_id),
                    ERROR_TIMEOUT,
                    format!("request timed out after {timeout_ms}ms"),
                ))
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
            let _ = request.sender.send(Err(RpcErrorResponse::new(
                Some(request.original_id),
                ERROR_BRIDGE_NOT_INSTALLED,
                message.clone(),
            )));
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
        Err(error) => Json(error).into_response(),
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
                    let _ = pending.sender.send(Err(error));
                }
            }
        }
        _ => {}
    }
}

fn identity_error(code: i32, message: &str, data: serde_json::Value) -> Box<RpcErrorResponse> {
    Box::new(RpcErrorResponse::new(None, code, message).with_data(data))
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
    use tower::ServiceExt;

    fn state() -> BrokerState {
        BrokerState::new(&BrokerConfig {
            bind: SocketAddr::from(([127, 0, 0, 1], 0)),
            token: "t".into(),
            default_timeout_ms: 1,
        })
        .expect("capture test broker identity")
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
}
