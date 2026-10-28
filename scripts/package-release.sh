#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION=""
OUT_DIR="dist"
SKIP_TESTS=false
INCLUDE_PORTABLE_PYTHON=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --out-dir) OUT_DIR="$2"; shift 2 ;;
        --skip-tests) SKIP_TESTS=true; shift ;;
        --include-portable-python) INCLUDE_PORTABLE_PYTHON=true; shift ;;
        *) echo "unknown option: $1"; exit 1 ;;
    esac
done

step() { echo ""; echo "==> $*"; }

external() {
    echo "+ $*"
    "$@"
}

# --- helpers ----------------------------------------------------------

copy_tree() {
    local src="$1" dst="$2"
    if [ ! -d "$src" ]; then echo "missing package input: $src"; exit 1; fi
    mkdir -p "$dst"
    cp -R "$src/." "$dst/"
}

copy_file() {
    local src="$1" dst="$2"
    if [ ! -f "$src" ]; then echo "missing package input: $src"; exit 1; fi
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
}

sha256_file() {
    if command -v sha256sum &>/dev/null; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        echo "no sha256 tool found" >&2
        exit 1
    fi
}

remove_transient_build_artifacts() {
    local base="$1"
    rm -rf "$base/build"
    find "$base" -type d \( -name "__pycache__" -o -name "*.egg-info" \) -exec rm -rf {} + 2>/dev/null || true
    find "$base" -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete 2>/dev/null || true
}

# --- runtime detection -------------------------------------------------

get_runtime_id() {
    local arch
    arch="$(uname -m)"
    case "$(uname -s)" in
        Darwin)
            if [ "$arch" = "arm64" ]; then echo "macos-arm64"
            else echo "macos-x64"
            fi ;;
        Linux)
            if [ "$arch" = "aarch64" ]; then echo "linux-arm64"
            else echo "linux-x64"
            fi ;;
        *) echo "unknown" ;;
    esac
}

if [ -z "$VERSION" ]; then
    VERSION="$(python3 -c "import json; print(json.load(open('package.json'))['version'])")"
fi

RUNTIME_ID="$(get_runtime_id)"
PACKAGE_NAME="adobepy-${VERSION}-${RUNTIME_ID}"
DIST_ROOT="$(cd "$OUT_DIR" 2>/dev/null && pwd || echo "$ROOT/$OUT_DIR")"
mkdir -p "$DIST_ROOT"
STAGE_ROOT="$DIST_ROOT/$PACKAGE_NAME"
ZIP_PATH="$DIST_ROOT/$PACKAGE_NAME.zip"
HASH_PATH="$ZIP_PATH.sha256"

rm -rf "$STAGE_ROOT"
mkdir -p "$STAGE_ROOT"

# --- build steps -------------------------------------------------------

step "Install Node dependencies if needed"
if [ ! -d "node_modules" ]; then
    external npm ci
fi

step "Ensure Python build dependencies"
python3 -c "import importlib.metadata as m, sys; ok = tuple(map(int, m.version('setuptools').split('.')[:2])) >= (77, 0); sys.exit(0 if ok else 1)" 2>/dev/null ||
    external python3 -m pip install --upgrade "coverage[toml]" "setuptools>=77" wheel

if [ "$SKIP_TESTS" = false ]; then
    step "Run full verification"
    external npm run test:all
fi

step "Build release CLI"
external cargo build --release -p adobepy-cli --bin adobepy

step "Build bridge bundles"
external npm run uxp:build
external npm run cep:build

step "Clean transient Python build artifacts"
remove_transient_build_artifacts "$ROOT"

step "Stage distribution tree"
mkdir -p "$STAGE_ROOT/bin"
mkdir -p "$STAGE_ROOT/wheels"
copy_file "target/release/adobepy" "$STAGE_ROOT/bin/adobepy"
for dir in python bridges docs generators; do
    copy_tree "$ROOT/$dir" "$STAGE_ROOT/$dir"
done
for file in README.md pyproject.toml package.json package-lock.json Cargo.toml Cargo.lock; do
    copy_file "$ROOT/$file" "$STAGE_ROOT/$file"
done
if [ "$INCLUDE_PORTABLE_PYTHON" = true ] && [ -d ".adobepy/python" ]; then
    copy_tree "$ROOT/.adobepy/python" "$STAGE_ROOT/python-runtime"
fi

step "Build Python wheel"
external python3 scripts/check_native_abi3_config.py
external python3 -m pip wheel --no-deps --no-build-isolation --wheel-dir "$STAGE_ROOT/wheels" .
external python3 scripts/check_wheel_compat.py "$STAGE_ROOT/wheels"
remove_transient_build_artifacts "$ROOT"

step "Write package docs and manifest"
# install.sh
cat > "$STAGE_ROOT/install.sh" << 'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
PYTHON="${1:-python3}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="$ROOT/bin"
WHEEL="$(ls "$ROOT/wheels/"*.whl 2>/dev/null | sort | tail -1)"
if [ -z "$WHEEL" ]; then echo "no Python wheel found"; exit 1; fi
"$PYTHON" -m pip install --user --force-reinstall "$WHEEL"
echo "Installed adobepy SDK."
echo "CLI: $BIN/adobepy"
SCRIPT
chmod +x "$STAGE_ROOT/install.sh"

cat > "$STAGE_ROOT/DISTRIBUTION-README.md" << README
# adobepy Distribution

Package: $PACKAGE_NAME
Runtime: $RUNTIME_ID

This package contains the release \`adobepy\` CLI, Python SDK wheel/source,
compiled UXP/CEP bridge templates, IR contracts, and operation docs.

\`\`\`bash
./install.sh
./bin/adobepy doctor
export ADOBEPY_TOKEN="dev-token"
./bin/adobepy broker --token \$ADOBEPY_TOKEN
\`\`\`

Adobe desktop applications, UXP Developer Tools, CEP host support, and Python
3.8+ are host-machine prerequisites and are not redistributed here.
README

python3 -c "
import json
m = {
    'name': 'adobepy',
    'version': '$VERSION',
    'runtime': '$RUNTIME_ID',
    'builtAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
    'commands': ['vx just package', './install.sh', './bin/adobepy doctor'],
    'includes': ['bin/adobepy', 'wheels/*.whl', 'python/adobe', 'bridges/uxp', 'bridges/cep', 'docs', 'generators/ir'],
    'notes': ['Rust dependencies are linked into the release executable.', 'Bridge JavaScript dependencies are bundled into bridges/**/dist.', 'The Python SDK has no third-party runtime dependencies.']
}
with open('$STAGE_ROOT/package-manifest.json', 'w') as f:
    json.dump(m, f, indent=2)
"

step "Create archive and checksum"
remove_transient_build_artifacts "$STAGE_ROOT"
(cd "$DIST_ROOT" && zip -r "$ZIP_PATH" "$PACKAGE_NAME")
HASH="$(sha256_file "$ZIP_PATH")"
echo "$HASH  $(basename "$ZIP_PATH")" > "$HASH_PATH"

echo ""
echo "Package directory: $STAGE_ROOT"
echo "Archive: $ZIP_PATH"
echo "SHA256: $HASH_PATH"
