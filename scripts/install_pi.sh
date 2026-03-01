#!/usr/bin/env bash
set -euo pipefail

# PocketAgent installer for Raspberry Pi OS
# Usage: sudo bash scripts/install_pi.sh

APP_DIR="/opt/pocketagent"
USER_NAME="pi"

apt-get update
apt-get install -y --no-install-recommends \
  git \
  ca-certificates \
  alsa-utils \
  gpiod

# Node.js: assume already installed OR install via NodeSource if needed.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node.js 20+ first (recommended), then re-run."
  exit 1
fi

mkdir -p "$APP_DIR"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull
else
  echo "Cloning repo into $APP_DIR"
  git clone . "$APP_DIR"
fi

cd "$APP_DIR"

npm ci || npm install

mkdir -p "$APP_DIR/data"
chown -R "$USER_NAME":"$USER_NAME" "$APP_DIR"

# systemd
cp -f systemd/pocketagent.service /etc/systemd/system/pocketagent.service
systemctl daemon-reload
systemctl enable pocketagent

echo "\nInstall complete. Next:"
echo "1) Create /etc/default/pocketagent with OPENAI_API_KEY=..."
echo "2) sudo systemctl start pocketagent"
echo "3) sudo journalctl -u pocketagent -f"
