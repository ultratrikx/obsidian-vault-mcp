#!/usr/bin/env bash
# Unified setup for obsidian-vault-mcp.
# Idempotent — safe to re-run at any time.
#
# Usage: sudo bash scripts/setup.sh
#
# What this does:
#   1. npm install + build
#   2. Install obsidian-headless (Obsidian Sync CLI)
#   3. Install + configure Cloudflare Tunnel (cloudflared)
#   4. Install systemd services for MCP server + Obsidian sync
#   5. Enable + start everything

set -euo pipefail

# Must run as root for systemd
if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/setup.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo clanker)}"
REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)

# ---------------------------------------------------------------------------
# Load .env
# ---------------------------------------------------------------------------
if [[ ! -f "$ROOT_DIR/.env" ]]; then
  echo "ERROR: $ROOT_DIR/.env not found."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$ROOT_DIR/.env"
set +a

if [[ -z "${VAULT_PATH:-}" ]]; then
  echo "ERROR: VAULT_PATH not set in .env"
  exit 1
fi

NODE_BIN=$(su - "$REAL_USER" -c 'command -v node' 2>/dev/null || true)
NPM_BIN=$(su - "$REAL_USER" -c 'command -v npm' 2>/dev/null || true)

if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found for user $REAL_USER"
  exit 1
fi

NODE_DIR=$(dirname "$NODE_BIN")
echo "Using node: $NODE_BIN"

# ---------------------------------------------------------------------------
# 1. Install deps + build
# ---------------------------------------------------------------------------
echo ""
echo "=== Installing dependencies ==="
su - "$REAL_USER" -c "cd '$ROOT_DIR' && npm install"
echo "=== Building ==="
su - "$REAL_USER" -c "cd '$ROOT_DIR' && npm run build"

# ---------------------------------------------------------------------------
# 2. Install obsidian-headless
# ---------------------------------------------------------------------------
echo ""
echo "=== obsidian-headless ==="
if ! su - "$REAL_USER" -c 'command -v ob' &>/dev/null; then
  su - "$REAL_USER" -c "npm install -g obsidian-headless"
  echo "Installed obsidian-headless."
else
  echo "obsidian-headless already installed."
fi

OB_BIN=$(su - "$REAL_USER" -c 'command -v ob')

# ---------------------------------------------------------------------------
# 3. Install cloudflared
# ---------------------------------------------------------------------------
echo ""
echo "=== cloudflared ==="
if ! command -v cloudflared &>/dev/null; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
    | tee /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && apt-get install -y cloudflared
  echo "cloudflared installed."
else
  echo "cloudflared already installed: $(cloudflared --version)"
fi

# ---------------------------------------------------------------------------
# 4. Cloudflare tunnel config
# ---------------------------------------------------------------------------
echo ""
echo "=== Cloudflare tunnel ==="
TUNNEL_NAME="obsidian-mcp"
DOMAIN="${DOMAIN:-mcp.rohanthmaremservers.xyz}"
MCP_PORT="${MCP_PORT:-3000}"

# Login if not already authenticated
if [[ ! -f "$REAL_HOME/.cloudflared/cert.pem" ]]; then
  echo "Not logged in to Cloudflare. Run this as $REAL_USER:"
  echo "  cloudflared tunnel login"
  echo "Then re-run this script."
  exit 1
fi

# Create tunnel if needed
if ! su - "$REAL_USER" -c "cloudflared tunnel list 2>/dev/null" | grep -q "$TUNNEL_NAME"; then
  su - "$REAL_USER" -c "cloudflared tunnel create $TUNNEL_NAME"
fi

TUNNEL_ID=$(su - "$REAL_USER" -c "cloudflared tunnel list --output json 2>/dev/null" \
  | python3 -c "import sys,json; ts=json.load(sys.stdin); print(next(t['id'] for t in ts if t['name']=='$TUNNEL_NAME'))")

# Write cloudflared config
mkdir -p /etc/cloudflared
tee /etc/cloudflared/config.yml > /dev/null <<YAML
tunnel: $TUNNEL_ID
credentials-file: $REAL_HOME/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $DOMAIN
    service: http://localhost:$MCP_PORT
  - service: http_status:404
YAML
echo "Cloudflared config written (tunnel: $TUNNEL_ID)"

# DNS CNAME
su - "$REAL_USER" -c "cloudflared tunnel route dns $TUNNEL_NAME $DOMAIN" 2>&1 \
  | grep -v "already exists" || true

# ---------------------------------------------------------------------------
# 5. Generate API_KEY if missing
# ---------------------------------------------------------------------------
if [[ -z "${API_KEY:-}" ]]; then
  API_KEY="$(openssl rand -hex 32)"
  if grep -q "^API_KEY=" "$ROOT_DIR/.env"; then
    sed -i "s|^API_KEY=.*|API_KEY=$API_KEY|" "$ROOT_DIR/.env"
  else
    echo "API_KEY=$API_KEY" >> "$ROOT_DIR/.env"
  fi
  echo "Generated API_KEY and saved to .env"
fi

# ---------------------------------------------------------------------------
# 6. systemd: cloudflared
# ---------------------------------------------------------------------------
echo ""
echo "=== systemd: cloudflared ==="
if ! systemctl is-active cloudflared &>/dev/null; then
  cloudflared service install
fi
systemctl enable cloudflared
systemctl restart cloudflared
echo "cloudflared: $(systemctl is-active cloudflared)"

# ---------------------------------------------------------------------------
# 7. systemd: obsidian-mcp
# ---------------------------------------------------------------------------
echo ""
echo "=== systemd: obsidian-mcp ==="
tee /etc/systemd/system/obsidian-mcp.service > /dev/null <<SERVICE
[Unit]
Description=Obsidian Vault MCP Server
After=network.target cloudflared.service

[Service]
User=$REAL_USER
WorkingDirectory=$ROOT_DIR
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN --env-file=.env dist/server.js --http
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable obsidian-mcp
systemctl restart obsidian-mcp
sleep 2
echo "obsidian-mcp: $(systemctl is-active obsidian-mcp)"

# ---------------------------------------------------------------------------
# 8. systemd: obsidian-sync (obsidian-headless continuous sync)
# ---------------------------------------------------------------------------
echo ""
echo "=== systemd: obsidian-sync ==="

mkdir -p "$VAULT_PATH"
chown "$REAL_USER":"$REAL_USER" "$VAULT_PATH"

tee /etc/systemd/system/obsidian-sync.service > /dev/null <<SERVICE
[Unit]
Description=Obsidian Vault Sync (obsidian-headless)
After=network.target

[Service]
User=$REAL_USER
WorkingDirectory=$VAULT_PATH
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
ExecStart=$OB_BIN sync --continuous
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable obsidian-sync
systemctl restart obsidian-sync
sleep 2

SYNC_STATUS=$(systemctl is-active obsidian-sync)
echo "obsidian-sync: $SYNC_STATUS"
if [[ "$SYNC_STATUS" != "active" ]]; then
  echo ""
  echo "  obsidian-sync failed to start. If ob is not yet authenticated, run:"
  echo "    su - $REAL_USER -c 'ob login'"
  echo "    su - $REAL_USER -c 'cd $VAULT_PATH && ob sync-setup'"
  echo "  Then: sudo systemctl start obsidian-sync"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "=============================="
echo " Setup complete"
echo "=============================="
echo ""
echo "Services:"
systemctl is-active obsidian-mcp    && echo "  ✓ obsidian-mcp" || echo "  ✗ obsidian-mcp (check: journalctl -u obsidian-mcp)"
systemctl is-active cloudflared     && echo "  ✓ cloudflared"  || echo "  ✗ cloudflared"
systemctl is-active obsidian-sync 2>/dev/null && echo "  ✓ obsidian-sync" || echo "  ✗ obsidian-sync (check: journalctl -u obsidian-sync)"
echo ""
echo "MCP endpoint: https://$DOMAIN"
echo ""
echo "MCP client config:"
echo "  URL: https://$DOMAIN/?token=$API_KEY"
echo ""
echo "Or with Authorization header:"
cat <<JSON
{
  "url": "https://$DOMAIN/?token=$API_KEY"
}
JSON
