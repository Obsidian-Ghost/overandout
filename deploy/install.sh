#!/usr/bin/env bash
# Install overandout-relay as a systemd service on a Linux host (Ubuntu/Debian tested).
# Usage (on the server, from the agent-relay checkout):  sudo bash deploy/install.sh [--domain relay.example.com]
set -euo pipefail

DOMAIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/overandout
DATA=/var/lib/overandout

echo "==> node"
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 24 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> files -> $APP"
id -u overandout >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin overandout
mkdir -p "$APP" "$DATA/contracts"
rsync -a --delete --exclude node_modules --exclude .overandout --exclude playground --exclude py "$SRC/" "$APP/"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
chown -R overandout:overandout "$APP" "$DATA"

echo "==> admin token"
if [[ ! -f "$DATA/admin.token" ]]; then
  umask 077; node -e 'process.stdout.write("ra_"+require("crypto").randomBytes(24).toString("base64url"))' > "$DATA/admin.token"
  chown overandout:overandout "$DATA/admin.token"
fi

echo "==> systemd"
install -m 644 "$SRC/deploy/overandout-relay.service" /etc/systemd/system/overandout-relay.service
systemctl daemon-reload
systemctl enable --now overandout-relay
sleep 1
systemctl --no-pager --lines=5 status overandout-relay || true

if [[ -n "$DOMAIN" ]]; then
  echo "==> caddy (HTTPS for $DOMAIN)"
  if ! command -v caddy >/dev/null; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update && apt-get install -y caddy
  fi
  sed "s/OVERANDOUT_DOMAIN/$DOMAIN/" "$SRC/deploy/Caddyfile" > /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
  URL="https://$DOMAIN"
else
  URL="http://$(hostname -I | awk '{print $1}'):7777"
  echo "NOTE: no --domain given; the relay is plain HTTP on :7777. Open that port in your firewall,"
  echo "      or re-run with --domain to get HTTPS via Caddy (recommended: tokens travel in headers)."
fi

cat <<MSG

overandout-relay is running.
  url          : $URL
  admin token  : $(cat "$DATA/admin.token")
  data         : $DATA  (overandout.db, contracts/, admin.token)
  logs         : journalctl -u overandout-relay -f

From your laptop:
  export OVERANDOUT_URL=$URL OVERANDOUT_ADMIN_TOKEN=$(cat "$DATA/admin.token")
  overandout-relay channel create api --roles DEV,OPS
  overandout-relay invite api DEV --url $URL
MSG
