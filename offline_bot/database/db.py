from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager


def connect(db_path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    return con


def init_db(con: sqlite3.Connection, schema_path: str) -> None:
    with open(schema_path, "r", encoding="utf-8") as f:
        con.executescript(f.read())
    con.commit()


@contextmanager
def tx(con: sqlite3.Connection):
    cur = con.cursor()
    try:
        yield cur
        con.commit()
    except Exception:
        con.rollback()
        raise
