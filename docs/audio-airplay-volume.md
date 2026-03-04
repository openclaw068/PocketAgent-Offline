# PocketAgent Audio: Lock assistant volume, phone-controlled AirPlay volume (Shairport Sync + WM8960)

Goal:
- **Assistant voice stays at a fixed, loud baseline** (set by ALSA mixer values you choose).
- **AirPlay volume is adjustable from the phone** (Shairport Sync uses **software volume**) without modifying the hardware mixer.

This resolves the common issue where AirPlay drags the ALSA `Playback` mixer down, causing the assistant to become quiet after AirPlay ends.

## Summary of the working configuration

### 1) Shairport Sync: software volume + no hardware mixer
Edit `/etc/shairport-sync.conf`:

In the `general` block:
```conf
volume_control = "software";
```

In the `alsa` block:
```conf
output_device = "plughw:1,0";   # adjust to your card/device
mixer_control_name = "none";
```

### 2) Remove any hooks that reset volume after AirPlay ends
If you have something like this in `/etc/shairport-sync.conf`, **comment it out**:
```conf
# run_this_after_play_ends = "/usr/local/bin/set-baseline-volume.sh";
```

Also check systemd overrides:
- `systemctl status shairport-sync` might show `ExecStartPre=/usr/local/bin/set-baseline-volume.sh`
- That means there is a drop-in override at `/etc/systemd/system/shairport-sync.service.d/override.conf`

Remove the `ExecStartPre=...set-baseline-volume.sh` line (or delete the override entirely).

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl restart shairport-sync
```

### 3) Lock in the assistant baseline volume (ALSA)
Once you find a baseline you like, persist it:
```bash
sudo alsactl store -f /var/lib/alsa/asound.state
sudo systemctl enable --now alsa-restore.service
```

Example baseline used during debugging (adjust to taste):
```bash
amixer -c 1 sset 'PCM Playback -6dB' on
amixer -c 1 sset 'Playback' 230
amixer -c 1 sset 'Speaker' 100%
amixer -c 1 sset 'Headphone' 100%
```

## Verification checklist

### A) Confirm AirPlay no longer changes the mixer
While AirPlay is playing, change the phone volume and confirm this stays constant:
```bash
amixer -c 1 sget 'Playback'
```

### B) Confirm no post-AirPlay hook is firing
```bash
sudo journalctl -t pocketagent-volume -n 50 --no-pager
sudo journalctl -u shairport-sync -n 80 --no-pager
```
You should not see repeated "Resetting baseline volume to 71%" messages.

## Notes / gotchas

- `plughw:1,0` is fine for `output_device`, but using `plughw` for a **control** device can cause warnings like:
  `ALSA ... Invalid CTL plughw:1,0`
  Since we set `mixer_control_name = "none"`, Shairport should not need a control device.

- A slight click/tick at start of playback can be normal on some DAC/amp setups (standby/unmute transient). If it’s annoying, consider:
  ```conf
  disable_standby_mode = "always";
  ```
  in the `alsa` block.
