#!/usr/bin/env bash
# Server side of scripts/deploy-direct.sh — runs ON the EC2 box as the deploy
# user after /tmp/tui-farms.tgz has been copied up. Unpacks it over APP_DIR,
# installs dependencies when the lockfile changed, and restarts pm2 with the
# env files loaded. Runtime data/ is untouched: the archive only carries the
# committed data/*.example.* seeds, exactly like a git checkout would.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/Tui-Farms}"
cd "$APP_DIR"
echo "==> Unpacking into $APP_DIR"

LOCK_BEFORE="$(sha256sum package-lock.json 2>/dev/null | cut -c1-16 || echo none)"
tar xzf /tmp/tui-farms.tgz -C "$APP_DIR"
rm -f /tmp/tui-farms.tgz
LOCK_AFTER="$(sha256sum package-lock.json | cut -c1-16)"

# node/npm/pm2 live under ROOT's nvm on this server (the app binds port 80).
as_root_with_node() {
  sudo -n bash -c 'export NVM_DIR=/root/.nvm; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null; '"$*"
}

if [ ! -d node_modules ] || [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
  echo "==> Installing dependencies"
  as_root_with_node "cd '$APP_DIR' && npm ci --no-audit --no-fund" </dev/null
fi

# Secrets live in /root/tui-farms.env; non-secret extras (the DMS cloud
# pass-through hostnames) in the deploy user's ~/dms-proxy.env. Both are loaded
# right before the restart so --update-env carries them into the app.
ENV_SOURCE="[ -f /root/tui-farms.env ] && set -a && . /root/tui-farms.env && set +a; [ -f $HOME/dms-proxy.env ] && set -a && . $HOME/dms-proxy.env && set +a"
echo "==> Restarting the farm site via pm2"
as_root_with_node "{ $ENV_SOURCE; } || true; pm2 restart index --update-env"
sleep 2
echo "==> Farm site answers: HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1/)"
echo "==> Deploy complete"
