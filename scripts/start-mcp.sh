#!/usr/bin/env bash
# Start the MCP server in a tmux session.
# Pass --http to use HTTP transport instead of stdio.
# Usage:
#   ./scripts/start-mcp.sh          # stdio mode (for Claude Desktop / claude_desktop_config)
#   ./scripts/start-mcp.sh --http   # HTTP mode on $MCP_PORT (default 3000)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SESSION="obsidian-mcp"
HTTP_FLAG="${1:-}"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already running."
  tmux capture-pane -t "$SESSION" -p | tail -10
  exit 0
fi

# Build if dist/ is missing or source is newer
if [[ ! -f "$ROOT_DIR/dist/server.js" ]] || \
   [[ "$ROOT_DIR/src/server.ts" -nt "$ROOT_DIR/dist/server.js" ]]; then
  echo "Building..."
  cd "$ROOT_DIR" && npm run build
fi

echo "Starting MCP server (${HTTP_FLAG:-stdio} mode)..."
tmux new-session -d -s "$SESSION" \
  "cd '$ROOT_DIR' && node --env-file=.env dist/server.js $HTTP_FLAG 2>&1 | tee -a '$ROOT_DIR/mcp.log'"

echo "Started. Session: $SESSION"
echo "  tmux attach -t $SESSION"
echo "  tail -f $ROOT_DIR/mcp.log"
