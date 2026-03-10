#!/usr/bin/env python3
import os, time
import RPi.GPIO as GPIO

BUTTON_PIN = 11  # BOARD pin 11 (Whisplay KEY)
BOUNCE_MS = int(os.environ.get("POCKETAGENT_PTT_DEBOUNCE_MS", "400"))
ACTIVE_LOW = os.environ.get("POCKETAGENT_PTT_ACTIVE_LOW", "false").lower() == "true"
MIN_HOLD_MS = int(os.environ.get("POCKETAGENT_PTT_MIN_HOLD_MS", "1500"))

GPIO.setmode(GPIO.BOARD)
GPIO.setwarnings(False)
GPIO.setup(BUTTON_PIN, GPIO.IN, pull_up_down=GPIO.PUD_UP)

def pressed(level: int) -> bool:
    return (level == GPIO.LOW) if ACTIVE_LOW else (level == GPIO.HIGH)

time.sleep(0.2)
last = pressed(GPIO.input(BUTTON_PIN))
press_ts = None

print("ready", flush=True)

try:
    while True:
        GPIO.wait_for_edge(BUTTON_PIN, GPIO.BOTH, bouncetime=BOUNCE_MS)
        time.sleep(0.02)
        now = pressed(GPIO.input(BUTTON_PIN))
        if now == last:
            continue

        if now:
            press_ts = time.time()
            print("press", flush=True)
        else:
            if press_ts is not None:
                elapsed = (time.time() - press_ts) * 1000.0
                remain = MIN_HOLD_MS - elapsed
                if remain > 0:
                    time.sleep(remain / 1000.0)
            print("release", flush=True)
            press_ts = None

        last = now
finally:
    GPIO.cleanup()
