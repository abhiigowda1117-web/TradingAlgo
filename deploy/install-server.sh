#!/bin/bash
# AlgoTrade: one-time installer for a fresh Ubuntu 22.04 / 24.04 cloud server
# (Oracle Cloud Always Free, AWS Lightsail, DigitalOcean, Google Cloud...).
#
# The easiest way: when creating the server, paste deploy/cloud-init.txt (with your own SETUP_CODE)
# into the "cloud-init" / "user data" / "launch script" box. Or, on the server:
#   curl -fsSL https://raw.githubusercontent.com/abhiigowda1117-web/TradingAlgo/feature/web-platform-foundation/deploy/install-server.sh | sudo SETUP_CODE='your secret phrase' bash
#
# What it does: installs Node.js 22, Caddy (automatic HTTPS) and AlgoTrade; runs the website as a
# service that restarts by itself; opens only ports 80/443; updates from GitHub every night at 03:30 IST;
# backs up the data folder every night. PAPER TRADING ONLY: it never enables live trading.
#
# Settings (environment variables):
#   SETUP_CODE  required, at least 12 characters: you type it in the browser to create the first account
#   DOMAIN      optional, e.g. algotrade.example.in (its DNS must point at this server).
#               Empty: a free address <your-ip>.sslip.io is used.
set -euo pipefail

REPO="${REPO:-https://github.com/abhiigowda1117-web/TradingAlgo.git}"
BRANCH="${BRANCH:-feature/web-platform-foundation}"
APP_DIR=/opt/algotrade
APP_USER=algotrade
SETUP_CODE="${SETUP_CODE:-}"
DOMAIN="${DOMAIN:-}"

log() { echo "[algotrade-install] $*"; }
die() { echo "[algotrade-install] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)."
grep -qi ubuntu /etc/os-release || die "this installer supports Ubuntu 22.04 or 24.04 only."
if [ ${#SETUP_CODE} -lt 12 ] || [[ "${SETUP_CODE,,}" == *change-this* ]] || [[ ! "$SETUP_CODE" =~ ^[A-Za-z0-9._@#%+=:,!-]+$ ]]; then
  die "set SETUP_CODE to your own secret phrase: at least 12 characters of letters, digits and . _ - @ # % + = : , ! (no spaces or quotes)."
fi
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- address
if [ -z "$DOMAIN" ]; then
  IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://ifconfig.me)"
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not find this server's public IP address; set DOMAIN."
  DOMAIN="${IP//./-}.sslip.io"
fi
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "DOMAIN '$DOMAIN' is not a valid host name."
log "Website address will be https://$DOMAIN"

# ---------------------------------------------------------------- memory (small free servers)
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 1900000 ] && ! swapon --show | grep -q .; then
  log "Adding 2 GB of swap (the server has little memory)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- packages
log "Installing Node.js 22, git and Caddy"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# ---------------------------------------------------------------- app
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$APP_USER --shell /usr/sbin/nologin "$APP_USER"
if [ ! -d "$APP_DIR/.git" ]; then
  log "Downloading AlgoTrade"
  install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
  runuser -u "$APP_USER" -- git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

if [ ! -f .env ]; then
  log "Writing settings (.env): production, HTTPS, paper trading"
  runuser -u "$APP_USER" -- cp .env.example .env
  set_env() { # key value: replace the line or append it
    if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
  }
  set_env TRADING_MODE paper
  set_env NODE_ENV production
  set_env HOST 127.0.0.1
  set_env PORT 3001
  set_env COOKIE_SECURE true
  set_env TRUST_PROXY true
  set_env APP_ORIGIN "https://$DOMAIN"
  printf "SETUP_CODE='%s'\n" "$SETUP_CODE" >> .env
fi
chown "$APP_USER:$APP_USER" .env && chmod 600 .env

log "Installing and building (a few minutes)"
runuser -u "$APP_USER" -- npm ci --no-audit --no-fund --loglevel=error
runuser -u "$APP_USER" -- npm ci --prefix web --no-audit --no-fund --loglevel=error
runuser -u "$APP_USER" -- npm run web:build --silent
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/data" "$APP_DIR/reports" "$APP_DIR/logs"

# ---------------------------------------------------------------- services
cat > /etc/systemd/system/algotrade.service <<EOF
[Unit]
Description=AlgoTrade website (paper trading)
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=TZ=Asia/Kolkata
ExecStart=/usr/bin/node $APP_DIR/node_modules/tsx/dist/cli.mjs src/server/index.ts
Restart=always
RestartSec=5
# Restarting the website (e.g. after an update) leaves a running paper engine alone.
KillMode=process
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/algotrade-update.service <<EOF
[Unit]
Description=AlgoTrade nightly update and backup

[Service]
Type=oneshot
ExecStart=/bin/bash $APP_DIR/deploy/update-server.sh
EOF

cat > /etc/systemd/system/algotrade-update.timer <<'EOF'
[Unit]
Description=AlgoTrade nightly update (03:30 IST, market closed)

[Timer]
OnCalendar=*-*-* 22:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3001
}
EOF

# ---------------------------------------------------------------- firewall: only SSH, HTTP and HTTPS
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp && ufw allow 443/tcp
fi
# Oracle Cloud's Ubuntu images block everything but SSH with iptables rules.
if iptables -S INPUT 2>/dev/null | grep -q -- "-j REJECT"; then
  for p in 443 80; do
    iptables -C INPUT -p tcp -m state --state NEW --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp -m state --state NEW --dport $p -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || true
fi

systemctl daemon-reload
systemctl enable --now algotrade.service
systemctl enable --now algotrade-update.timer
systemctl restart caddy

for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:3001/api/health >/dev/null || die "the website did not start: see 'journalctl -u algotrade -n 50'."

cat <<EOF

=====================================================================
 AlgoTrade is installed (paper trading).

 Open:  https://$DOMAIN
 (The HTTPS certificate can take a minute or two the first time.)

 First visit: create your account with the SETUP_CODE you chose.
 After that the setup code no longer works for anyone.
=====================================================================
EOF
echo "https://$DOMAIN" > "$APP_DIR/data/site-address.txt"
