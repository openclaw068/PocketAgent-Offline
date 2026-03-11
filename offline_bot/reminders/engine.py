from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from ..database.db import tx


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_relative_time(text: str) -> Optional[str]:
    t = (text or "").strip().lower()
    # supports: in 5 minutes, in one minute, in an hour
    import re

    m = re.match(r"^in\s+(a|an|one|\d+)\s+(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)\b", t)
    if not m:
        return None
    n_raw, unit = m.group(1), m.group(2)
    n = 1 if n_raw in ("a", "an", "one") else int(n_raw)
    if unit.startswith(("hour", "hr")):
        delta = timedelta(hours=n)
    elif unit.startswith(("second", "sec")):
        delta = timedelta(seconds=n)
    else:
        delta = timedelta(minutes=n)
    due = datetime.now(timezone.utc) + delta
    return due.replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class QuietHours:
    start: int = 23
    end: int = 7


@dataclass
class Reminder:
    id: str
    text: str
    due_at_iso: str
    status: str


class ReminderEngine:
    """SQLite-backed reminders + polling scheduler.

    We keep it simple and robust:
    - one background thread checks for due reminders every second
    - followups are computed from last_notified_at + followup cadence
    """

    def __init__(self, con, *, on_fire: Callable[[dict, str], None], poll_secs: float = 1.0):
        self.con = con
        self.on_fire = on_fire
        self.poll_secs = poll_secs
        self._stop = threading.Event()
        self._t = None

    def start(self):
        if self._t and self._t.is_alive():
            return
        self._t = threading.Thread(target=self._loop, daemon=True)
        self._t.start()

    def stop(self):
        self._stop.set()

    def add(self, *, text: str, due_at_iso: str, followup_every_min: int = 5, followup_max_count=None, quiet: QuietHours = QuietHours()):
        rid = uuid.uuid4().hex
        with tx(self.con) as cur:
            cur.execute(
                """INSERT INTO reminders(id,text,due_at_iso,created_at_iso,status,followup_every_min,followup_max_count,followup_quiet_start,followup_quiet_end)
                VALUES(?,?,?,?, 'open', ?,?,?,?)""",
                (rid, text, due_at_iso, now_iso(), followup_every_min, followup_max_count, quiet.start, quiet.end),
            )
        return rid

    def list_all(self):
        with tx(self.con) as cur:
            rows = cur.execute("SELECT * FROM reminders ORDER BY created_at_iso DESC").fetchall()
        return [dict(r) for r in rows]

    def list_open(self):
        with tx(self.con) as cur:
            rows = cur.execute("SELECT * FROM reminders WHERE status='open' ORDER BY created_at_iso DESC").fetchall()
        return [dict(r) for r in rows]

    def ack(self, rid: str):
        with tx(self.con) as cur:
            cur.execute(
                "UPDATE reminders SET status='done', acknowledged_at_iso=?, followup_count=0 WHERE id=?",
                (now_iso(), rid),
            )

    def delete(self, rid: str):
        with tx(self.con) as cur:
            cur.execute("DELETE FROM reminders WHERE id=?", (rid,))

    def update(self, rid: str, patch: dict):
        allowed = {"text", "due_at_iso", "followup_every_min"}
        keys = [k for k in patch.keys() if k in allowed]
        if not keys:
            return
        sets = ",".join([f"{k}=?" for k in keys])
        vals = [patch[k] for k in keys]
        # reset followup counters when updated
        sets += ", followup_count=0, last_notified_at_iso=NULL"
        with tx(self.con) as cur:
            cur.execute(f"UPDATE reminders SET {sets} WHERE id=?", (*vals, rid))

    def _loop(self):
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception as e:
                print("[reminders] tick error:", e)
            time.sleep(self.poll_secs)

    def _in_quiet_hours(self, start: int, end: int, dt: datetime) -> bool:
        h = dt.hour
        if start == end:
            return False
        if start < end:
            return start <= h < end
        return h >= start or h < end

    def _tick(self):
        now = datetime.now(timezone.utc)
        now_ms = int(now.timestamp() * 1000)

        with tx(self.con) as cur:
            rows = cur.execute("SELECT * FROM reminders WHERE status='open'").fetchall()

        for r in rows:
            due_ms = int(datetime.fromisoformat(r["due_at_iso"].replace("Z", "+00:00")).timestamp() * 1000)
            last = r["last_notified_at_iso"]
            if last:
                last_ms = int(datetime.fromisoformat(last.replace("Z", "+00:00")).timestamp() * 1000)
            else:
                last_ms = None

            follow_every = r["followup_every_min"]
            follow_count = r["followup_count"]
            follow_max = r["followup_max_count"]
            qstart, qend = int(r["followup_quiet_start"]), int(r["followup_quiet_end"])

            # first fire
            if last_ms is None and now_ms >= due_ms:
                self._fire(r, kind="due")
                continue

            # followups
            if last_ms is not None and follow_every and follow_every > 0:
                if follow_max is not None and follow_count >= follow_max:
                    continue
                next_ms = last_ms + int(follow_every) * 60_000
                if now_ms >= next_ms:
                    if self._in_quiet_hours(qstart, qend, now):
                        continue
                    self._fire(r, kind="followup")

    def _fire(self, r_row, *, kind: str):
        rid = r_row["id"]
        with tx(self.con) as cur:
            cur.execute(
                "UPDATE reminders SET last_notified_at_iso=?, followup_count=COALESCE(followup_count,0)+CASE WHEN last_notified_at_iso IS NULL THEN 0 ELSE 1 END WHERE id=?",
                (now_iso(), rid),
            )
        payload = dict(r_row)
        self.on_fire(payload, kind)
