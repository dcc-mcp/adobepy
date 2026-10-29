#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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

PYTHON="$(command -v "$PYTHON")"
"$PYTHON" "$SCRIPT_DIR/check_package_checksum.py" "$ZIP_PATH"

echo "==> Smoke test: $ZIP_PATH"

TEMP_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "Extracting to $TEMP_DIR..."
mkdir "$TEMP_DIR/package"
unzip -q "$ZIP_PATH" -d "$TEMP_DIR/package"

shopt -s nullglob dotglob
roots=("$TEMP_DIR/package/"*)
if [ "${#roots[@]}" -ne 1 ] || [ ! -d "${roots[0]}" ]; then
    echo "error: expected exactly one package root directory"
    exit 1
fi
EXTRACTED_ROOT="${roots[0]}"
for binary in adobepy adobepy-bootstrap-helper; do
    if [ ! -f "$EXTRACTED_ROOT/bin/$binary" ] || [ ! -x "$EXTRACTED_ROOT/bin/$binary" ]; then
        echo "error: missing executable bin/$binary in package"
        exit 1
    fi
done
for directory in bridges python; do
    if [ ! -d "$EXTRACTED_ROOT/$directory" ]; then
        echo "error: missing $directory in package"
        exit 1
    fi
done

# A clean venv prevents a preinstalled SDK from hiding a broken wheel. Keep it
# outside the extracted tree, and ignore checkout/user-site Python paths.
"$PYTHON" -I -m venv "$TEMP_DIR/venv"
PYTHON="$TEMP_DIR/venv/bin/python"
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
( cd "$TEMP_DIR" && "$PYTHON" -I -c "
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
" )

DOCTOR_EXE="$EXTRACTED_ROOT/bin/adobepy"
if [ ! -f "$DOCTOR_EXE" ]; then
    echo "error: adobepy not found at $DOCTOR_EXE"
    exit 1
fi

echo "Running adobepy doctor --json..."
if ! DOCTOR_OUTPUT="$(cd "$EXTRACTED_ROOT" && "$DOCTOR_EXE" doctor --json --python "$PYTHON")"; then
    echo "error: adobepy doctor exited unsuccessfully"
    exit 1
fi
printf '%s\n' "$DOCTOR_OUTPUT" | "$PYTHON" -I "$SCRIPT_DIR/check_package_doctor.py"

echo "Install smoke test passed"
