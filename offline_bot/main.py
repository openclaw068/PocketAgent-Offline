#!/usr/bin/env python3
"""PocketAgent Offline (button-only) main loop.

Offline pipeline:
- PTT/button triggers a turn
- Record WAV via arecord
- STT via whisper.cpp
- Reflex brain first; else LLM JSON intent via llama.cpp
- Execute reminders/memory actions (SQLite)
- TTS via Piper -> play via aplay
- Update Whisplay display sidecar via HTTP

NOTE: This is a first working slice meant to be robust and hackable.
"""

from __future__ import annotations

import os
import time

import yaml

from .assistant.display import update_display
from .assistant.intent_llm import build_intent_prompt
from .database.db import connect, init_db
from .intent.reflex import classify
from .llm.llamacpp import run_json_intent
from .memory.store import MemoryStore
from .reminders.engine import QuietHours, ReminderEngine, parse_relative_time
from .audio.record import record_to_wav
from .audio.play import play_wav
from .speech.whispercpp import transcribe_wav
from .speech.piper_tts import tts_to_wav


def load_settings(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def main():
    settings_path = os.environ.get("POCKETAGENT_OFFLINE_SETTINGS", "offline_bot/config/settings.example.yaml")
    s = load_settings(settings_path)

    db_path = s["storage"]["sqlite_path"]
    con = connect(db_path)
    init_db(con, os.path.join(os.path.dirname(__file__), "database", "schema.sql"))

    mem = MemoryStore(con)

    # Reminders fire callback
    def on_fire(r: dict, kind: str):
        # Show + speak reminder
        update_display({"status": "speaking", "line1": "Reminder", "line2": r.get("text", "")[:160]})
        speak(f"Reminder: {r.get('text','')}. Did you do it?")

    engine = ReminderEngine(con, on_fire=on_fire)
    engine.start()

    # Audio/STT/TTS config
    recording_device = os.environ.get("POCKETAGENT_RECORDING_DEVICE", "plughw:1,0")
    playback_device = os.environ.get("POCKETAGENT_PLAYBACK_DEVICE", "plughw:1,0")

    whisper_bin = s["stt"]["whispercpp_bin"]
    whisper_model = s["stt"]["model"]

    piper_bin = s["tts"]["piper_bin"]
    piper_voice = s["tts"]["voice"]
    tts_speed = float(os.environ.get("POCKETAGENT_TTS_SPEED", s["tts"].get("speed", 1.0)))

    llama_bin = s["llm"]["llama_bin"]
    llama_model = s["llm"]["model"]

    data_dir = os.path.dirname(db_path)
    os.makedirs(data_dir, exist_ok=True)

    def speak(text: str):
        update_display({"status": "speaking", "line1": "PocketAgent", "line2": (text or "")[:160]})
        out_wav = os.path.join(data_dir, "tts.wav")
        tts_to_wav(piper_bin=piper_bin, voice_path=piper_voice, text=text, out_wav_path=out_wav, speed=tts_speed)
        play_wav(wav_path=out_wav, device=playback_device)
        update_display({"status": "idle", "line1": "PocketAgent", "line2": ""})

    # Very simple turn trigger for now:
    # Create a file /tmp/pocketagent-ptt.abort to stop recording.
    # In real deployment we will have a GPIO watcher create/remove this file.
    print("[offline] ready. (dev trigger) Touch /tmp/pocketagent.turn to take a turn.")

    while True:
        if os.path.exists("/tmp/pocketagent.turn"):
            try:
                os.unlink("/tmp/pocketagent.turn")
            except Exception:
                pass

            update_display({"status": "listening", "line1": "PocketAgent", "line2": "Listening…"})

            wav_path = os.path.join(data_dir, f"input-{int(time.time()*1000)}.wav")
            abort_flag = "/tmp/pocketagent-ptt.abort"
            rr = record_to_wav(out_path=wav_path, device=recording_device, sample_rate_hz=16000, channels=1, seconds_max=8, abort_flag_path=abort_flag)

            update_display({"status": "transcribing", "line1": "You", "line2": "Transcribing…"})
            text = transcribe_wav(whispercpp_bin=whisper_bin, model_path=whisper_model, wav_path=wav_path, language=s["stt"].get("language", "en"))
            text = (text or "").strip()
            print("[offline] heard:", text)

            # Reflex brain
            r = classify(text)
            if r:
                if r["intent"] == "ack_latest":
                    open_rs = engine.list_open()
                    if open_rs:
                        engine.ack(open_rs[0]["id"])
                        speak("Done — I’ll mark it complete.")
                    else:
                        speak("You don’t have any open reminders.")
                    continue
                if r["intent"] == "list_reminders":
                    open_rs = engine.list_open()
                    if not open_rs:
                        speak("You have no reminders.")
                    else:
                        speak("Here are your open reminders: " + ", ".join([x["text"] for x in open_rs[:5]]))
                    continue
                if r["intent"] == "delete_latest":
                    all_rs = engine.list_all()
                    if all_rs:
                        engine.delete(all_rs[0]["id"])
                        speak("Okay — deleted.")
                    else:
                        speak("You don’t have any reminders.")
                    continue
                if r["intent"] == "remember":
                    mid = mem.remember(text)
                    speak("Got it — I’ll remember that.")
                    continue
                if r["intent"] == "recall":
                    hits = mem.search(text, limit=3)
                    if not hits:
                        speak("I don’t have anything saved for that.")
                    else:
                        speak("Here’s what I remember: " + " ".join([h["text"] for h in hits]))
                    continue

            # Thinking brain
            update_display({"status": "thinking", "line1": "PocketAgent", "line2": "Thinking…"})
            prompt = build_intent_prompt(text)
            intent = run_json_intent(llama_bin=llama_bin, model_path=llama_model, prompt=prompt, temperature=float(s["llm"].get("temperature", 0.1)), ctx=int(s["llm"].get("context", 2048)))
            print("[offline] intent:", intent)

            it = (intent.get("intent") or "unknown")

            if it == "create_reminder":
                reminder_text = (intent.get("reminderText") or text).strip()
                time_text = (intent.get("timeText") or "").strip()
                due_at = parse_relative_time(time_text) or None
                if not due_at:
                    # fallback: if model didn't give a usable time, ask user
                    speak("When should I remind you?")
                    continue
                follow = intent.get("followupEveryMin")
                follow = int(follow) if follow is not None else int(s["reminders"].get("default_followup_minutes", 5))
                qh = s.get("reminders", {}).get("quiet_hours", {"start": 23, "end": 7})
                rid = engine.add(text=reminder_text, due_at_iso=due_at, followup_every_min=follow, quiet=QuietHours(int(qh.get("start", 23)), int(qh.get("end", 7))))
                speak("Perfect — saved.")
                continue

            if it == "list_reminders":
                open_rs = engine.list_open()
                if not open_rs:
                    speak("You have no reminders.")
                else:
                    speak("Here are your open reminders: " + ", ".join([x["text"] for x in open_rs[:5]]))
                continue

            if it == "ack_latest":
                open_rs = engine.list_open()
                if open_rs:
                    engine.ack(open_rs[0]["id"])
                    speak("Done.")
                else:
                    speak("No open reminders.")
                continue

            if it == "delete_reminder":
                all_rs = engine.list_all()
                if all_rs:
                    engine.delete(all_rs[0]["id"])
                    speak("Deleted.")
                else:
                    speak("No reminders.")
                continue

            if it == "remember":
                mem_text = (intent.get("memoryText") or text).strip()
                mem.remember(mem_text)
                speak("Got it.")
                continue

            if it == "recall":
                q = (intent.get("recallQuery") or text).strip()
                hits = mem.search(q, limit=3)
                if not hits:
                    speak("I don’t have anything saved for that.")
                else:
                    speak("Here’s what I remember: " + " ".join([h["text"] for h in hits]))
                continue

            speak("Okay.")

        time.sleep(0.1)


if __name__ == "__main__":
    main()
