#!/usr/bin/env bash
set -euo pipefail

# PocketAgent installer for Raspberry Pi OS
# Usage: sudo bash scripts/install_pi.sh

APP_DIR="/opt/pocketagent"
USER_NAME="pi"
REPO_URL="${POCKETAGENT_REPO_URL:-https://github.com/openclaw068/PocketAgent.git}"

apt-get update
apt-get install -y --no-install-recommends \
  git \
  ca-certificates \
  alsa-utils \
  gpiod \
  libgpiod2

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
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

npm ci || npm install

mkdir -p "$APP_DIR/data"

# Sanity checks: required CLI tools
for bin in node npm arecord aplay alsamixer gpiomon; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Missing required tool: $bin"
    echo "Fix: sudo apt-get update && sudo apt-get install -y alsa-utils gpiod"
    exit 1
  fi
done

# Ensure service user can access audio + gpio
usermod -aG audio,gpio "$USER_NAME" || true

# Lock down env file location for secrets (user should add OPENAI_API_KEY here)
touch /etc/default/pocketagent
chown root:root /etc/default/pocketagent
chmod 600 /etc/default/pocketagent

chown -R "$USER_NAME":"$USER_NAME" "$APP_DIR"

# systemd
cp -f systemd/pocketagent.service /etc/systemd/system/pocketagent.service
systemctl daemon-reload
systemctl enable pocketagent

echo "\nInstall complete. Next:"
echo "1) Create /etc/default/pocketagent with OPENAI_API_KEY=..."
echo "2) sudo systemctl start pocketagent"
echo "3) sudo journalctl -u pocketagent -f"
