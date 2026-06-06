# Support Matrix

## Phase 1 Scope

Phase 1 explicitly supports **Windows only**. macOS and Linux support are not
in scope and will not be validated in CI.

## Distribution Channels

| Channel | Content | Constraints |
| --- | --- | --- |
| **PyPI** (`adobepy`) | Python SDK wheel only (`py3-none-any`) | Pure Python. No native extensions in Phase 1. |
| **GitHub Release** | Broker + runtime bundle (`adobepy-<version>-windows-x64.zip` + `.sha256`) | Windows x86-64 only. Includes Rust CLI, bridge templates, Python SDK, installer. |

## Supported Hosts

| Host | Bridge | Phase 1 Status |
| --- | --- | --- |
| Photoshop | UXP | Full support |
| InDesign | UXP | Full support |
| Premiere Pro | UXP | Full support |
| After Effects | CEP + ExtendScript | Full support |
| Illustrator | CEP + ExtendScript | Full support |

## Python Support

| Version | Status |
| --- | --- |
| 3.8 | Supported |
| 3.9 | Supported |
| 3.10 | Supported |
| 3.11 | Supported |
| 3.12 | Supported |

The Python SDK is distributed as a `py3-none-any` wheel. No platform-specific or
ABI-specific wheels are published in Phase 1.

## Build Targets

| Binary | Source | Platform | Phase 1 |
| --- | --- | --- | --- |
| `adobepy.exe` (CLI + broker) | `crates/adobepy-cli` | Windows x86-64 | Bundled in release asset |
| Python wheel | `python/adobe/` | any (pure) | Published to PyPI |
| UXP bridge bundles | `bridges/uxp/` | any | Bundled in release asset |
| CEP bridge bundles | `bridges/cep/` | any | Bundled in release asset |

## Out of Scope (Phase 1)

- macOS or Linux broker builds
- Native Python extensions (PyO3 / maturin)
- Docker images or containerized broker
- Signed installers or MSI packages
- Automatic updates
