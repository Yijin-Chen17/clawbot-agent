#!/usr/bin/env bash
TARGET="/home/calcury/app/clawbot-agent/scripts/update-and-restart.sh"
if [ -x "$TARGET" ]; then
    exec "$TARGET" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "${SCRIPT_DIR}/scripts/update-and-restart.sh" "$@"
