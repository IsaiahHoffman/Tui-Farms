#!/usr/bin/env bash
# Deploy script for tui-farms.com — executed ON the EC2 instance by GitHub Actions
# (piped over SSH, so the version that runs is always the one from the pushed commit).
#
# Safe to re-run. The data/ directory is runtime state edited from the admin page,
# so it is backed up before the git sync and restored afterwards — the server's
# copy always wins over whatever is in the repo.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/Tui-Farms}"
cd "$APP_DIR"
echo "==> Deploying in $APP_DIR"

# This script arrives on bash's stdin ("bash -s"), so nothing below may read stdin —
# a git credential prompt would swallow the rest of the script and hang the deploy.
export GIT_TERMINAL_PROMPT=0

# Load nvm if present — non-interactive SSH sessions skip .bashrc, so node/npm/pm2
# installed through nvm would otherwise not be on PATH. (nvm.sh touches unset
# variables, so relax -u while sourcing it.)
export NVM_DIR="$HOME/.nvm"
set +u
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
set -u

# 1. Preserve runtime data (live inventory edited via the admin pages).
#    The committed data/*.example.* seeds are deliberately NOT backed up:
#    git owns those, and restoring yesterday's copy in step 3 would shadow a
#    freshly pushed update with a stale ghost.
BACKUP_DIR="$(mktemp -d)"
trap 'rm -rf "$BACKUP_DIR"' EXIT
if [ -d data ]; then
  cp -a data/. "$BACKUP_DIR"/
  rm -f "$BACKUP_DIR"/*.example.*
fi

# 2. Sync code to the pushed commit (discards any manual edits made on the server)
git fetch origin main </dev/null
LOCK_BEFORE="$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)"
git reset --hard origin/main
LOCK_AFTER="$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)"

# 3. Restore runtime data over anything git checked out or deleted.
#    The app runs as root, so files it wrote are root-owned and a plain cp by
#    this (non-root) user could not overwrite them; --remove-destination
#    unlinks first, which only needs write permission on the directory.
mkdir -p data
cp -a --remove-destination "$BACKUP_DIR"/. data/
# Ghost cleanup: whatever happened above, every git-tracked file under data/
# (the *.example.* seeds) must match the pushed commit exactly.
git checkout -- data/ 2>/dev/null || true

# Seed any missing runtime data file from its committed example:
# data/<name>.example.<ext> -> data/<name>.<ext>
# Exception: don't seed beefItems.json while the legacy beefItems.txt is
# present — the app migrates the LIVE txt inventory into JSON on startup,
# and that migration must win over the example seed.
shopt -s nullglob
for example in data/*.example.*; do
  real="${example/.example/}"
  if [ "$real" = "data/beefItems.json" ] && [ -f data/beefItems.txt ]; then
    continue
  fi
  if [ ! -f "$real" ]; then
    echo "==> Seeding $real from $example"
    cp "$example" "$real"
  fi
done
shopt -u nullglob

# The app (running as root) creates root-owned files in data/; hand ownership
# to the deploy user so the NEXT deploy can back them up and replace them
# without fighting permissions. Root doesn't care — it can write regardless.
sudo -n chown -R "$(id -un)": data 2>/dev/null || true

# On this server node/npm/pm2 live under ROOT's nvm (the app binds port 80 and
# runs as root), so fall back to sudo with root's nvm loaded when the SSH user
# has no tooling of its own.
as_root_with_node() {
  sudo -n bash -c 'export NVM_DIR=/root/.nvm; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null; '"$*"
}

# 4. Install dependencies only when needed
if [ ! -d node_modules ] || [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
  echo "==> Installing dependencies"
  if command -v npm >/dev/null 2>&1; then
    npm ci </dev/null
  else
    as_root_with_node "npm ci" </dev/null
  fi
fi

# 5. Restart the app: try this user's pm2 daemon first, then root's.
#    The app's secrets (ADMIN_PASSWORD, ...) live in /root/tui-farms.env;
#    sourcing it right before `pm2 restart --update-env` is what injects them
#    into the app's environment — without it a restart would wipe them.
ENV_SOURCE='[ -f /root/tui-farms.env ] && set -a && . /root/tui-farms.env && set +a'
if command -v pm2 >/dev/null 2>&1 && pm2 restart all --update-env; then
  :
else
  echo "==> Restarting via root's pm2"
  as_root_with_node "{ $ENV_SOURCE; } || true; pm2 restart all --update-env"
fi

echo "==> Deploy complete: now serving $(git rev-parse --short HEAD)"
