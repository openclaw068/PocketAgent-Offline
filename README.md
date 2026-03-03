# PocketAgent

Pocketable Raspberry Pi voice agent for Raspberry Pi Zero 2W:

- Hold-to-talk button → record mic → **Whisper** (OpenAI) → agent logic
- Agent replies through speaker (TTS)
- Reminders that repeat until you confirm “done”

## Status (v0.1)
This repo contains a working skeleton:
- Audio record/play via ALSA (`arecord` / `aplay`)
- Transcribe via OpenAI Audio Transcriptions
- TTS via OpenAI Audio Speech
- Local reminder scheduler with follow-ups
- After each spoken reminder, it listens briefly for a “yes/done” to auto-clear
- **Push-to-talk button supported via `gpiomon` (libgpiod)** (defaults to ULTRA++ button on GPIO23)

### Push-to-talk configuration
By default PocketAgent uses GPIO push-to-talk.
- `POCKETAGENT_PTT_MODE=gpio` (default)
- `POCKETAGENT_PTT_GPIO_LINE=23` (ULTRA++ button)
- `POCKETAGENT_GPIO_CHIP=gpiochip0`
- `POCKETAGENT_PTT_ACTIVE_LOW=true` (recommended for ULTRA++; button pin has an external pull-up)
- If you want dev mode: `POCKETAGENT_PTT_MODE=stdin` (press ENTER)

## Requirements
- Raspberry Pi OS (Bookworm recommended; tested target: Pi Zero 2 W + Raspberry Pi OS Lite 64-bit Bookworm)
- Node.js 20+ recommended
- `alsa-utils` (provides `arecord`, `aplay`, `alsamixer`)
- `gpiod` / libgpiod tools (provides `gpiomon`)
- `OPENAI_API_KEY` set

## ULTRA++ audio driver (wm8960)
On up-to-date Raspberry Pi OS, the ULTRA++ / WM8960 driver is often auto-detected.

If audio doesn’t show up in `aplay -l` / `arecord -l`, add the overlay and reboot:

- Edit (Bookworm): `/boot/firmware/config.txt`
- Add at the end:
  - `dtoverlay=wm8960-soundcard`

Then reboot and verify:
```bash
aplay -l
arecord -l
arecord -f cd -d5 test.wav
aplay test.wav
```

In `alsamixer`, press `F6` and select the WM8960 card to adjust volumes/inputs.

## Quick start (dev)
```bash
npm install
export OPENAI_API_KEY="..."
node pocketagent/index.js
# press ENTER to simulate a button press
```

## Install on Pi (systemd)
```bash
sudo bash scripts/install_pi.sh
sudo nano /etc/default/pocketagent   # add OPENAI_API_KEY=...

# Optional but commonly needed on WM8960/ULTRA++:
# POCKETAGENT_RECORDING_DEVICE=plughw:1,0
# POCKETAGENT_PLAYBACK_DEVICE=plughw:1,0

sudo systemctl start pocketagent
sudo journalctl -u pocketagent -f
```

### First-boot checklist (if something doesn’t work)
```bash
# 1) Verify the sound card exists
aplay -l
arecord -l

# 2) Verify capture/playback
arecord -f cd -d 5 test.wav
aplay test.wav

# 3) Verify the push-to-talk button emits edges
gpiomon --help | head
sudo gpiomon -n -F %E -s gpiochip0 23
```

## Notes on Piper (offline TTS)
Piper can be great on a Pi 4/5, but on a **Pi Zero 2W** it’s usually borderline for latency and voice quality depending on the model and settings. For v0.1 we default to OpenAI TTS for reliability; we can add a Piper option later and benchmark.
