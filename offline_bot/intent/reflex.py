from __future__ import annotations

import re


def classify(text: str) -> dict | None:
    t = (text or '').strip().lower()
    if not t:
        return None

    if re.search(r"\b(done|did it|i did it|completed|finish(ed)?)\b", t):
        return {"intent": "ack_latest"}

    if re.search(r"\b(list|what)(\s+are|\s+my)?\s+reminders\b", t) or "do i have any reminders" in t:
        return {"intent": "list_reminders"}

    if re.search(r"\b(delete|remove|cancel)\b", t) and "reminder" in t:
        # minimal; LLM can do better later
        return {"intent": "delete_latest"}

    if t.startswith("remember that") or t.startswith("remember "):
        return {"intent": "remember", "text": text}

    if t.startswith("what did i tell you") or t.startswith("what do you remember"):
        return {"intent": "recall", "query": text}

    return None
