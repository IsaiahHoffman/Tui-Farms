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

# Everything else happens on the server (scripts/deploy-direct-remote.sh).
ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" "APP_DIR='$APP_DIR' bash -s" < scripts/deploy-direct-remote.sh
