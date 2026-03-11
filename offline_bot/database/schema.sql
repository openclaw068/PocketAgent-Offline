-- PocketAgent Offline SQLite schema (v0)

PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  due_at_iso TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','done','cancelled')),

  followup_every_min INTEGER,
  followup_max_count INTEGER,
  followup_quiet_start INTEGER DEFAULT 23,
  followup_quiet_end INTEGER DEFAULT 7,

  followup_count INTEGER DEFAULT 0,
  last_notified_at_iso TEXT,
  acknowledged_at_iso TEXT
);

CREATE INDEX IF NOT EXISTS idx_reminders_status_due ON reminders(status, due_at_iso);

CREATE TABLE IF NOT EXISTS memory_notes (
  id TEXT PRIMARY KEY,
  created_at_iso TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(text, content='memory_notes', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS memory_notes_ai AFTER INSERT ON memory_notes BEGIN
  INSERT INTO memory_notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_notes_ad AFTER DELETE ON memory_notes BEGIN
  INSERT INTO memory_notes_fts(memory_notes_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_notes_au AFTER UPDATE ON memory_notes BEGIN
  INSERT INTO memory_notes_fts(memory_notes_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO memory_notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;
