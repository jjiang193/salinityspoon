"""SQLite persistence.

Deliberately boring: no ORM, no migrations. Column names match the telemetry
contract exactly - NaTrack's camelCase where NaTrack names the field, this
repo's snake_case where it does not - so a row is already the JSON the API
returns, and a future move to a single-table cloud store is mechanical rather
than a rewrite.
"""

import json
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from .schema import FLAG_FAST, utcnow_iso

DB_PATH = Path(__file__).resolve().parent.parent / "spoon.db"

# Bumped whenever a column is renamed. There are no migrations, so a database
# from an older version cannot be opened - see init_db.
SCHEMA_VERSION = 2

DEFAULT_PATIENT_ID = "demo-1"
DEFAULT_CLINICIAN_ID = "clinician-1"

# "start" and "end" are NaTrack's names for a meal's bounds. END is an SQL
# keyword, so both are quoted everywhere they appear.
SCHEMA = """
CREATE TABLE IF NOT EXISTS clinicians (
    userId   TEXT PRIMARY KEY,
    role     TEXT NOT NULL DEFAULT 'clinician',
    name     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patients (
    patientId     TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    age           INTEGER,
    condition     TEXT,
    sodiumTarget  REAL NOT NULL DEFAULT 2300,
    clinicianId   TEXT NOT NULL DEFAULT 'clinician-1',
    enrolled_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    deviceId         TEXT PRIMARY KEY,
    patientId        TEXT,
    volume_ml_mean   REAL NOT NULL DEFAULT 10.0,
    volume_ml_sd     REAL NOT NULL DEFAULT 2.5,
    volume_source    TEXT NOT NULL DEFAULT 'default',
    coeff_a          REAL,
    coeff_b          REAL
);

CREATE TABLE IF NOT EXISTS meals (
    mealId         INTEGER PRIMARY KEY AUTOINCREMENT,
    patientId      TEXT NOT NULL DEFAULT 'demo-1',
    deviceId       TEXT NOT NULL,
    "start"        TEXT NOT NULL,
    "end"          TEXT,
    biteCount      INTEGER NOT NULL DEFAULT 0,
    totalSodium    REAL NOT NULL DEFAULT 0,
    total_sodium_mg_low  REAL NOT NULL DEFAULT 0,
    total_sodium_mg_high REAL NOT NULL DEFAULT 0,
    total_weight_g       REAL NOT NULL DEFAULT 0,
    avgBiteIntervalSec   REAL,
    minBiteIntervalSec   REAL,
    paceFlag       INTEGER NOT NULL DEFAULT 0,
    product_name   TEXT,
    label_claim    TEXT NOT NULL DEFAULT 'none',
    food_matrix_id TEXT NOT NULL DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS bites (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    patientId    TEXT NOT NULL DEFAULT 'demo-1',
    mealId       INTEGER REFERENCES meals(mealId) ON DELETE CASCADE,
    deviceId     TEXT NOT NULL,
    bite_id      INTEGER NOT NULL,
    timestamp    TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    payload      TEXT NOT NULL,
    sodiumEstimate REAL NOT NULL,
    UNIQUE(deviceId, timestamp, bite_id)
);

CREATE TABLE IF NOT EXISTS manual_meals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    patientId   TEXT NOT NULL DEFAULT 'demo-1',
    ts_utc      TEXT NOT NULL,
    name        TEXT NOT NULL,
    portion     TEXT,
    sodium_mg   REAL NOT NULL,
    source      TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS health_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    patientId   TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    systolic    INTEGER,
    diastolic   INTEGER,
    weightKg    REAL,
    note        TEXT,
    source      TEXT NOT NULL DEFAULT 'patient'
);

CREATE INDEX IF NOT EXISTS idx_manual_ts ON manual_meals(patientId, ts_utc);
CREATE INDEX IF NOT EXISTS idx_health_ts ON health_logs(patientId, timestamp);
CREATE INDEX IF NOT EXISTS idx_bites_meal ON bites(mealId);
CREATE INDEX IF NOT EXISTS idx_bites_ts   ON bites(patientId, timestamp);
CREATE INDEX IF NOT EXISTS idx_meals_start ON meals(patientId, "start");
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


# Synthetic people only (PLAN.md §7). Names, ages and conditions are invented;
# the conditions exist to explain why targets differ, not to claim anything.
DEMO_CLINICIANS = [(DEFAULT_CLINICIAN_ID, "clinician", "Dr. Rowan Ellis")]

DEMO_PATIENTS = [
    (DEFAULT_PATIENT_ID, "Jordan Avery", 58, "Hypertension", 2300),
    ("demo-2", "Maria Okafor", 67, "Heart failure", 1500),
    ("demo-3", "Samuel Chen", 72, "Chronic kidney disease, stage 3", 2000),
    ("demo-4", "Priya Natarajan", 49, "Hypertension", 2300),
    ("demo-5", "Walter Brooks", 81, "Heart failure", 1500),
]


def init_db() -> None:
    with connect() as conn:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        has_tables = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meals'"
        ).fetchone()
        if has_tables and version != SCHEMA_VERSION:
            # No migrations, by design. Renaming columns under an old database
            # fails later and obscurely; fail now, and say what to do.
            raise RuntimeError(
                f"{DB_PATH.name} was written by schema version {version}, this code "
                f"is version {SCHEMA_VERSION} (columns were renamed to NaTrack's). "
                f"Delete {DB_PATH} and run tools/seed_demo.py."
            )

        conn.executescript(SCHEMA)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

        if not conn.execute("SELECT 1 FROM patients LIMIT 1").fetchone():
            conn.executemany(
                "INSERT INTO clinicians (userId, role, name) VALUES (?, ?, ?)",
                DEMO_CLINICIANS,
            )
            conn.executemany(
                """INSERT INTO patients
                       (patientId, name, age, condition, sodiumTarget, clinicianId, enrolled_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                [(*p, DEFAULT_CLINICIAN_ID, utcnow_iso()) for p in DEMO_PATIENTS],
            )

        # The meal tracker lives in memory, so after a restart nothing can ever
        # join a meal left open by the previous process. Close them, or every
        # roster would show a patient who has been "eating" since last Tuesday.
        conn.execute(
            """UPDATE meals SET "end" = COALESCE(
                   (SELECT MAX(timestamp) FROM bites WHERE bites.mealId = meals.mealId),
                   "start")
                WHERE "end" IS NULL"""
        )


# --- Days ------------------------------------------------------------------
# UTC in storage, local zone in render (PLAN.md §7). A day is the *viewer's*
# day: bucketing on UTC puts a 9 pm dinner in New York into tomorrow.
def _parse_ts(ts: str) -> datetime:
    parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def local_date(ts: str, tz_offset_min: int) -> date:
    return (_parse_ts(ts) + timedelta(minutes=tz_offset_min)).date()


def _local_today(tz_offset_min: int) -> date:
    return (datetime.now(timezone.utc) + timedelta(minutes=tz_offset_min)).date()


def _day_start_utc(day: date, tz_offset_min: int) -> str:
    start = datetime.combine(day, time.min, timezone.utc) - timedelta(minutes=tz_offset_min)
    return start.isoformat(timespec="milliseconds")


# --- Patients and clinicians -----------------------------------------------
def list_patients(clinician_id: Optional[str] = None) -> list[dict[str, Any]]:
    with connect() as conn:
        if clinician_id:
            rows = conn.execute(
                "SELECT * FROM patients WHERE clinicianId = ? ORDER BY name", (clinician_id,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM patients ORDER BY name").fetchall()
        return [dict(r) for r in rows]


def get_patient(patient_id: str) -> Optional[dict[str, Any]]:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM patients WHERE patientId = ?", (patient_id,)
        ).fetchone()
        return dict(row) if row else None


def set_patient_target(patient_id: str, sodium_target: float) -> Optional[dict[str, Any]]:
    with connect() as conn:
        conn.execute(
            "UPDATE patients SET sodiumTarget = ? WHERE patientId = ?",
            (sodium_target, patient_id),
        )
    return get_patient(patient_id)


def daily_totals(
    patient_id: str, days: int = 14, tz_offset_min: int = 0
) -> list[dict[str, Any]]:
    """One row per local day, oldest first, today last.

    A day with nothing logged is reported as `logged: False`, not as zero
    intake. Nobody ate 0 mg of sodium; they did not use the spoon.
    """
    today = _local_today(tz_offset_min)
    first = today - timedelta(days=days - 1)
    since = _day_start_utc(first, tz_offset_min)

    buckets: dict[date, dict[str, Any]] = {
        first + timedelta(days=i): {
            "date": (first + timedelta(days=i)).isoformat(),
            "measured_sodium_mg": 0.0,
            "manual_sodium_mg": 0.0,
            "total_sodium_mg": 0.0,
            "bite_count": 0,
            "manual_count": 0,
            "logged": False,
        }
        for i in range(days)
    }

    with connect() as conn:
        bites = conn.execute(
            """SELECT timestamp AS ts, sodiumEstimate AS mg FROM bites
                WHERE patientId = ? AND timestamp >= ?""",
            (patient_id, since),
        ).fetchall()
        manual = conn.execute(
            """SELECT ts_utc AS ts, sodium_mg AS mg FROM manual_meals
                WHERE patientId = ? AND ts_utc >= ?""",
            (patient_id, since),
        ).fetchall()

    for rows, mg_key, n_key in (
        (bites, "measured_sodium_mg", "bite_count"),
        (manual, "manual_sodium_mg", "manual_count"),
    ):
        for r in rows:
            day = buckets.get(local_date(r["ts"], tz_offset_min))
            if day is None:
                continue
            day[mg_key] += r["mg"]
            day["total_sodium_mg"] += r["mg"]
            day[n_key] += 1
            day["logged"] = True

    return list(buckets.values())


def last_activity(patient_id: str) -> Optional[str]:
    with connect() as conn:
        row = conn.execute(
            """SELECT MAX(ts) AS ts FROM (
                   SELECT MAX(timestamp) AS ts FROM bites WHERE patientId = ?
                   UNION ALL
                   SELECT MAX(ts_utc) FROM manual_meals WHERE patientId = ?)""",
            (patient_id, patient_id),
        ).fetchone()
        return row["ts"]


# --- Devices ---------------------------------------------------------------
def _device(row: sqlite3.Row) -> dict[str, Any]:
    """NaTrack's Device: ids, a calibration object, a status."""
    return {
        "deviceId": row["deviceId"],
        "patientId": row["patientId"],
        "status": "paired" if row["patientId"] else "unpaired",
        "calibration": {
            "volume_ml_mean": row["volume_ml_mean"],
            "volume_ml_sd": row["volume_ml_sd"],
            "volume_source": row["volume_source"],
            "coeff_a": row["coeff_a"],
            "coeff_b": row["coeff_b"],
        },
    }


def get_device(device_id: str) -> dict[str, Any]:
    with connect() as conn:
        conn.execute("INSERT OR IGNORE INTO devices (deviceId) VALUES (?)", (device_id,))
        row = conn.execute(
            "SELECT * FROM devices WHERE deviceId = ?", (device_id,)
        ).fetchone()
        return _device(row)


def set_device_volume(device_id: str, mean_ml: float, sd_ml: float) -> dict[str, Any]:
    get_device(device_id)  # ensure the row exists
    with connect() as conn:
        conn.execute(
            """UPDATE devices SET volume_ml_mean = ?, volume_ml_sd = ?,
                                  volume_source = 'user_calibrated'
                WHERE deviceId = ?""",
            (mean_ml, sd_ml, device_id),
        )
    return get_device(device_id)


def pair_device(device_id: str, patient_id: str) -> dict[str, Any]:
    """Bind a spoon to a patient. One patient per spoon; re-pairing moves it."""
    get_device(device_id)
    with connect() as conn:
        conn.execute(
            "UPDATE devices SET patientId = ? WHERE deviceId = ?", (patient_id, device_id)
        )
    return get_device(device_id)


def device_patient(device_id: str) -> Optional[str]:
    with connect() as conn:
        row = conn.execute(
            "SELECT patientId FROM devices WHERE deviceId = ?", (device_id,)
        ).fetchone()
        return row["patientId"] if row else None


# --- Meals -----------------------------------------------------------------
def _meal(row: sqlite3.Row) -> dict[str, Any]:
    meal = dict(row)
    meal["paceFlag"] = bool(meal["paceFlag"])  # SQLite has no boolean
    return meal


def start_meal(device_id: str, patient_id: str = DEFAULT_PATIENT_ID) -> int:
    with connect() as conn:
        cur = conn.execute(
            'INSERT INTO meals (patientId, deviceId, "start") VALUES (?, ?, ?)',
            (patient_id, device_id, utcnow_iso()),
        )
        return int(cur.lastrowid)


def close_meal(meal_id: int) -> None:
    with connect() as conn:
        # A session that was started and ended without a single bite is not a
        # meal. Keeping it would put "0 mg" rows in front of a clinician.
        cur = conn.execute(
            """DELETE FROM meals WHERE mealId = ?
                  AND NOT EXISTS (SELECT 1 FROM bites WHERE mealId = ?)""",
            (meal_id, meal_id),
        )
        if cur.rowcount:
            return
        conn.execute(
            'UPDATE meals SET "end" = ? WHERE mealId = ? AND "end" IS NULL',
            (utcnow_iso(), meal_id),
        )


def set_meal_device(meal_id: int, device_id: str) -> None:
    """A meal started from the dashboard has no device until its first bite."""
    with connect() as conn:
        conn.execute(
            "UPDATE meals SET deviceId = ? WHERE mealId = ? AND deviceId = 'unassigned'",
            (device_id, meal_id),
        )


def recompute_meal(meal_id: int) -> dict[str, Any]:
    """The MealSummary is derived from bites, never accumulated incrementally.

    Cheap at this scale, and it means a replayed or corrected bite cannot leave
    a total permanently wrong.
    """
    from .minerals import get_matrix
    with connect() as conn:
        meal_row = conn.execute("SELECT food_matrix_id FROM meals WHERE id = ?", (meal_id,)).fetchone()
        matrix_id = meal_row["food_matrix_id"] if meal_row else "default"
        matrix = get_matrix(matrix_id)
        factor = matrix.correction_factor if matrix else 1.0

        rows = conn.execute(
            "SELECT payload FROM bites WHERE mealId = ? ORDER BY timestamp", (meal_id,)
        ).fetchall()
        bites = [json.loads(r["payload"]) for r in rows]

        # The first bite's interval is the gap since the *previous meal* - hours,
        # not seconds. Counting it would make every meal look leisurely.
        gaps = [
            b["biteIntervalSec"] for b in bites[1:] if b.get("biteIntervalSec") is not None
        ]
        fast = sum(1 for b in bites if FLAG_FAST in b.get("flags", []))

        totals = {
<<<<<<< HEAD
            "bite_count": len(bites),
            "total_sodium_mg": sum(b["sodium_mg"] * factor for b in bites),
            "total_sodium_mg_low": sum(b["sodium_mg_low"] * factor for b in bites),
            "total_sodium_mg_high": sum(b["sodium_mg_high"] * factor for b in bites),
            "total_volume_ml": sum(b["volume_ml"] for b in bites),
=======
            "biteCount": len(bites),
            "totalSodium": sum(b["sodiumEstimate"] for b in bites),
            "total_sodium_mg_low": sum(b["sodium_mg_low"] for b in bites),
            "total_sodium_mg_high": sum(b["sodium_mg_high"] for b in bites),
            "total_weight_g": sum(b["weightGrams"] for b in bites),
            "avgBiteIntervalSec": sum(gaps) / len(gaps) if gaps else None,
            "minBiteIntervalSec": min(gaps) if gaps else None,
            # A placeholder rule, like the LED thresholds under it: it reports
            # what the device saw and claims nothing clinical.
            "paceFlag": bool(bites) and fast > len(bites) / 2,
>>>>>>> origin/main
        }
        conn.execute(
            """UPDATE meals SET biteCount = :biteCount, totalSodium = :totalSodium,
                   total_sodium_mg_low = :total_sodium_mg_low,
                   total_sodium_mg_high = :total_sodium_mg_high,
                   total_weight_g = :total_weight_g,
                   avgBiteIntervalSec = :avgBiteIntervalSec,
                   minBiteIntervalSec = :minBiteIntervalSec,
                   paceFlag = :paceFlag
                WHERE mealId = :mealId""",
            {**totals, "mealId": meal_id},
        )
        return totals


def insert_bite(
    meal_id: int, payload: dict[str, Any], patient_id: str = DEFAULT_PATIENT_ID
) -> bool:
    """Returns False if this bite was already stored (idempotent replay)."""
    with connect() as conn:
        try:
            conn.execute(
                """INSERT INTO bites
                       (patientId, mealId, deviceId, bite_id, timestamp,
                        received_at, payload, sodiumEstimate)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    patient_id,
                    meal_id,
                    payload["deviceId"],
                    payload["bite_id"],
                    payload["timestamp"],
                    utcnow_iso(),
                    json.dumps(payload),
                    payload["sodiumEstimate"],
                ),
            )
            return True
        except sqlite3.IntegrityError:
            return False


def list_meals(limit: int = 25, patient_id: str = DEFAULT_PATIENT_ID) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT * FROM meals WHERE patientId = ?
                ORDER BY "start" DESC LIMIT ?""",
            (patient_id, limit),
        ).fetchall()
        return [_meal(r) for r in rows]


def _bite_event(row: sqlite3.Row) -> dict[str, Any]:
    """A stored bite as NaTrack's BiteEvent: the device's payload plus the two
    ids only the backend knows."""
    return {**json.loads(row["payload"]), "patientId": row["patientId"], "mealId": row["mealId"]}


def get_meal(meal_id: int) -> Optional[dict[str, Any]]:
    with connect() as conn:
        row = conn.execute("SELECT * FROM meals WHERE mealId = ?", (meal_id,)).fetchone()
        if not row:
            return None
        bites = conn.execute(
            "SELECT payload, patientId, mealId FROM bites WHERE mealId = ? ORDER BY timestamp",
            (meal_id,),
        ).fetchall()
        return {"meal": _meal(row), "bites": [_bite_event(b) for b in bites]}


def bites_between(
    patient_id: str, since: Optional[str], until: Optional[str], limit: int = 2000
) -> list[dict[str, Any]]:
    """Time-ranged raw bites, oldest first. Bounds are ISO-8601, either optional."""
    clauses, args = ["patientId = ?"], [patient_id]
    for bound, op in ((since, ">="), (until, "<=")):
        if bound:
            clauses.append(f"timestamp {op} ?")
            args.append(
                _parse_ts(bound).astimezone(timezone.utc).isoformat(timespec="milliseconds")
            )
    with connect() as conn:
        rows = conn.execute(
            f"""SELECT payload, patientId, mealId FROM bites
                 WHERE {' AND '.join(clauses)} ORDER BY timestamp LIMIT ?""",
            (*args, limit),
        ).fetchall()
        return [_bite_event(r) for r in rows]


def intake_today(
    patient_id: str = DEFAULT_PATIENT_ID, tz_offset_min: int = 0
) -> dict[str, Any]:
    midnight = _day_start_utc(_local_today(tz_offset_min), tz_offset_min)
    with connect() as conn:
        row = conn.execute(
            """SELECT COALESCE(SUM(sodiumEstimate), 0) AS total, COUNT(*) AS bites
                 FROM bites WHERE patientId = ? AND timestamp >= ?""",
            (patient_id, midnight),
        ).fetchone()
        meals = conn.execute(
            """SELECT COUNT(*) AS n FROM meals
                WHERE patientId = ? AND "start" >= ?""",
            (patient_id, midnight),
        ).fetchone()
        manual = conn.execute(
            """SELECT COALESCE(SUM(sodium_mg), 0) AS total, COUNT(*) AS n
                 FROM manual_meals WHERE patientId = ? AND ts_utc >= ?""",
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
            "UPDATE meals SET product_name = ?, label_claim = ? WHERE mealId = ?",
            (product_name, label_claim, meal_id),
        )

def set_meal_matrix(meal_id: int, matrix_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE meals SET food_matrix_id = ? WHERE mealId = ?",
            (matrix_id, meal_id),
        )

def end_meal(meal_id: int) -> None:
    with connect() as conn:
        conn.execute("UPDATE meals SET ended = 1 WHERE mealId = ?", (meal_id,))


def get_meal_label(meal_id: Optional[int]) -> tuple[Optional[str], str]:
    if meal_id is None:
        return None, "none"
    with connect() as conn:
        row = conn.execute(
            "SELECT product_name, label_claim FROM meals WHERE mealId = ?", (meal_id,)
        ).fetchone()
        if not row:
            return None, "none"
        return row["product_name"], row["label_claim"] or "none"


# --- Self-reported food ----------------------------------------------------
# Not a NaTrack entity, so its own fields keep their names. patientId is
# NaTrack's everywhere: an identifier with two spellings is the bug this
# contract exists to prevent.
def add_manual_meal(
    name: str, sodium_mg: float, portion: Optional[str] = None,
    ts_utc: Optional[str] = None, patient_id: str = DEFAULT_PATIENT_ID,
) -> dict[str, Any]:
    stamp = ts_utc or utcnow_iso()
    with connect() as conn:
        cur = conn.execute(
            """INSERT INTO manual_meals (patientId, ts_utc, name, portion, sodium_mg)
               VALUES (?, ?, ?, ?, ?)""",
            (patient_id, stamp, name, portion, sodium_mg),
        )
        return {
            "id": int(cur.lastrowid), "patientId": patient_id, "ts_utc": stamp,
            "name": name, "portion": portion, "sodium_mg": sodium_mg, "source": "manual",
        }


def list_manual_meals(limit: int = 25, patient_id: str = DEFAULT_PATIENT_ID) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT * FROM manual_meals WHERE patientId = ?
                ORDER BY ts_utc DESC LIMIT ?""",
            (patient_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def delete_manual_meal(entry_id: int, patient_id: str = DEFAULT_PATIENT_ID) -> bool:
    with connect() as conn:
        cur = conn.execute(
            "DELETE FROM manual_meals WHERE id = ? AND patientId = ?",
            (entry_id, patient_id),
        )
        return cur.rowcount > 0


# --- Health log ------------------------------------------------------------
def add_health_log(
    patient_id: str, systolic: Optional[int], diastolic: Optional[int],
    weight_kg: Optional[float], note: Optional[str],
    timestamp: Optional[str] = None, source: str = "patient",
) -> dict[str, Any]:
    stamp = timestamp or utcnow_iso()
    with connect() as conn:
        cur = conn.execute(
            """INSERT INTO health_logs
                   (patientId, timestamp, systolic, diastolic, weightKg, note, source)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (patient_id, stamp, systolic, diastolic, weight_kg, note, source),
        )
        return {
            "id": int(cur.lastrowid), "patientId": patient_id, "timestamp": stamp,
            "systolic": systolic, "diastolic": diastolic, "weightKg": weight_kg, "note": note,
        }


def list_health_logs(patient_id: str, limit: int = 30) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT id, patientId, timestamp, systolic, diastolic, weightKg, note
                 FROM health_logs WHERE patientId = ?
                ORDER BY timestamp DESC LIMIT ?""",
            (patient_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]
