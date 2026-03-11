from __future__ import annotations

import json


def build_intent_prompt(user_text: str) -> str:
    schema = {
        "intent": [
            "create_reminder",
            "update_reminder",
            "delete_reminder",
            "list_reminders",
            "ack_latest",
            "remember",
            "recall",
            "unknown",
        ],
        "reminderText": "string|null",
        "timeText": "string|null",
        "followupEveryMin": "number|null",
        "target": "latest|by_text|null",
        "targetText": "string|null",
        "memoryText": "string|null",
        "recallQuery": "string|null",
    }

    sys = (
        "You are an offline assistant for reminders. "
        "Return ONLY valid JSON (no markdown). "
        "If the user says 'remind me' or 'set a reminder' -> create_reminder. "
        "Time phrases can be absolute (7am, tomorrow 7am) or relative (in 10 minutes). "
        "If the user wants repeats until done, set followupEveryMin when specified, otherwise null. "
        "For delete/update: if only one open reminder, target=latest; else use by_text with targetText. "
        "For 'remember that ...' -> remember with memoryText. "
        "For 'what did I tell you about ...' -> recall with recallQuery. "
    )

    user = {"text": user_text, "schema": schema}
    return sys + "\nUser: " + json.dumps(user)
