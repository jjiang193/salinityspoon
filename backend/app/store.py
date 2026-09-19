"""SQLite persistence.

Deliberately boring: no ORM, no migrations. Field names and units match the
telemetry contract exactly, so a future move to a single-table cloud store is
mechanical rather than a rewrite.
"""

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any, Optional

from . import salinity
from .schema import utcnow_iso

DB_PATH = Path(__file__).resolve().parent.parent / "spoon.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    device_id        TEXT PRIMARY KEY,
    patient_id       TEXT,
    volume_ml_mean   REAL NOT NULL DEFAULT 10.0,
    volume_ml_sd     REAL NOT NULL DEFAULT 2.5,
    volume_source    TEXT NOT NULL DEFAULT 'default',
    coeff_a          REAL,
    coeff_b          REAL
);

CREATE TABLE IF NOT EXISTS meals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id     TEXT NOT NULL DEFAULT 'demo-1',
    device_id      TEXT NOT NULL,
    started_at     TEXT NOT NULL,
    ended_at       TEXT,
    bite_count     INTEGER NOT NULL DEFAULT 0,
    total_sodium_mg     REAL NOT NULL DEFAULT 0,
    total_sodium_mg_low REAL NOT NULL DEFAULT 0,
    total_sodium_mg_high REAL NOT NULL DEFAULT 0,
    total_volume_ml     REAL NOT NULL DEFAULT 0,
    product_name   TEXT,
    label_claim    TEXT NOT NULL DEFAULT 'none'
);

CREATE TABLE IF NOT EXISTS bites (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id   TEXT NOT NULL DEFAULT 'demo-1',
    meal_id      INTEGER REFERENCES meals(id) ON DELETE CASCADE,
    device_id    TEXT NOT NULL,
    bite_id      INTEGER NOT NULL,
    ts_utc       TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    payload      TEXT NOT NULL,
    sodium_mg    REAL NOT NULL,
    UNIQUE(device_id, ts_utc, bite_id)
);

CREATE TABLE IF NOT EXISTS manual_meals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id  TEXT NOT NULL DEFAULT 'demo-1',
    ts_utc      TEXT NOT NULL,
    name        TEXT NOT NULL,
    portion     TEXT,
    sodium_mg   REAL NOT NULL,
    source      TEXT NOT NULL DEFAULT 'manual'
);

CREATE INDEX IF NOT EXISTS idx_manual_ts ON manual_meals(patient_id, ts_utc);
CREATE INDEX IF NOT EXISTS idx_bites_meal ON bites(meal_id);
CREATE INDEX IF NOT EXISTS idx_bites_ts   ON bites(patient_id, ts_utc);
CREATE INDEX IF NOT EXISTS idx_meals_start ON meals(patient_id, started_at);
"""


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)


# --- Devices ---------------------------------------------------------------
def get_device(device_id: str) -> dict[str, Any]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM devices WHERE device_id = ?", (device_id,)
        ).fetchone()
        if row:
            return dict(row)
        conn.execute("INSERT INTO devices (device_id) VALUES (?)", (device_id,))
        return {
            "device_id": device_id,
            "patient_id": None,
            "volume_ml_mean": salinity.DEFAULT_VOLUME_ML,
            "volume_ml_sd": salinity.DEFAULT_VOLUME_SD_ML,
            "volume_source": "default",
            "coeff_a": None,
            "coeff_b": None,
        }


def set_device_volume(device_id: str, mean_ml: float, sd_ml: float) -> dict[str, Any]:
    get_device(device_id)  # ensure the row exists
    with connect() as conn:
        conn.execute(
            """UPDATE devices SET volume_ml_mean = ?, volume_ml_sd = ?,
                                  volume_source = 'user_calibrated'
                WHERE device_id = ?""",
            (mean_ml, sd_ml, device_id),
        )
    return get_device(device_id)


# --- Meals -----------------------------------------------------------------
def start_meal(device_id: str, patient_id: str = "demo-1") -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO meals (patient_id, device_id, started_at) VALUES (?, ?, ?)",
            (patient_id, device_id, utcnow_iso()),
        )
        return int(cur.lastrowid)


def close_meal(meal_id: int) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE meals SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
            (utcnow_iso(), meal_id),
        )


def recompute_meal(meal_id: int) -> dict[str, Any]:
    """Meal totals are derived from bites, never accumulated incrementally.

    Cheap at this scale, and it means a replayed or corrected bite cannot leave
    a total permanently wrong.
    """
    with connect() as conn:
        rows = conn.execute(
            "SELECT payload FROM bites WHERE meal_id = ?", (meal_id,)
        ).fetchall()
        bites = [json.loads(r["payload"]) for r in rows]

        totals = {
            "bite_count": len(bites),
            "total_sodium_mg": sum(b["sodium_mg"] for b in bites),
            "total_sodium_mg_low": sum(b["sodium_mg_low"] for b in bites),
            "total_sodium_mg_high": sum(b["sodium_mg_high"] for b in bites),
            "total_volume_ml": sum(b["volume_ml"] for b in bites),
        }
        conn.execute(
            """UPDATE meals SET bite_count = ?, total_sodium_mg = ?,
                   total_sodium_mg_low = ?, total_sodium_mg_high = ?,
                   total_volume_ml = ?
                WHERE id = ?""",
            (
                totals["bite_count"],
                totals["total_sodium_mg"],
                totals["total_sodium_mg_low"],
                totals["total_sodium_mg_high"],
                totals["total_volume_ml"],
                meal_id,
            ),
        )
        return totals


def insert_bite(meal_id: int, payload: dict[str, Any], patient_id: str = "demo-1") -> bool:
    """Returns False if this bite was already stored (idempotent replay)."""
    with connect() as conn:
        try:
            conn.execute(
                """INSERT INTO bites
                       (patient_id, meal_id, device_id, bite_id, ts_utc,
                        received_at, payload, sodium_mg)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    patient_id,
                    meal_id,
                    payload["device_id"],
                    payload["bite_id"],
                    payload["ts_utc"],
                    utcnow_iso(),
                    json.dumps(payload),
                    payload["sodium_mg"],
                ),
            )
            return True
        except sqlite3.IntegrityError:
            return False


def list_meals(limit: int = 25, patient_id: str = "demo-1") -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT * FROM meals WHERE patient_id = ?
                ORDER BY started_at DESC LIMIT ?""",
            (patient_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def get_meal(meal_id: int) -> Optional[dict[str, Any]]:
    with connect() as conn:
        row = conn.execute("SELECT * FROM meals WHERE id = ?", (meal_id,)).fetchone()
        if not row:
            return None
        bites = conn.execute(
            "SELECT payload FROM bites WHERE meal_id = ? ORDER BY ts_utc", (meal_id,)
        ).fetchall()
        return {"meal": dict(row), "bites": [json.loads(b["payload"]) for b in bites]}


def intake_today(patient_id: str = "demo-1") -> dict[str, Any]:
    midnight = datetime.combine(
        datetime.now(timezone.utc).date(), time.min, timezone.utc
    ).isoformat(timespec="milliseconds")
    with connect() as conn:
        row = conn.execute(
            """SELECT COALESCE(SUM(sodium_mg), 0) AS total, COUNT(*) AS bites
                 FROM bites WHERE patient_id = ? AND ts_utc >= ?""",
            (patient_id, midnight),
        ).fetchone()
        meals = conn.execute(
            """SELECT COUNT(*) AS n FROM meals
                WHERE patient_id = ? AND started_at >= ?""",
            (patient_id, midnight),
        ).fetchone()
        manual = conn.execute(
            """SELECT COALESCE(SUM(sodium_mg), 0) AS total, COUNT(*) AS n
                 FROM manual_meals WHERE patient_id = ? AND ts_utc >= ?""",
            (patient_id, midnight),
        ).fetchone()

        # Measured and self-reported are summed but never conflated - the
        # dashboard labels which is which, because they are not the same claim.
        return {
            "measured_sodium_mg": row["total"],
            "manual_sodium_mg": manual["total"],
            "total_sodium_mg": row["total"] + manual["total"],
            "bite_count": row["bites"],
            "manual_count": manual["n"],
            "meal_count": meals["n"],
        }


# --- Label claims ----------------------------------------------------------
def set_meal_label(meal_id: int, product_name: Optional[str], label_claim: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE meals SET product_name = ?, label_claim = ? WHERE id = ?",
            (product_name, label_claim, meal_id),
        )


def get_meal_label(meal_id: Optional[int]) -> tuple[Optional[str], str]:
    if meal_id is None:
        return None, "none"
    with connect() as conn:
        row = conn.execute(
            "SELECT product_name, label_claim FROM meals WHERE id = ?", (meal_id,)
        ).fetchone()
        if not row:
            return None, "none"
        return row["product_name"], row["label_claim"] or "none"


# --- Manual entries --------------------------------------------------------
def add_manual_meal(
    name: str, sodium_mg: float, portion: Optional[str] = None,
    ts_utc: Optional[str] = None, patient_id: str = "demo-1",
) -> dict[str, Any]:
    stamp = ts_utc or utcnow_iso()
    with connect() as conn:
        cur = conn.execute(
            """INSERT INTO manual_meals (patient_id, ts_utc, name, portion, sodium_mg)
               VALUES (?, ?, ?, ?, ?)""",
            (patient_id, stamp, name, portion, sodium_mg),
        )
        return {
            "id": int(cur.lastrowid), "ts_utc": stamp, "name": name,
            "portion": portion, "sodium_mg": sodium_mg, "source": "manual",
        }


def list_manual_meals(limit: int = 25, patient_id: str = "demo-1") -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT * FROM manual_meals WHERE patient_id = ?
                ORDER BY ts_utc DESC LIMIT ?""",
            (patient_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def delete_manual_meal(entry_id: int, patient_id: str = "demo-1") -> bool:
    with connect() as conn:
        cur = conn.execute(
            "DELETE FROM manual_meals WHERE id = ? AND patient_id = ?",
            (entry_id, patient_id),
        )
        return cur.rowcount > 0
