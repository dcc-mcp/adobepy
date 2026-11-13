# Host availability, identity, and custom locations

Report these states separately: executable found, application started, product
identity verified, bridge loaded, and typed host operations verified. A program
can exist and start without supporting a particular plugin or verified session.

## Current boundaries

| Check | Owner and purpose | Configuration |
| --- | --- | --- |
| Signature inventory | Windows `Get-AuthenticodeSignature` queries file integrity and publisher evidence. `HashMismatch` means the file hash differs from the signed hash; it does not determine license status or prove a launch failure. | A read-only query does not itself block execution. |
| Photoshop product path | On Windows, AdobePy bounded bootstrap checks `Photoshop.exe` under a parent beginning `Adobe Photoshop `, exact bytes/digest and anti-redirection. | No public path-rule bypass. This Rust bootstrap does not itself call Authenticode; independent product identification is an adapter prerequisite. |
| After Effects path/signature | The DCC-MCP AE adapter's default Windows discovery uses `Adobe After Effects 20xx/Support Files/AfterFX.exe`. Explicit Windows paths can select relocated `AfterFX.exe` files while retaining valid Adobe signature, product metadata and exact identity checks. | Explicit-path support belongs to the AE adapter; older builds may still require canonical directories. Extension/state directory overrides do not change host verification. |
| Host version | Manifests/preflight require the APIs in use: Photoshop 25.0+, InDesign 19.0+, Premiere 25.6+; AE adapter 24.0+. | Separate from signature status. |
| Runtime identity | Where supported, broker/adapter bind executable, PID/start identity, profile, module, target and connection instance to prevent replacement, PID reuse and wrong-instance control. | URL/token/target select a connection, not a trust bypass. Required identity that is unavailable stays fail-closed. |
| UI `input_failed` | A UI tool reports that operation's failure. The code alone does not identify a signature, version or plugin-loading cause. | Preserve the exact tool/target error and diagnose it separately. |

Implementation: `photoshop_bootstrap.rs::validate_host_file` /
`is_photoshop_product_path`, the runtime identity contract in
[protocol.md](protocol.md), and the AE adapter's
`install_discovery.py::_resolve_host` / `trusted_host_attestation` with
verification-time reattestation. Signature evidence is not an Adobe activation
or licensing check; a valid signature also does not establish every other kind
of trust. Microsoft documents [signature status](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.signaturestatus)
and [Get-AuthenticodeSignature](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature).

## Proposed support for legitimate custom paths

Windows AE explicit-path support is handled by its adapter under the constraints
above. The broader proposal below does not change Photoshop or macOS rules.

Folder naming is an implementation restriction, not a reliable substitute for
product identity. A future explicit custom-path policy can verify publisher and
product metadata independently, then bind the physical file, exact bytes,
native process, bridge and receipt. Keep anti-redirection, replacement and
wrong-instance protection instead of adding a global skip-verification switch.

Treat updates as new identities, distinguish multiple installed versions, and
recheck the selected file before use. Receipts must reflect the newly verified
payload; a supplied path or existing receipt alone cannot establish trust.
This proposal is not an implemented override of current checks and does not
change Adobe licensing or activation behavior.
