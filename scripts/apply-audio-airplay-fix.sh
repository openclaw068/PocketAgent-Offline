#!/usr/bin/env bash
set -euo pipefail

# PocketAgent: Apply AirPlay/assistant volume separation fixes on a Raspberry Pi.
# - Shairport Sync uses software volume
# - Shairport Sync does NOT use the ALSA hardware mixer
# - Remove any post-play hooks that reset ALSA volume
# - Remove any systemd ExecStartPre baseline reset hook
# - Set and persist a loud baseline ALSA volume

CONF=/etc/shairport-sync.conf
DROPIN_DIR=/etc/systemd/system/shairport-sync.service.d
DROPIN_FILE="$DROPIN_DIR/override.conf"

need_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    echo "Please run as root (sudo)." >&2
    exit 1
  fi
}

patch_shairport_conf() {
  if [[ ! -f "$CONF" ]]; then
    echo "ERROR: $CONF not found" >&2
    exit 1
  fi

  # Ensure software volume (case-sensitive)
  if grep -qE '^[[:space:]]*volume_control[[:space:]]*=' "$CONF"; then
    sed -i -E 's/^[[:space:]]*volume_control[[:space:]]*=.*/volume_control = "software";/' "$CONF"
  else
    # Insert under general = { if possible
    sed -i -E '/^[[:space:]]*general[[:space:]]*=[[:space:]]*\{/a\
  volume_control = "software";\
' "$CONF" || true
  fi

  # Ensure mixer_control_name = "none" in alsa block
  if grep -qE '^[[:space:]]*mixer_control_name[[:space:]]*=' "$CONF"; then
    sed -i -E 's/^[[:space:]]*mixer_control_name[[:space:]]*=.*/mixer_control_name = "none";/' "$CONF"
  else
    sed -i -E '/^[[:space:]]*alsa[[:space:]]*=[[:space:]]*\{/a\
  mixer_control_name = "none";\
' "$CONF" || true
  fi

  # Comment out run_this_after_play_ends hook if present (avoid resetting ALSA)
  sed -i -E 's/^([[:space:]]*)run_this_after_play_ends[[:space:]]*=/#\1run_this_after_play_ends =/g' "$CONF"
}

remove_systemd_execstartpre_hook() {
  # If a drop-in exists and contains ExecStartPre that runs baseline volume script, remove it.
  if [[ -f "$DROPIN_FILE" ]]; then
    sed -i -E '/^[[:space:]]*ExecStartPre=.*set-baseline-volume\.sh[[:space:]]*$/d' "$DROPIN_FILE"

    # If the file is now empty or only has [Service], keep it (harmless) but ensure directory exists.
    true
  fi
}

restart_services() {
  systemctl daemon-reload
  systemctl restart shairport-sync
}

set_baseline_volume() {
  # Baseline from debugging session — adjust to taste.
  amixer -c 1 sset 'PCM Playback -6dB' on || true
  amixer -c 1 sset 'Playback' 230
  amixer -c 1 sset 'Speaker' 100%
  amixer -c 1 sset 'Headphone' 100%

  alsactl store -f /var/lib/alsa/asound.state
  systemctl enable --now alsa-restore.service >/dev/null 2>&1 || true
}

main() {
  need_root

  echo "Patching $CONF..."
  patch_shairport_conf

  echo "Removing systemd ExecStartPre baseline-volume hook (if present)..."
  remove_systemd_execstartpre_hook

  echo "Restarting shairport-sync..."
  restart_services

  echo "Setting and persisting ALSA baseline volume..."
  set_baseline_volume

  echo "Done. Quick checks:"
  echo "  systemctl status shairport-sync --no-pager | head"
  echo "  amixer -c 1 sget 'Playback'"
}

main "$@"
