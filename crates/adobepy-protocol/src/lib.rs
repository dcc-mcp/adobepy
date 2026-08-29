use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

pub const JSONRPC_VERSION: &str = "2.0";
pub const DEFAULT_TARGET: &str = "default";
pub const ERROR_PARSE: i32 = -32700;
pub const ERROR_INVALID_REQUEST: i32 = -32600;
pub const ERROR_METHOD_NOT_FOUND: i32 = -32601;
pub const ERROR_HOST_NOT_RUNNING: i32 = -32001;
pub const ERROR_BRIDGE_NOT_INSTALLED: i32 = -32002;
pub const ERROR_CAPABILITY: i32 = -32003;
pub const ERROR_HOST_SCRIPT: i32 = -32004;
pub const ERROR_PERMISSION: i32 = -32005;
pub const ERROR_MODAL_REQUIRED: i32 = -32006;
pub const ERROR_TIMEOUT: i32 = -32007;
pub const ERROR_SERIALIZATION: i32 = -32008;
pub const ERROR_UNAUTHORIZED: i32 = -32009;
pub const ERROR_IDENTITY_UNAVAILABLE: i32 = -32010;
pub const ERROR_IDENTITY_STALE: i32 = -32011;
pub const ERROR_IDENTITY_AMBIGUOUS: i32 = -32012;
pub const ERROR_IDENTITY_MISMATCH: i32 = -32013;
pub const RUNTIME_IDENTITY_VERSION: u8 = 1;
pub const PHOTOSHOP_BOOTSTRAP_VERSION: u8 = 1;
pub const ILLUSTRATOR_BOOTSTRAP_VERSION: u8 = 1;
pub const AFTER_EFFECTS_BOOTSTRAP_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum HostKind {
    #[serde(rename = "photoshop")]
    Photoshop,
    #[serde(rename = "indesign")]
    InDesign,
    #[serde(rename = "premiere")]
    Premiere,
    #[serde(rename = "after-effects")]
    AfterEffects,
    #[serde(rename = "illustrator")]
    Illustrator,
    #[serde(rename = "lightroom-classic")]
    LightroomClassic,
    #[serde(rename = "acrobat")]
    Acrobat,
    #[serde(rename = "animate")]
    Animate,
    #[serde(rename = "cloud")]
    Cloud,
}

impl HostKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Photoshop => "photoshop",
            Self::InDesign => "indesign",
            Self::Premiere => "premiere",
            Self::AfterEffects => "after-effects",
            Self::Illustrator => "illustrator",
            Self::LightroomClassic => "lightroom-classic",
            Self::Acrobat => "acrobat",
            Self::Animate => "animate",
            Self::Cloud => "cloud",
        }
    }
}

impl fmt::Display for HostKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for HostKind {
    type Err = ProtocolError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "photoshop" | "ps" => Ok(Self::Photoshop),
            "indesign" | "id" => Ok(Self::InDesign),
            "premiere" | "premiere-pro" | "pr" => Ok(Self::Premiere),
            "after-effects" | "aftereffects" | "ae" => Ok(Self::AfterEffects),
            "illustrator" | "ai" => Ok(Self::Illustrator),
            "lightroom-classic" | "lightroom" | "lr" => Ok(Self::LightroomClassic),
            "acrobat" => Ok(Self::Acrobat),
            "animate" => Ok(Self::Animate),
            "cloud" | "rest" => Ok(Self::Cloud),
            _ => Err(ProtocolError::UnknownHost(value.to_owned())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BridgeKind {
    #[serde(rename = "uxp")]
    Uxp,
    #[serde(rename = "cep")]
    Cep,
    #[serde(rename = "extendscript")]
    ExtendScript,
    #[serde(rename = "lua")]
    Lua,
    #[serde(rename = "native")]
    Native,
    #[serde(rename = "acrobat-js")]
    AcrobatJs,
    #[serde(rename = "rest")]
    Rest,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    String(String),
    Number(i64),
}

impl RequestId {
    pub fn from_string(value: impl Into<String>) -> Self {
        Self::String(value.into())
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::String(value) => f.write_str(value),
            Self::Number(value) => write!(f, "{value}"),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcOptions {
    #[serde(default)]
    pub modal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: RequestId,
    pub host: HostKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub namespace: String,
    pub method: String,
    #[serde(default)]
    pub args: Vec<Value>,
    #[serde(default)]
    pub options: RpcOptions,
}

impl RpcRequest {
    pub fn target_or_default(&self) -> &str {
        self.target.as_deref().unwrap_or(DEFAULT_TARGET)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: RequestId,
    pub result: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Diagnostics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcErrorObject {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcErrorResponse {
    pub jsonrpc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<RequestId>,
    pub error: RpcErrorObject,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Diagnostics>,
}

impl RpcErrorResponse {
    pub fn new(id: Option<RequestId>, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            error: RpcErrorObject {
                code,
                message: message.into(),
                data: None,
            },
            diagnostics: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.error.data = Some(data);
        self
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub host: HostKind,
    pub bridge_kind: BridgeKind,
    pub bridge_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_version: Option<String>,
    #[serde(default)]
    pub namespaces: Vec<String>,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub methods: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSessionInfo {
    pub target: String,
    pub capabilities: Capabilities,
    pub connected_at_epoch_ms: u128,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostIdentityClaim {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_start_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeInstanceClaim {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_plugin_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module_origin: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeIdentityClaim {
    #[serde(default)]
    pub host: HostIdentityClaim,
    #[serde(default)]
    pub bridge: BridgeInstanceClaim,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerRuntimeIdentity {
    pub pid: u32,
    pub process_start_identity: String,
    pub executable_path: String,
    pub runtime_version: String,
    pub instance_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostRuntimeIdentity {
    pub pid: u32,
    pub process_start_identity: String,
    pub executable_path: String,
    pub host_version: String,
    pub profile_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeRuntimeIdentity {
    pub target: String,
    pub bridge_kind: BridgeKind,
    pub bridge_version: String,
    pub connected_at_epoch_ms: u128,
    pub instance_id: String,
    pub installed_plugin_root: String,
    pub module_origin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeIdentityAttestation {
    pub identity_version: u8,
    pub broker: BrokerRuntimeIdentity,
    pub host: HostRuntimeIdentity,
    pub bridge: BridgeRuntimeIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeIdentityQuery {
    pub host: HostKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<RuntimeIdentityAttestation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoshopHostTarget {
    pub executable_path: String,
    pub executable_bytes: u64,
    pub executable_sha256: String,
    pub host_version: String,
    pub profile_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoshopPluginTarget {
    pub installed_plugin_root: String,
    pub module_origin: String,
    pub bridge_version: String,
    pub manifest_bytes: u64,
    pub manifest_sha256: String,
    pub index_bytes: u64,
    pub index_sha256: String,
    pub module_bytes: u64,
    pub module_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoshopBootstrapRequest {
    pub bootstrap_version: u8,
    pub target: String,
    pub timeout_ms: u64,
    pub host: PhotoshopHostTarget,
    pub plugin: PhotoshopPluginTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapBrokerBinding {
    pub pid: u32,
    pub process_start_identity: String,
    pub runtime_version: String,
    pub instance_id: String,
    pub executable_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapHostBinding {
    pub pid: u32,
    pub process_start_identity: String,
    pub host_version: String,
    pub profile_id: String,
    pub executable_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapPluginBinding {
    pub instance_id: String,
    pub bridge_version: String,
    pub module_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhotoshopBootstrapStatus {
    Ready,
    AlreadyReady,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoshopBootstrapContinuation {
    pub method: String,
    pub path: String,
    pub receipt_id: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapAdapterContinuation {
    pub kind: String,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoshopBootstrapResult {
    pub bootstrap_version: u8,
    pub status: PhotoshopBootstrapStatus,
    pub identity_fingerprint: String,
    pub broker: BootstrapBrokerBinding,
    pub host: BootstrapHostBinding,
    pub plugin: BootstrapPluginBinding,
    pub continuation: PhotoshopBootstrapContinuation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_continuation: Option<BootstrapAdapterContinuation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoshopBootstrapVerifyRequest {
    pub receipt_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IllustratorHostTarget {
    pub executable_path: String,
    pub executable_bytes: u64,
    pub executable_sha256: String,
    pub host_version: String,
    pub profile_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IllustratorPluginTarget {
    pub installed_plugin_root: String,
    pub module_origin: String,
    pub bridge_version: String,
    pub manifest_bytes: u64,
    pub manifest_sha256: String,
    pub index_bytes: u64,
    pub index_sha256: String,
    pub module_bytes: u64,
    pub module_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IllustratorBootstrapRequest {
    pub bootstrap_version: u8,
    pub target: String,
    pub timeout_ms: u64,
    pub host: IllustratorHostTarget,
    pub plugin: IllustratorPluginTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IllustratorBootstrapStatus {
    Ready,
    AlreadyReady,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IllustratorBrokerBinding {
    pub pid: u32,
    pub process_start_identity: String,
    pub runtime_version: String,
    pub instance_id: String,
    pub executable_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IllustratorHostBinding {
    pub pid: u32,
    pub process_start_identity: String,
    pub host_version: String,
    pub profile_id: String,
    pub instance_id: String,
    pub executable_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IllustratorPluginBinding {
    pub target: String,
    pub connected_at_epoch_ms: u128,
    pub instance_id: String,
    pub bridge_version: String,
    pub module_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IllustratorBootstrapContinuation {
    pub method: String,
    pub path: String,
    pub receipt_id: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IllustratorBootstrapResult {
    pub bootstrap_version: u8,
    pub status: IllustratorBootstrapStatus,
    pub identity_fingerprint: String,
    pub broker: IllustratorBrokerBinding,
    pub host: IllustratorHostBinding,
    pub plugin: IllustratorPluginBinding,
    pub continuation: IllustratorBootstrapContinuation,
    pub adapter_continuation: BootstrapAdapterContinuation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IllustratorBootstrapVerifyRequest {
    pub receipt_id: String,
}

/// After Effects CEP uses the same bounded, fixed-file bootstrap shape as the
/// Illustrator CEP bridge. Keep a distinct public name so adapters cannot
/// accidentally target the wrong host route.
pub type AfterEffectsHostTarget = IllustratorHostTarget;
pub type AfterEffectsPluginTarget = IllustratorPluginTarget;
pub type AfterEffectsBootstrapRequest = IllustratorBootstrapRequest;
pub type AfterEffectsBootstrapStatus = IllustratorBootstrapStatus;
pub type AfterEffectsBrokerBinding = IllustratorBrokerBinding;
pub type AfterEffectsHostBinding = IllustratorHostBinding;
pub type AfterEffectsPluginBinding = IllustratorPluginBinding;
pub type AfterEffectsBootstrapContinuation = IllustratorBootstrapContinuation;
pub type AfterEffectsBootstrapResult = IllustratorBootstrapResult;
pub type AfterEffectsBootstrapVerifyRequest = IllustratorBootstrapVerifyRequest;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BridgeInbound {
    Hello {
        token: String,
        #[serde(default)]
        target: Option<String>,
        capabilities: Capabilities,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        identity: Option<BridgeIdentityClaim>,
        #[serde(
            default,
            rename = "bootstrapNonce",
            skip_serializing_if = "Option::is_none"
        )]
        bootstrap_nonce: Option<String>,
    },
    Response {
        response: RpcResponse,
    },
    Error {
        error: RpcErrorResponse,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BridgeOutbound {
    Request { request: RpcRequest },
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("unknown Adobe host '{0}'")]
    UnknownHost(String),
}

pub fn session_key(host: HostKind, target: &str) -> String {
    format!("{}:{target}", host.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_contracts() {
        assert_eq!("ps".parse::<HostKind>().unwrap(), HostKind::Photoshop);
        assert!("unknown".parse::<HostKind>().is_err());
        let options = RpcOptions {
            modal: true,
            command_name: Some("Hide".into()),
            timeout_ms: Some(1),
            trace_id: None,
        };
        let value = serde_json::to_value(options).unwrap();
        assert_eq!(value["commandName"], "Hide");
        assert_eq!(RequestId::from_string("x").to_string(), "x");
        assert_eq!(
            session_key(HostKind::Photoshop, "default"),
            "photoshop:default"
        );
        let err =
            RpcErrorResponse::new(Some(RequestId::from_string("x")), ERROR_HOST_SCRIPT, "boom")
                .with_data(serde_json::json!({"line": 1}));
        assert_eq!(err.error.data.unwrap()["line"], 1);
    }

    #[test]
    fn runtime_identity_contract_is_typed_and_secret_free() {
        let identity = RuntimeIdentityAttestation {
            identity_version: 1,
            broker: BrokerRuntimeIdentity {
                pid: 4100,
                process_start_identity: "windows:133700000000000000".into(),
                executable_path: "C:/adobepy/adobepy.exe".into(),
                runtime_version: "0.1.0".into(),
                instance_id: "76db1078-74c9-45c1-87e1-e8258649815e".into(),
            },
            host: HostRuntimeIdentity {
                pid: 4200,
                process_start_identity: "windows:133700000000000100".into(),
                executable_path: "C:/Adobe/Photoshop.exe".into(),
                host_version: "26.5.1".into(),
                profile_id: "profile-production".into(),
            },
            bridge: BridgeRuntimeIdentity {
                target: "retouch".into(),
                bridge_kind: BridgeKind::Uxp,
                bridge_version: "0.1.0".into(),
                connected_at_epoch_ms: 1_720_000_000_000,
                instance_id: "9d31eb71-26cb-4c87-8b5a-4cadcc8e2f99".into(),
                installed_plugin_root: "C:/UXP/External/com.adobepy.bridge.photoshop".into(),
                module_origin: "C:/UXP/External/com.adobepy.bridge.photoshop/dist/main.js".into(),
            },
        };
        let value = serde_json::to_value(identity).unwrap();
        assert_eq!(value["host"]["pid"], 4200);
        assert_eq!(value["bridge"]["target"], "retouch");
        assert!(!serde_json::to_string(&value).unwrap().contains("token"));
    }

    #[test]
    fn photoshop_bootstrap_contract_is_typed_and_path_redacted() {
        let request = PhotoshopBootstrapRequest {
            bootstrap_version: PHOTOSHOP_BOOTSTRAP_VERSION,
            target: "retouch".into(),
            timeout_ms: 7_000,
            host: PhotoshopHostTarget {
                executable_path: "C:/Adobe/Photoshop.exe".into(),
                executable_bytes: 42,
                executable_sha256: "a".repeat(64),
                host_version: "27.0.1".into(),
                profile_id: "production".into(),
            },
            plugin: PhotoshopPluginTarget {
                installed_plugin_root: "C:/UXP/com.adobepy.bridge.photoshop".into(),
                module_origin: "C:/UXP/com.adobepy.bridge.photoshop/dist/main.js".into(),
                bridge_version: "0.1.0".into(),
                manifest_bytes: 640,
                manifest_sha256: "d".repeat(64),
                index_bytes: 180,
                index_sha256: "e".repeat(64),
                module_bytes: 47_901,
                module_sha256: "f".repeat(64),
            },
        };
        assert_eq!(
            serde_json::to_value(&request).unwrap()["bootstrapVersion"],
            PHOTOSHOP_BOOTSTRAP_VERSION
        );
        let result = PhotoshopBootstrapResult {
            bootstrap_version: PHOTOSHOP_BOOTSTRAP_VERSION,
            status: PhotoshopBootstrapStatus::Ready,
            identity_fingerprint: "b".repeat(64),
            broker: BootstrapBrokerBinding {
                pid: 1,
                process_start_identity: "windows:1".into(),
                runtime_version: "0.7.0".into(),
                instance_id: UuidForTest::VALUE.into(),
                executable_sha256: "c".repeat(64),
            },
            host: BootstrapHostBinding {
                pid: 2,
                process_start_identity: "windows:2".into(),
                host_version: "27.0.1".into(),
                profile_id: "production".into(),
                executable_sha256: "a".repeat(64),
            },
            plugin: BootstrapPluginBinding {
                instance_id: UuidForTest::VALUE.into(),
                bridge_version: "0.1.0".into(),
                module_sha256: "d".repeat(64),
            },
            continuation: PhotoshopBootstrapContinuation {
                method: "POST".into(),
                path: "/v1/photoshop/bootstrap/verify".into(),
                receipt_id: UuidForTest::VALUE.into(),
                timeout_ms: 7_000,
            },
            adapter_continuation: None,
        };
        let wire = serde_json::to_string(&result).unwrap();
        assert!(!wire.contains("executablePath"));
        assert!(!wire.contains("installedPluginRoot"));
        assert!(!wire.to_ascii_lowercase().contains("token"));
    }

    #[test]
    fn illustrator_bootstrap_result_binds_target_epoch_and_fixed_continuation() {
        let result = IllustratorBootstrapResult {
            bootstrap_version: ILLUSTRATOR_BOOTSTRAP_VERSION,
            status: IllustratorBootstrapStatus::Ready,
            identity_fingerprint: "a".repeat(64),
            broker: IllustratorBrokerBinding {
                pid: 1,
                process_start_identity: "windows:1".into(),
                runtime_version: "0.8.0".into(),
                instance_id: UuidForTest::VALUE.into(),
                executable_sha256: "b".repeat(64),
            },
            host: IllustratorHostBinding {
                pid: 2,
                process_start_identity: "windows:2".into(),
                host_version: "30.0.0".into(),
                profile_id: "production".into(),
                instance_id: UuidForTest::VALUE.into(),
                executable_sha256: "c".repeat(64),
            },
            plugin: IllustratorPluginBinding {
                target: "illustration".into(),
                connected_at_epoch_ms: 1_775_000_000_000,
                instance_id: UuidForTest::VALUE.into(),
                bridge_version: "0.1.0".into(),
                module_sha256: "d".repeat(64),
            },
            continuation: IllustratorBootstrapContinuation {
                method: "POST".into(),
                path: "/v1/illustrator/bootstrap/verify".into(),
                receipt_id: UuidForTest::VALUE.into(),
                timeout_ms: 7_000,
            },
            adapter_continuation: BootstrapAdapterContinuation {
                kind: "command".into(),
                argv: vec![
                    "dcc-mcp-illustrator".into(),
                    "verify".into(),
                    "--json".into(),
                ],
            },
        };
        let wire = serde_json::to_value(&result).unwrap();
        assert_eq!(wire["plugin"]["target"], "illustration");
        assert_eq!(wire["plugin"]["connectedAtEpochMs"], 1_775_000_000_000u64);
        assert_eq!(wire["adapterContinuation"]["argv"][1], "verify");
        let text = wire.to_string();
        assert!(!text.contains("executablePath"));
        assert!(!text.contains("installedPluginRoot"));
        assert!(!text.to_ascii_lowercase().contains("token"));
    }

    struct UuidForTest;

    impl UuidForTest {
        const VALUE: &'static str = "76db1078-74c9-45c1-87e1-e8258649815e";
    }
}
