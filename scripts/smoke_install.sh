#!/usr/bin/env bash
set -euo pipefail

ZIP_PATH=""
PYTHON="python3"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --zip) ZIP_PATH="$2"; shift 2 ;;
        --python) PYTHON="$2"; shift 2 ;;
        *) echo "usage: $0 --zip <path> [--python <python>]"; exit 1 ;;
    esac
done

if [ -z "$ZIP_PATH" ]; then
    echo "error: --zip is required"
    exit 1
fi

ZIP_PATH="$(cd "$(dirname "$ZIP_PATH")" && pwd)/$(basename "$ZIP_PATH")"
if [ ! -f "$ZIP_PATH" ]; then
    echo "error: zip not found: $ZIP_PATH"
    exit 1
fi

echo "==> Smoke test: $ZIP_PATH"

TEMP_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "Extracting to $TEMP_DIR..."
unzip -q "$ZIP_PATH" -d "$TEMP_DIR"

EXTRACTED_ROOT="$(ls -d "$TEMP_DIR"/*/ 2>/dev/null | head -1)"
if [ -z "$EXTRACTED_ROOT" ]; then
    echo "error: no root directory found inside zip"
    exit 1
fi
echo "Extracted root: $EXTRACTED_ROOT"

INSTALL_SCRIPT="$EXTRACTED_ROOT/install.sh"
if [ ! -f "$INSTALL_SCRIPT" ]; then
    echo "error: install.sh not found in package"
    exit 1
fi

echo "Running install.sh..."
# The generated install.sh reads the interpreter as its first positional
# argument (defaulting to python3), matching `./install.sh <python>` usage.
( cd "$EXTRACTED_ROOT" && bash "$INSTALL_SCRIPT" "$PYTHON" )

echo "Verifying SDK import..."
"$PYTHON" -c "
from adobe.photoshop import Photoshop
from adobe.indesign import InDesign
from adobe.premiere import Premiere
from adobe.after_effects import AfterEffects
from adobe.illustrator import Illustrator
from adobe.raw import RawSession
from adobe.dcc_mcp import adobe_success
assert Photoshop.__name__ == 'Photoshop'
assert adobe_success('ok')['success'] is True
print('SDK import smoke passed')
"

DOCTOR_EXE="$EXTRACTED_ROOT/bin/adobepy"
if [ ! -f "$DOCTOR_EXE" ]; then
    echo "error: adobepy not found at $DOCTOR_EXE"
    exit 1
fi

echo "Running adobepy doctor --json..."
DOCTOR_OUTPUT="$("$DOCTOR_EXE" doctor --json 2>&1 || true)"

if ! echo "$DOCTOR_OUTPUT" | python3 -c "import sys,json; data=json.load(sys.stdin); unexpected=[d for d in data if not d.get('ok') and d.get('name') != 'broker_port']; sys.exit(len(unexpected))" 2>/dev/null; then
    echo "adobepy doctor found unexpected failures:"
    echo "$DOCTOR_OUTPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for d in data:
    status = ' ok ' if d.get('ok') else 'warn'
    print(f'  [{status}] {d[\"name\"]}: {d.get(\"detail\", \"\")}')
    " 2>/dev/null
fi

echo "Doctor results:"
echo "$DOCTOR_OUTPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for d in data:
    status = ' ok ' if d.get('ok') else 'warn'
    print(f'  [{status}] {d[\"name\"]}: {d.get(\"detail\", \"\")}')
"

echo "Install smoke test passed"
