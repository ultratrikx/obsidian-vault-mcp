#!/usr/bin/env bash
# Set up Caddy as a reverse proxy for the MCP server with bearer token auth.
#
# Prerequisites:
#   - A domain (e.g. mcp.yourdomain.com) with an A record pointing to this VPS
#   - DOMAIN and API_KEY set in .env
#   - MCP server running in HTTP mode (./scripts/start-mcp.sh --http)
#
# What this does:
#   1. Installs Caddy (if not already installed)
#   2. Generates API_KEY in .env if missing
#   3. Writes /etc/caddy/Caddyfile
#   4. Reloads Caddy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  echo "ERROR: .env not found. Run ./scripts/setup.sh first."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$ROOT_DIR/.env"
set +a

# ---------------------------------------------------------------------------
# Validate required vars
# ---------------------------------------------------------------------------
if [[ -z "${DOMAIN:-}" ]]; then
  echo "ERROR: DOMAIN is not set in .env (e.g. DOMAIN=mcp.yourdomain.com)"
  exit 1
fi

# Generate API_KEY if missing
if [[ -z "${API_KEY:-}" ]]; then
  API_KEY="$(openssl rand -hex 32)"
  # Write it into .env
  if grep -q "^API_KEY=" "$ROOT_DIR/.env"; then
    sed -i "s|^API_KEY=.*|API_KEY=$API_KEY|" "$ROOT_DIR/.env"
  else
    echo "API_KEY=$API_KEY" >> "$ROOT_DIR/.env"
  fi
  echo "Generated API_KEY and saved to .env"
fi

MCP_PORT="${MCP_PORT:-3000}"

# ---------------------------------------------------------------------------
# Install Caddy
# ---------------------------------------------------------------------------
if ! command -v caddy &>/dev/null; then
  echo "Installing Caddy..."
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
  sudo apt-get update && sudo apt-get install -y caddy
  echo "Caddy installed."
else
  echo "Caddy already installed: $(caddy version)"
fi

# ---------------------------------------------------------------------------
# Write Caddyfile
# ---------------------------------------------------------------------------
CADDYFILE="/etc/caddy/Caddyfile"
echo "Writing $CADDYFILE..."

sudo tee "$CADDYFILE" > /dev/null <<CADDY
$DOMAIN {
    @unauth {
        not header Authorization "Bearer $API_KEY"
    }
    respond @unauth 401

    reverse_proxy localhost:$MCP_PORT
}
CADDY

echo "Caddyfile written."

# ---------------------------------------------------------------------------
# Reload Caddy
# ---------------------------------------------------------------------------
sudo systemctl enable caddy
sudo systemctl reload-or-restart caddy
echo "Caddy reloaded."

# ---------------------------------------------------------------------------
# Print Claude Desktop config
# ---------------------------------------------------------------------------
cat <<EOF

=== Done ===

Your MCP server will be available at: https://$DOMAIN

Add this to your Claude Desktop config
(~/Library/Application Support/Claude/claude_desktop_config.json on Mac):

{
  "mcpServers": {
    "obsidian": {
      "url": "https://$DOMAIN/mcp",
      "headers": {
        "Authorization": "Bearer $API_KEY"
      }
    }
  }
}

Make sure the MCP server is running in HTTP mode:
  ./scripts/start-mcp.sh --http

Check Caddy logs if TLS provisioning fails (needs port 80/443 open):
  sudo journalctl -u caddy -f
EOF
