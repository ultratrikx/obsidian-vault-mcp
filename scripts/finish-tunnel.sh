#!/usr/bin/env bash
set -euo pipefail

mkdir -p /etc/cloudflared

tee /etc/cloudflared/config.yml > /dev/null <<'EOF'
tunnel: acc894e0-1167-4f68-b8d1-30fe9ebe19f2
credentials-file: /home/clanker/.cloudflared/acc894e0-1167-4f68-b8d1-30fe9ebe19f2.json

ingress:
  - hostname: mcp.rohanthmaremservers.xyz
    service: http://localhost:3000
  - service: http_status:404
EOF

cloudflared service install
systemctl enable cloudflared
systemctl restart cloudflared
systemctl status cloudflared --no-pager

echo ""
echo "Test: curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer e4552ed742e42749ea26a574af0359a915a063106e70dfc14f8afdff21fb21ce' https://mcp.rohanthmaremservers.xyz/"
