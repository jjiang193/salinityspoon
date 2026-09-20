"""Synthetic history for the demo cohort.

The clinician view is a view over *weeks*, and the spoon has existed for hours.
This writes a month of plausible history for the five demo patients so the
roster has something to say.

It is fiction, and marked as such in the data rather than only in this comment:
every seeded bite carries `deviceId = seed-<patient>` and `fw_version =
seed-0.1`, and every seeded manual entry and health log has `source = 'seed'`.
`reset()` removes exactly those rows and nothing else, so seeded and real data
can share a database without the fiction becoming unremovable.

Seeding is deterministic per (patient, day) and skips days already seeded, so
running it every morning tops the history up rather than doubling it.
"""

import json
import math
import random
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from . import salinity, store
from .schema import BITE_SCHEMA, FLAG_FAST

FW_VERSION = "seed-0.1"

# A month, because NaTrack's summary endpoint offers range=month.
DAYS = 30

# A drifting patient drifts over the last fortnight, which is the span the
# drift rule compares (cohort.py): last week against the week before.
DRIFT_DAYS = 14

# The LED thresholds the seeded "device" applies. Placeholders, as on the
# real firmware.
PACE_GREEN_S, PACE_YELLOW_S = 30.0, 15.0

# (product, label claim, NaCl g/L). The last entry is the potassium-flag case:
# labelled low sodium, measures like ordinary broth.
LIQUIDS = [
    ("Chicken noodle soup", "none", 7.4),
    ("Miso soup", "none", 8.8),
    ("Tomato soup", "none", 6.1),
    ("Vegetable broth", "none", 5.2),
    ("Lentil soup", "none", 6.6),
    ("Low-sodium chicken broth", "low_sodium", 1.3),
]
FLAGGED_LIQUID = ("Heart-Smart Broth", "low_sodium", 6.2)

SOLIDS = [
    ("Whole wheat bread", "2 slices", 340),
    ("Cheddar cheese", "30 g", 180),
    ("Crackers", "6", 190),
    ("Deli turkey", "2 slices", 450),
    ("Scrambled eggs", "2", 180),
    ("Salted nuts", "30 g", 120),
    ("Salad dressing", "2 tbsp", 300),
    ("Breakfast cereal", "1 cup", 200),
    ("Cottage cheese", "1/2 cup", 360),
]

# Each patient is a different story for the roster to tell.
#   salt      scales liquid concentration, i.e. how salty they cook
#   meals     spoon meals per day, chosen uniformly from this list
#   solids    self-reported items per day, inclusive range
#   drift     multiplier reached today, ramped over the last DRIFT_DAYS
#   lapse     trailing days with nothing logged at all
#   flagged   chance a meal is the mislabelled broth
#   gap       seconds between bites, uniform range - how fast they eat
#   bp        (systolic, diastolic) the health log hovers around; None = no log
#   kg        body weight, and its change over the month
#   menu      indexes into LIQUIDS this patient eats; default all. A narrow menu
#             keeps day-to-day noise below the trend the profile is meant to show
PROFILES: dict[str, dict[str, Any]] = {
    # Within target, but climbing: the upward-drift flag, on its own.
    "demo-1": dict(salt=0.6, meals=[2, 2], solids=(1, 2), drift=1.9, lapse=0,
                   flagged=0.0, gap=(14, 34), bp=(138, 86), kg=(84.0, 0.4),
                   menu=(0, 2, 4)),
    # Over target most days, and eats fast: above target, with a pace flag.
    "demo-2": dict(salt=1.05, meals=[2, 2], solids=(1, 2), drift=1.0, lapse=0,
                   flagged=0.0, gap=(6, 17), bp=(146, 88), kg=(71.5, 1.8)),
    # Sodium looks fine; the label flag is the story.
    "demo-3": dict(salt=0.85, meals=[2, 2], solids=(1, 2), drift=0.85, lapse=0,
                   flagged=0.2, gap=(16, 36), bp=(132, 80), kg=(68.0, -0.3)),
    # Stopped logging four days ago.
    "demo-4": dict(salt=1.0, meals=[1, 2, 2], solids=(1, 3), drift=1.0, lapse=4,
                   flagged=0.0, gap=(14, 34), bp=None, kg=None),
    "demo-5": dict(salt=0.8, meals=[1, 1, 2], solids=(1, 2), drift=1.0, lapse=0,
                   flagged=0.0, gap=(18, 40), bp=(128, 76), kg=(77.0, 0.0)),
}


def _salinity_index_for(g_l: float) -> float:
    """Inverse of the quadratic fit: what conductivity would the probe have read?"""
    a, b = salinity.COEFF_A, salinity.COEFF_B
    return (-a + math.sqrt(a * a + 4 * b * g_l)) / (2 * b)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds")


def _seed_day(conn, patient_id: str, day: date, age_days: int, tz: timezone) -> int:
    """Write one patient-day. Returns the number of bites written."""
    profile = PROFILES[patient_id]
    device_id = f"seed-{patient_id}"
    rng = random.Random(f"{patient_id}:{day.isoformat()}")
    now = datetime.now(timezone.utc)

    progress = min(1.0, max(0.0, 1.0 - age_days / (DRIFT_DAYS - 1)))
    scale = profile["salt"] * (1.0 + (profile["drift"] - 1.0) * progress)

    slots = [(12, 0), (18, 30)]
    if rng.choice(profile["meals"]) == 1:
        slots = [rng.choice(slots)]

    written = 0
    for slot_index, (hour, minute) in enumerate(slots):
        start = datetime.combine(day, time(hour, minute), tz) + timedelta(
            minutes=rng.randint(-25, 40)
        )
        if start + timedelta(minutes=20) > now:
            continue  # today's dinner has not happened yet

        product, claim, g_l = (
            FLAGGED_LIQUID if rng.random() < profile["flagged"]
            else LIQUIDS[rng.choice(profile.get("menu", range(len(LIQUIDS))))]
        )
        # A labelled product tastes the same whoever eats it; home cooking varies.
        g_l = g_l if claim != "none" else g_l * scale * rng.uniform(0.9, 1.1)

        cur = conn.execute(
            """INSERT INTO meals (patientId, deviceId, "start", product_name, label_claim)
               VALUES (?, ?, ?, ?, ?)""",
            (patient_id, device_id, _iso(start), product, claim),
        )
        meal_id = int(cur.lastrowid)

        ts = start
        temp_c = rng.uniform(30, 38)
        for n in range(rng.randint(22, 36)):
            gap = rng.uniform(*profile["gap"])
            ts += timedelta(seconds=gap)
            bite_g_l = g_l * rng.uniform(0.98, 1.02)
            grams = salinity.DEFAULT_VOLUME_ML  # calibrated scoop at 1.0 g/mL
            low, mid, high = salinity.sodium_range_mg(
                bite_g_l, grams, salinity.DEFAULT_VOLUME_SD_ML
            )
            temp_c = max(24.0, temp_c - rng.uniform(0.05, 0.25))
            pace = ("green" if gap >= PACE_GREEN_S
                    else "yellow" if gap >= PACE_YELLOW_S else "red")
            payload = {
                "schema": BITE_SCHEMA,
                "deviceId": device_id,
                "bite_id": age_days * 1000 + slot_index * 100 + n,
                "timestamp": _iso(ts),
                "salinityIndex": round(_salinity_index_for(bite_g_l), 3),
                "tempC": round(temp_c, 1),
                "salinity_g_l": round(bite_g_l, 3),
                "salinity_source": "measured",
                "dilution_factor": 1.0,
                "weightGrams": grams,
                "volume_source": "default",
                "sodiumEstimate": round(mid, 2),
                "sodium_mg_low": round(low, 2),
                "sodium_mg_high": round(high, 2),
                "quality": round(rng.uniform(0.82, 0.97), 2),
                "ec_sample_count": rng.randint(22, 28),
                # The first bite's interval is the hours since the last meal.
                "biteIntervalSec": round(gap, 1) if n else None,
                "pace": pace if n else "unknown",
                "flags": [FLAG_FAST] if n and pace == "red" else [],
                "fw_version": FW_VERSION,
            }
            conn.execute(
                """INSERT OR IGNORE INTO bites
                       (patientId, mealId, deviceId, bite_id, timestamp,
                        received_at, payload, sodiumEstimate)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (patient_id, meal_id, device_id, payload["bite_id"], payload["timestamp"],
                 payload["timestamp"], json.dumps(payload), payload["sodiumEstimate"]),
            )
            written += 1

        conn.execute('UPDATE meals SET "end" = ? WHERE mealId = ?', (_iso(ts), meal_id))

    for _ in range(rng.randint(*profile["solids"])):
        name, portion, mg = rng.choice(SOLIDS)
        at = datetime.combine(day, time(rng.choice([8, 10, 13, 15, 19]), rng.randint(0, 59)), tz)
        if at > now:
            continue
        conn.execute(
            """INSERT INTO manual_meals (patientId, ts_utc, name, portion, sodium_mg, source)
               VALUES (?, ?, ?, ?, ?, 'seed')""",
            (patient_id, _iso(at), name, portion, mg),
        )

    # A morning reading, most days but not all: real logs have holes.
    at = datetime.combine(day, time(7, rng.randint(5, 55)), tz)
    # A day is re-seeded when a top-up finds no seeded food on it yet - this
    # morning, before lunch. Its reading may already be there, and unlike a
    # bite a health log has no key to be ignored on: it would be written twice.
    logged = conn.execute(
        """SELECT 1 FROM health_logs WHERE patientId = ? AND source = 'seed'
              AND timestamp >= ? AND timestamp < ? LIMIT 1""",
        (patient_id, _iso(datetime.combine(day, time.min, tz)),
         _iso(datetime.combine(day + timedelta(days=1), time.min, tz))),
    ).fetchone()
    if profile["bp"] and not logged and at < now and rng.random() < 0.7:
        systolic = profile["bp"][0] + rng.randint(-7, 7)
        diastolic = profile["bp"][1] + rng.randint(-5, 5)
        kg0, change = profile["kg"]
        kg = kg0 + change * (1.0 - age_days / (DAYS - 1)) + rng.uniform(-0.3, 0.3)
        conn.execute(
            """INSERT INTO health_logs
                   (patientId, timestamp, systolic, diastolic, weightKg, note, source)
               VALUES (?, ?, ?, ?, ?, NULL, 'seed')""",
            (patient_id, _iso(at), systolic, diastolic, round(kg, 1)),
        )

    return written


def seed(tz_offset_min: int = 0) -> dict[str, int]:
    """Top up the last DAYS days for every profiled patient. Idempotent."""
    store.init_db()
    tz = timezone(timedelta(minutes=tz_offset_min))
    today = datetime.now(tz).date()
    counts: dict[str, int] = {}

    with store.connect() as conn:
        for patient_id, profile in PROFILES.items():
            counts[patient_id] = 0
            for age in range(DAYS - 1, -1, -1):
                if age < profile["lapse"]:
                    continue
                day = today - timedelta(days=age)
                lo = _iso(datetime.combine(day, time.min, tz))
                hi = _iso(datetime.combine(day + timedelta(days=1), time.min, tz))
                already = conn.execute(
                    """SELECT 1 FROM meals WHERE deviceId = ? AND "start" >= ?
                          AND "start" < ? LIMIT 1""",
                    (f"seed-{patient_id}", lo, hi),
                ).fetchone() or conn.execute(
                    """SELECT 1 FROM manual_meals WHERE patientId = ? AND source = 'seed'
                          AND ts_utc >= ? AND ts_utc < ? LIMIT 1""",
                    (patient_id, lo, hi),
                ).fetchone()
                # Today is never seeded for the patient holding the real spoon:
                # their "today" should be what the spoon measured.
                if already or (age == 0 and patient_id == store.DEFAULT_PATIENT_ID):
                    continue
                counts[patient_id] += _seed_day(conn, patient_id, day, age, tz)

        meal_ids = [
            r["mealId"] for r in conn.execute(
                "SELECT mealId FROM meals WHERE deviceId LIKE 'seed-%'"
            ).fetchall()
        ]

    # Summaries come from the same function real meals use, so the seeded
    # totals and pace metrics cannot drift from how a live meal is summed.
    for meal_id in meal_ids:
        store.recompute_meal(meal_id)
    return counts


def reset() -> None:
    """Remove seeded rows, and only seeded rows."""
    store.init_db()
    with store.connect() as conn:
        conn.execute("DELETE FROM bites WHERE deviceId LIKE 'seed-%'")
        conn.execute("DELETE FROM meals WHERE deviceId LIKE 'seed-%'")
        conn.execute("DELETE FROM manual_meals WHERE source = 'seed'")
        conn.execute("DELETE FROM health_logs WHERE source = 'seed'")
