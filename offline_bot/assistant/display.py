from __future__ import annotations

import os
import requests


DISPLAY_HOST = os.environ.get("POCKETAGENT_DISPLAY_HOST", "127.0.0.1")
DISPLAY_PORT = int(os.environ.get("POCKETAGENT_DISPLAY_PORT", "3782"))


def update_display(patch: dict):
    mode = (os.environ.get("POCKETAGENT_DISPLAY_MODE", "auto") or "auto").lower()
    if mode == "off":
        return

    url = f"http://{DISPLAY_HOST}:{DISPLAY_PORT}/update"
    try:
        requests.post(url, json=patch, timeout=1.5)
    except Exception:
        pass
