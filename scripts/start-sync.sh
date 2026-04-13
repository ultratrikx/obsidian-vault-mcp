#!/usr/bin/env bash
# Start obsidian-headless continuous sync in a dedicated tmux session.
# Usage: ./scripts/start-sync.sh [vault-local-path]
#
# Prerequisites:
#   npm install -g obsidian-headless
#   ob login           (run once, interactively)
#   ob sync-setup <local-path>   (run once to link to your remote vault)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if present
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

VAULT_PATH="${VAULT_PATH:-$HOME/vault}"
SESSION="obsidian-sync"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already running. Attaching output:"
  tmux capture-pane -t "$SESSION" -p | tail -20
  exit 0
fi

echo "Starting obsidian-headless continuous sync..."
echo "  Vault: $VAULT_PATH"
echo "  Session: $SESSION"

mkdir -p "$VAULT_PATH"

tmux new-session -d -s "$SESSION" \
  "ob sync '$VAULT_PATH' --continuous 2>&1 | tee -a '$ROOT_DIR/sync.log'"

echo "Started. Check output with:"
echo "  tmux attach -t $SESSION"
echo "  tail -f $ROOT_DIR/sync.log"
