from __future__ import annotations

import uuid
from datetime import datetime, timezone

from ..database.db import tx


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


class MemoryStore:
    def __init__(self, con):
        self.con = con

    def remember(self, text: str, tags: str | None = None) -> str:
        mid = uuid.uuid4().hex
        with tx(self.con) as cur:
            cur.execute(
                "INSERT INTO memory_notes(id, created_at_iso, text, tags) VALUES(?,?,?,?)",
                (mid, now_iso(), text, tags),
            )
        return mid

    def search(self, query: str, limit: int = 5):
        q = (query or '').strip()
        if not q:
            return []
        with tx(self.con) as cur:
            rows = cur.execute(
                "SELECT id, created_at_iso, text FROM memory_notes_fts WHERE memory_notes_fts MATCH ? LIMIT ?",
                (q, limit),
            ).fetchall()
        return [dict(r) for r in rows]
