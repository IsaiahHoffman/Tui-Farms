#!/usr/bin/env bash
# Deploy the farm site straight from this machine to the EC2 box and restart it.
# No GitHub round-trip: copies the committed tree over SSH, installs
# dependencies when the lockfile changed, restarts pm2 with the env files loaded.
#
#   bash scripts/deploy-direct.sh
#
# Runtime data (data/*.json edited from the admin pages) is never touched: the
# archive only carries the committed data/*.example.* seeds, exactly like git.
#
# NOTE: the GitHub Actions deploy (scripts/deploy.sh) resets the server to
# origin/main. Whatever is deployed this way must also reach GitHub before the
# next push, or that deploy will undo it.
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="${DEPLOY_KEY:-$HOME/.ssh/tui_farms_deploy}"
HOST="${DEPLOY_HOST:-54.161.203.239}"
DEPLOY_USER="${DEPLOY_USER:-ec2-user}"
APP_DIR="${APP_DIR:-/home/$DEPLOY_USER/Tui-Farms}"
TARGET="$DEPLOY_USER@$HOST"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
git archive --format=tar.gz -o "$TMP" HEAD

echo "==> Copying $(git rev-parse --short HEAD) to $TARGET:$APP_DIR"
scp -i "$KEY" -o BatchMode=yes -q "$TMP" "$TARGET:/tmp/tui-farms.tgz"

# Everything below runs on the server.
ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" "APP_DIR='$APP_DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"

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
REMOTE
