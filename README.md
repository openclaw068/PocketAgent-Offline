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
- **Button is currently simulated by pressing ENTER** (GPIO wiring next)

## Requirements
- Raspberry Pi OS
- Node.js 20+ recommended
- `alsa-utils`
- `OPENAI_API_KEY` set

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
sudo systemctl start pocketagent
sudo journalctl -u pocketagent -f
```

## Notes on Piper (offline TTS)
Piper can be great on a Pi 4/5, but on a **Pi Zero 2W** it’s usually borderline for latency and voice quality depending on the model and settings. For v0.1 we default to OpenAI TTS for reliability; we can add a Piper option later and benchmark.
