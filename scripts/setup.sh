#!/usr/bin/env bash
# One-time setup: install deps, build, install obsidian-headless, guide through login.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== obsidian-vault-mcp setup ==="

# 1. Copy .env if missing
if [[ ! -f "$ROOT_DIR/.env" ]]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  echo "Created .env from .env.example — edit VAULT_PATH before continuing."
  echo "  nano $ROOT_DIR/.env"
  exit 1
fi

source "$ROOT_DIR/.env"

if [[ -z "${VAULT_PATH:-}" ]]; then
  echo "ERROR: Set VAULT_PATH in $ROOT_DIR/.env"
  exit 1
fi

# 2. Install project dependencies
echo ""
echo "Installing project dependencies..."
cd "$ROOT_DIR" && npm install

# 3. Build
echo ""
echo "Building TypeScript..."
npm run build

# 4. Install obsidian-headless globally
if ! command -v ob &>/dev/null; then
  echo ""
  echo "Installing obsidian-headless globally..."
  npm install -g obsidian-headless
fi

# 5. Login prompt
echo ""
echo "=== Obsidian Sync setup ==="
if ob sync-list-remote &>/dev/null 2>&1; then
  echo "Already logged in to Obsidian Sync."
else
  echo "Run the following to authenticate:"
  echo "  ob login"
fi

echo ""
echo "Once logged in, set up your vault sync:"
echo "  mkdir -p $VAULT_PATH"
echo "  ob sync-setup $VAULT_PATH"
echo ""
echo "Then start both services:"
echo "  ./scripts/start-sync.sh    # background sync"
echo "  ./scripts/start-mcp.sh     # MCP server"
echo ""
echo "=== Claude Desktop config snippet ==="
cat <<JSON
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["$ROOT_DIR/dist/server.js"],
      "env": {
        "VAULT_PATH": "$VAULT_PATH",
        "QMD_DB_PATH": "$ROOT_DIR/qmd-index/vault.db"
      }
    }
  }
}
JSON
