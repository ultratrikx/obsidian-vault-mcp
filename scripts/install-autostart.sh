#!/usr/bin/env bash
set -euo pipefail

tee /etc/systemd/system/obsidian-mcp.service > /dev/null <<'EOF'
[Unit]
Description=Obsidian Vault MCP Server
After=network.target

[Service]
User=clanker
WorkingDirectory=/home/clanker/obsidian_server
ExecStart=node --env-file=.env dist/server.js --http
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now obsidian-mcp
systemctl status obsidian-mcp --no-pager
