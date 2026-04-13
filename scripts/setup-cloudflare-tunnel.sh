#!/usr/bin/env bash
# Set up a Cloudflare Tunnel to expose the MCP server.
# No ports need to be open. Domain must be managed by Cloudflare DNS.
#
# Prerequisites:
#   - rohanthmaremservers.xyz managed in Cloudflare
#   - MCP server running: node --env-file=.env dist/server.js --http
#
# What this does:
#   1. Installs cloudflared
#   2. Authenticates with Cloudflare (opens browser link — paste it)
#   3. Creates a named tunnel: obsidian-mcp
#   4. Routes mcp.rohanthmaremservers.xyz → localhost:3000
#   5. Installs tunnel as a systemd service

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TUNNEL_NAME="obsidian-mcp"
DOMAIN="mcp.rohanthmaremservers.xyz"
MCP_PORT="${MCP_PORT:-3000}"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

# ---------------------------------------------------------------------------
# 1. Install cloudflared
# ---------------------------------------------------------------------------
if ! command -v cloudflared &>/dev/null; then
  echo "Installing cloudflared..."
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list
  sudo apt-get update && sudo apt-get install -y cloudflared
  echo "cloudflared installed."
else
  echo "cloudflared already installed: $(cloudflared --version)"
fi

# ---------------------------------------------------------------------------
# 2. Authenticate (opens a browser link — paste it if no browser)
# ---------------------------------------------------------------------------
if [[ ! -f ~/.cloudflared/cert.pem ]]; then
  echo ""
  echo "=== Cloudflare login ==="
  echo "A URL will appear below. Open it in a browser and authorise the tunnel."
  echo ""
  cloudflared tunnel login
fi

# ---------------------------------------------------------------------------
# 3. Create tunnel (idempotent — skips if already exists)
# ---------------------------------------------------------------------------
if ! cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
  echo "Creating tunnel: $TUNNEL_NAME"
  cloudflared tunnel create "$TUNNEL_NAME"
else
  echo "Tunnel '$TUNNEL_NAME' already exists."
fi

TUNNEL_ID=$(cloudflared tunnel list --output json 2>/dev/null \
  | python3 -c "import sys,json; ts=json.load(sys.stdin); print(next(t['id'] for t in ts if t['name']=='$TUNNEL_NAME'))")

echo "Tunnel ID: $TUNNEL_ID"

# ---------------------------------------------------------------------------
# 4. Write config
# ---------------------------------------------------------------------------
TUNNEL_CONFIG="$HOME/.cloudflared/config.yml"
cat > "$TUNNEL_CONFIG" <<YAML
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $DOMAIN
    service: http://localhost:$MCP_PORT
  - service: http_status:404
YAML

echo "Config written: $TUNNEL_CONFIG"

# ---------------------------------------------------------------------------
# 5. Create DNS CNAME record
# ---------------------------------------------------------------------------
echo "Creating DNS CNAME: $DOMAIN → $TUNNEL_ID.cfargotunnel.com"
cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" 2>&1 || \
  echo "(DNS record may already exist — continuing)"

# ---------------------------------------------------------------------------
# 6. Install as systemd service
# ---------------------------------------------------------------------------
echo "Installing as systemd service..."
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl restart cloudflared

echo ""
echo "=== Done ==="
echo ""
echo "Tunnel running: https://$DOMAIN"
echo ""
echo "Test it:"
echo "  curl -s -o /dev/null -w '%{http_code}' \\"
echo "    -H 'Authorization: Bearer ${API_KEY:-<your-api-key>}' \\"
echo "    https://$DOMAIN/"
echo ""
echo "Claude Desktop config (~/.config/claude/claude_desktop_config.json):"
cat <<JSON
{
  "mcpServers": {
    "obsidian": {
      "url": "https://$DOMAIN/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY:-<your-api-key>}"
      }
    }
  }
}
JSON
