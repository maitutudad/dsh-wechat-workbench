#!/usr/bin/env bash
# Create the Python venv used by the iLink transport child process.
# Usage: ./scripts/setup-python.sh [venv-dir]
set -euo pipefail
cd "$(dirname "$0")/.."

VENV="${1:-.venv}"
# Optional pip mirror (e.g. https://pypi.tuna.tsinghua.edu.cn/simple).
PIP_ARGS=()
if [ -n "${PIP_INDEX_URL:-}" ]; then
  PIP_ARGS=(-i "$PIP_INDEX_URL")
fi
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -q "${PIP_ARGS[@]}" -r python/requirements.txt

# Intel-mac (x86_64) Python 3.13 often lacks a cryptography wheel; fall back
# to the last release shipping one before giving up.
if ! "$VENV/bin/python" -c "import cryptography" 2>/dev/null; then
  echo "cryptography missing; pinning 44.0.0 (prebuilt wheel)..." >&2
  "$VENV/bin/pip" install -q "${PIP_ARGS[@]}" "cryptography==44.0.0" -r python/requirements.txt
fi

"$VENV/bin/python" -c "import wechat_agent_sdk, qrcode, cryptography; print('python env ready:', '$VENV')"
