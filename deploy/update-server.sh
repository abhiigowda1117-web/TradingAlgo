#!/bin/bash
# Nightly on the hosting server (algotrade-update.timer, 03:30 IST): back up the data folder,
# then update from GitHub and restart the website if anything changed. A running paper engine
# keeps running (it picks up the new version the next time it is started).
set -euo pipefail
APP_DIR=/opt/algotrade
APP_USER=algotrade
BRANCH="${BRANCH:-feature/web-platform-foundation}"
BACKUPS=/var/backups/algotrade
cd "$APP_DIR"

# Backup: accounts, research, paper portfolio, trades, settings. Keeps the last 14 nights.
install -d -m 700 "$BACKUPS"
tar -czf "$BACKUPS/algotrade-$(date +%Y%m%d).tar.gz" data .env
ls -1t "$BACKUPS"/algotrade-*.tar.gz | tail -n +15 | xargs -r rm -f

as_app() { runuser -u "$APP_USER" -- "$@"; }
as_app git fetch --quiet origin "$BRANCH"
if [ "$(as_app git rev-parse HEAD)" = "$(as_app git rev-parse "origin/$BRANCH")" ]; then
  echo "AlgoTrade is up to date ($(as_app git log -1 --format='%h %s'))."
  exit 0
fi
as_app git reset --hard --quiet "origin/$BRANCH"
as_app npm ci --no-audit --no-fund --loglevel=error
as_app npm ci --prefix web --no-audit --no-fund --loglevel=error
as_app npm run web:build --silent
systemctl restart algotrade.service
echo "Updated AlgoTrade to $(as_app git log -1 --format='%h %s (%cd)' --date=short)."
