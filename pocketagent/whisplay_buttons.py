#!/usr/bin/env python3
import os, sys, time

DRIVER_PATH = os.environ.get("WHISPLAY_DRIVER_PATH", "/opt/Whisplay/Driver")
sys.path.insert(0, DRIVER_PATH)

# PiSugar driver file is WhisPlay.py (capital P)
from WhisPlay import WhisPlay  # type: ignore

# Which button to treat as PTT:
# "KEY" (per docs: KEY = physical pin 11, but driver may expose as a named button)
PTT_BUTTON = os.environ.get("POCKETAGENT_WHISPLAY_PTT_BUTTON", "KEY")

wp = WhisPlay()

# Heuristic: driver usually provides some method to read keys.
# We'll try a few common patterns and fall back with a clear error.
def get_pressed():
    # Return a set of pressed button names
    for attr in ("get_key", "getKey", "read_key", "readKey", "key", "Key"):
        if hasattr(wp, attr):
            fn = getattr(wp, attr)
            try:
                v = fn()
                # normalize common return shapes
                if v is None:
                    return set()
                if isinstance(v, str):
                    return {v} if v else set()
                if isinstance(v, (list, tuple, set)):
                    return set([str(x) for x in v if str(x)])
                if isinstance(v, dict):
                    return set([k for k,val in v.items() if val])
                # int/bitmask
                return {str(v)}
            except Exception:
                pass

    # Some drivers expose a "button" object or similar
    for attr in ("buttons", "button"):
        if hasattr(wp, attr):
            obj = getattr(wp, attr)
            # Try callable
            if callable(obj):
                try:
                    v = obj()
                    if isinstance(v, (list, tuple, set)):
                        return set([str(x) for x in v if str(x)])
                except Exception:
                    pass

    raise RuntimeError("Whisplay driver API for buttons not found. We need to inspect /opt/Whisplay/Driver/WhisPlay.py to wire it correctly.")

last = False
print("ready", flush=True)

while True:
    pressed = get_pressed()
    now = (PTT_BUTTON in pressed) or ("1" in pressed and PTT_BUTTON == "1")
    if now and not last:
        print("press", flush=True)
    if (not now) and last:
        print("release", flush=True)
    last = now
    time.sleep(0.02)
