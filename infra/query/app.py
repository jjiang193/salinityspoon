"""The read/write API: NaTrack's /v1 endpoints, behind Cognito.

The cloud twin of the /v1 half of backend/app/main.py. Every route is reached
through an HTTP API with a Cognito JWT authorizer, so a request arrives already
proven to come from *someone*; this function decides whether that someone may
see *this patient*.

    canAccess is the whole security story here. A patient's own id comes from
    their token and never from the request, and a clinician has to be assigned
    to the patient they ask about. Broken access control is the first risk on
    the reference sheet's list, so it is one function, called by every route.

What this is not, yet: meal labels, self-reported food, the recording controls
and the rest of the local backend's /api surface. Meals are derived here from
the bites (the contract's 20-minute rule) rather than read from MealSummary
rows, which phase 5 adds via Streams. The local backend remains the full
article; this is the cloud subset, and the dashboard shows blanks where the
cloud has nothing to say rather than pretending.
"""

from __future__ import annotations

import json
import logging
import os
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Optional

import boto3
from boto3.dynamodb.conditions import Key

log = logging.getLogger()
log.setLevel(logging.INFO)

_ddb = boto3.resource("dynamodb")
TELEMETRY = _ddb.Table(os.environ["TELEMETRY_TABLE"])
PATIENTS = _ddb.Table(os.environ["PATIENTS_TABLE"])

# backend/app/cohort.py - same windows, same meaning.
WINDOW_DAYS = 7
RANGE_DAYS = {"day": 1, "week": WINDOW_DAYS + 1, "month": 30}
ROSTER_DAYS = 14
MEAL_GAP_MINUTES = 20          # docs/telemetry-schema.md: meal grouping
DRIFT_MIN_LOGGED_DAYS = 3
DRIFT_THRESHOLD = 0.15
DEFAULT_TARGET_MG = 1500
TARGET_RANGE = (500, 5000)
SODIUM_PER_G_NACL = 0.3934


class HttpError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


# ---------------------------------------------------------------- access ----

def claims_of(event: dict[str, Any]) -> dict[str, Any]:
    return (event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}) or {}).get("claims", {})


def groups_of(claims: dict[str, Any]) -> set[str]:
    raw = claims.get("cognito:groups", [])
    if isinstance(raw, str):                       # one group arrives as a string
        raw = [g for g in raw.strip("[]").replace(",", " ").split() if g]
    return set(raw)


def can_access(claims: dict[str, Any], patient_id: str) -> bool:
    """A patient sees themselves; a clinician sees who they are assigned.

    Never trust a patientId from the request for a patient: theirs comes from
    the token. For a clinician the assignment is a row, checked every time.
    """
    groups = groups_of(claims)
    if "patient" in groups:
        return claims.get("custom:patientId") == patient_id
    if "clinician" in groups:
        item = PATIENTS.get_item(
            Key={"PK": f"CLINICIAN#{clinician_id(claims)}", "SK": f"PATIENT#{patient_id}"},
            ProjectionExpression="PK",
        ).get("Item")
        return bool(item)
    return False


def clinician_id(claims: dict[str, Any]) -> str:
    """The verified email, which is what an assignment row is written under.

    Not `cognito:username`: the pool signs in by email, so the username is a
    UUID nobody can write an assignment against by hand. The email is in the
    token only because Cognito verified it.
    """
    return claims.get("email") or claims.get("cognito:username") or claims.get("sub", "")


def require_access(claims: dict[str, Any], patient_id: str) -> dict[str, Any]:
    if not can_access(claims, patient_id):
        # Deliberately the same answer as a patient who does not exist. Telling
        # a stranger which ids are real is itself a leak.
        raise HttpError(404, "patient not found")
    return require_patient(patient_id)


# ----------------------------------------------------------------- store ----

def require_patient(patient_id: str) -> dict[str, Any]:
    item = PATIENTS.get_item(Key={"PK": f"PATIENT#{patient_id}", "SK": "PROFILE"}).get("Item")
    if not item:
        raise HttpError(404, "patient not found")
    return {
        "patientId": patient_id,
        "name": item.get("name", patient_id),
        "age": num(item.get("age")),
        "condition": item.get("condition"),
        "sodiumTarget": num(item.get("sodiumTarget"), DEFAULT_TARGET_MG),
        "clinicianId": item.get("clinicianId", ""),
        "enrolled_at": item.get("enrolled_at", ""),
    }


def bites_between(patient_id: str, since: Optional[str], until: Optional[str]) -> list[dict[str, Any]]:
    """Bites for one patient, oldest first. The sort key is BITE#<timestamp>#…,
    so a time range is a key condition, not a filter."""
    lo = f"BITE#{since}" if since else "BITE#"
    hi = f"BITE#{until}￿" if until else "BITE#￿"
    items, last = [], None
    while True:
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": Key("PK").eq(f"PATIENT#{patient_id}") & Key("SK").between(lo, hi),
        }
        if last:
            kwargs["ExclusiveStartKey"] = last
        page = TELEMETRY.query(**kwargs)
        items.extend(page.get("Items", []))
        last = page.get("LastEvaluatedKey")
        if not last:
            return [clean(i) for i in items]


def clean(item: dict[str, Any]) -> dict[str, Any]:
    """A stored bite as the wire saw it, plus the ids only the backend knows."""
    return {k: num(v) if isinstance(v, Decimal) else v
            for k, v in item.items() if k not in ("PK", "SK", "expiresAt")}


def num(v: Any, default: Any = None) -> Any:
    if v is None:
        return default
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    return v


# --------------------------------------------------------------- derived ----

def local_date(ts: str, tz_offset_min: int) -> date:
    """The viewer's day, not UTC's. A 9 pm dinner in New York belongs to that
    evening, not to tomorrow (PLAN.md §7)."""
    t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return (t + timedelta(minutes=tz_offset_min)).date()


def daily_totals(bites: list[dict], days: int, tz_offset_min: int) -> list[dict[str, Any]]:
    """One row per local day, oldest first, including days with nothing in them.
    A day with `logged: false` is not a zero day and must not be averaged as
    one."""
    by_day: dict[str, dict[str, float]] = defaultdict(lambda: {"mg": 0.0, "low": 0.0, "high": 0.0, "n": 0})
    for b in bites:
        d = local_date(b["timestamp"], tz_offset_min).isoformat()
        row = by_day[d]
        row["mg"] += float(b.get("sodiumEstimate") or 0)
        row["low"] += float(b.get("sodium_mg_low") or 0)
        row["high"] += float(b.get("sodium_mg_high") or 0)
        row["n"] += 1

    today = local_date(datetime.now(timezone.utc).isoformat(), tz_offset_min)
    out = []
    for back in range(days - 1, -1, -1):
        d = (today - timedelta(days=back)).isoformat()
        row = by_day.get(d)
        out.append({
            "date": d,
            "logged": bool(row),
            "bite_count": int(row["n"]) if row else 0,
            "manual_count": 0,
            "measured_sodium_mg": round(row["mg"], 1) if row else 0.0,
            "measured_sodium_mg_low": round(row["low"], 1) if row else 0.0,
            "measured_sodium_mg_high": round(row["high"], 1) if row else 0.0,
            "manual_sodium_mg": 0.0,          # self-reported food is not in the cloud yet
            "total_sodium_mg": round(row["mg"], 1) if row else 0.0,
            "total_sodium_mg_low": round(row["low"], 1) if row else 0.0,
            "total_sodium_mg_high": round(row["high"], 1) if row else 0.0,
        })
    return out


def meals_from(bites: list[dict]) -> list[dict[str, Any]]:
    """MealSummary rows derived on read, by the contract's 20-minute rule.

    Phase 5 moves this to a Streams-triggered Lambda writing MEAL# rows, which
    is what the design specifies; until then the dashboard gets the same
    numbers, computed on the way out. The label fields are null because a label
    is set through the local backend's /api and the cloud has never seen one.
    """
    meals: list[dict[str, Any]] = []
    run: list[dict] = []

    def close(run: list[dict]) -> dict[str, Any]:
        gaps = [float(b["biteIntervalSec"]) for b in run[1:] if b.get("biteIntervalSec") is not None]
        total = sum(float(b.get("sodiumEstimate") or 0) for b in run)
        fast = sum(1 for b in run if "fast" in (b.get("flags") or []))
        return {
            "mealId": run[0]["timestamp"],          # the meal's start is its id here
            "patientId": run[0].get("patientId"),
            "deviceId": run[0].get("deviceId"),
            "start": run[0]["timestamp"],
            "end": run[-1]["timestamp"],
            "biteCount": len(run),
            "totalSodium": round(total, 1),
            "total_sodium_mg_low": round(sum(float(b.get("sodium_mg_low") or 0) for b in run), 1),
            "total_sodium_mg_high": round(sum(float(b.get("sodium_mg_high") or 0) for b in run), 1),
            "total_weight_g": round(sum(float(b.get("weightGrams") or 0) for b in run), 1),
            # NaTrack excludes the meal's first bite: its interval spans the
            # hours since the previous meal.
            "avgBiteIntervalSec": round(sum(gaps) / len(gaps), 1) if gaps else None,
            "minBiteIntervalSec": round(min(gaps), 1) if gaps else None,
            "paceFlag": fast > len(run) / 2,
            "product_name": None, "label_claim": "none", "label_claim_label": None,
            "label_flagged": False, "label_severity": "none", "label_ratio": None,
            "label_headline": None, "label_detail": None,
            "mean_salinity_g_l": None, "mg_per_serving": None,
        }

    for b in bites:
        if run:
            gap = (datetime.fromisoformat(b["timestamp"].replace("Z", "+00:00"))
                   - datetime.fromisoformat(run[-1]["timestamp"].replace("Z", "+00:00")))
            if gap > timedelta(minutes=MEAL_GAP_MINUTES):
                meals.append(close(run))
                run = []
        run.append(b)
    if run:
        meals.append(close(run))

    for m in meals:                                   # weight-averaged salinity
        if m["total_weight_g"]:
            g_l = m["totalSodium"] / (SODIUM_PER_G_NACL * m["total_weight_g"])
            m["mean_salinity_g_l"] = round(g_l, 2)
    return list(reversed(meals))                      # newest first, as the local API does


def summarise(patient: dict, bites: list[dict], tz_offset_min: int, history_days: int) -> dict[str, Any]:
    span = max(history_days, 2 * WINDOW_DAYS + 1)
    all_days = daily_totals(bites, span, tz_offset_min)
    window = all_days[-(WINDOW_DAYS + 1):-1]
    previous = all_days[-(2 * WINDOW_DAYS + 1):-(WINDOW_DAYS + 1)]

    def mean_logged(days: list[dict]) -> tuple[Optional[float], int]:
        vals = [d["total_sodium_mg"] for d in days if d["logged"]]
        return (round(sum(vals) / len(vals), 1) if vals else None), len(vals)

    avg, logged = mean_logged(window)
    prev_avg, prev_logged = mean_logged(previous)
    drift = None
    if avg is not None and prev_avg and logged >= DRIFT_MIN_LOGGED_DAYS and prev_logged >= DRIFT_MIN_LOGGED_DAYS:
        drift = round((avg / prev_avg - 1.0) * 100.0, 1)

    days_since_log = next((i for i, d in enumerate(reversed(all_days)) if d["logged"]), None)
    meals = meals_from(bites)
    gaps = [m["avgBiteIntervalSec"] for m in meals if m["avgBiteIntervalSec"] is not None]
    quickest = [m["minBiteIntervalSec"] for m in meals if m["minBiteIntervalSec"] is not None]

    target = patient["sodiumTarget"]
    today = all_days[-1]
    return {
        **patient,
        "today": today,
        "daily": all_days[-history_days:],
        "pct_of_target_today": round(today["total_sodium_mg"] / target * 100.0, 1),
        "pct_of_target_avg": round(avg / target * 100.0, 1) if avg is not None else None,
        "avg_sodium_mg": avg, "days_logged": logged, "window_days": WINDOW_DAYS,
        "days_over_target": sum(1 for d in window if d["logged"] and d["total_sodium_mg"] > target),
        "drift_pct": drift,
        "upward_drift": drift is not None and drift >= DRIFT_THRESHOLD * 100.0,
        "days_since_log": days_since_log,
        "avgBiteIntervalSec": round(sum(gaps) / len(gaps), 1) if gaps else None,
        "minBiteIntervalSec": round(min(quickest), 1) if quickest else None,
        "pace_flagged_meals": sum(1 for m in meals if m["paceFlag"]),
        # No label is ever set through the cloud, so no meal can contradict one.
        "flagged_meals": 0,
        "last_activity_at": bites[-1]["timestamp"] if bites else None,
        "in_meal": False,
        "meals": meals,
    }


# ---------------------------------------------------------------- routes ----

def get_patients(claims: dict, qs: dict) -> Any:
    """The clinician's roster. The clinicianId in the query is ignored if it is
    not the caller's own: a clinician reads their own list, never another's."""
    if "clinician" not in groups_of(claims):
        raise HttpError(403, "clinician only")
    cid = clinician_id(claims)
    rows = PATIENTS.query(
        KeyConditionExpression=Key("PK").eq(f"CLINICIAN#{cid}") & Key("SK").begins_with("PATIENT#"),
    ).get("Items", [])

    tz = int(qs.get("tz_offset_min", 0))
    out = []
    for r in rows:
        pid = r["SK"].split("#", 1)[1]
        patient = require_patient(pid)
        bites = bites_between(pid, (datetime.now(timezone.utc) - timedelta(days=ROSTER_DAYS)).isoformat(), None)
        out.append(summarise(patient, bites, tz, ROSTER_DAYS))
    return out


def get_summary(claims: dict, pid: str, qs: dict) -> Any:
    patient = require_access(claims, pid)
    rng = qs.get("range", "week")
    if rng not in RANGE_DAYS:
        raise HttpError(400, "range must be day, week or month")
    tz = int(qs.get("tz_offset_min", 0))
    since = (datetime.now(timezone.utc) - timedelta(days=max(RANGE_DAYS[rng], 2 * WINDOW_DAYS + 1))).isoformat()
    bites = bites_between(pid, since, None)
    summary = summarise(patient, bites, tz, RANGE_DAYS[rng])
    return {
        **summary,
        "range": rng,
        "manual_meals": [],        # self-reported food is local-only for now
        "sources": sources_of(summary["meals"], summary["daily"]),
    }


def sources_of(meals: list[dict], daily: list[dict]) -> dict[str, Any]:
    total = sum(m["totalSodium"] for m in meals)
    return {
        "days": len(daily),
        "days_logged": sum(1 for d in daily if d["logged"]),
        "total_sodium_mg": round(total, 1),
        "measured_sodium_mg": round(total, 1),
        "manual_sodium_mg": 0.0,
        "items": [{
            "kind": "measured", "name": None, "portion": None,
            "label_claim": None, "label_claim_label": None,
            "count": len(meals), "sodium_mg": round(total, 1),
            "share_pct": 100.0 if total else 0.0,
            "mean_salinity_g_l": None, "mg_per_serving": None, "flagged_count": 0,
        }] if meals else [],
    }


def get_bites(claims: dict, pid: str, qs: dict) -> Any:
    require_access(claims, pid)
    return bites_between(pid, qs.get("from"), qs.get("to"))


def put_target(claims: dict, pid: str, body: dict) -> Any:
    require_access(claims, pid)
    if "clinician" not in groups_of(claims):
        # The reference sheet is explicit: targets are set by the clinician,
        # not decided by the app - and not by the patient either.
        raise HttpError(403, "only a clinician sets the sodium target")
    target = body.get("sodiumTarget")
    if not isinstance(target, (int, float)) or not TARGET_RANGE[0] <= target <= TARGET_RANGE[1]:
        raise HttpError(400, f"sodiumTarget must be between {TARGET_RANGE[0]} and {TARGET_RANGE[1]} mg")
    PATIENTS.update_item(
        Key={"PK": f"PATIENT#{pid}", "SK": "PROFILE"},
        UpdateExpression="SET sodiumTarget = :t",
        ExpressionAttributeValues={":t": Decimal(str(target))},
    )
    return {"patientId": pid, "sodiumTarget": target}


VITALS = {"systolic": (60, 260), "diastolic": (30, 160), "weightKg": (20, 400)}


def post_health_log(claims: dict, pid: str, body: dict) -> Any:
    require_access(claims, pid)
    entry = {k: body[k] for k in ("systolic", "diastolic", "weightKg", "note") if body.get(k) is not None}
    if not entry:
        raise HttpError(400, "nothing to log: give a blood pressure, a weight or a note")
    if ("systolic" in entry) != ("diastolic" in entry):
        raise HttpError(400, "blood pressure needs both systolic and diastolic")
    # Reject the implausible: a systolic of 400 is a typo, and a typo in
    # medical data misleads a clinician (PLAN.md §7).
    for field, (lo, hi) in VITALS.items():
        if field in entry and not lo <= float(entry[field]) <= hi:
            raise HttpError(400, f"{field} must be between {lo} and {hi}")
    if {"systolic", "diastolic"} <= entry.keys() and entry["diastolic"] >= entry["systolic"]:
        raise HttpError(400, "diastolic must be lower than systolic")

    ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    item = {"PK": f"PATIENT#{pid}", "SK": f"HEALTH#{ts}", "patientId": pid, "timestamp": ts, **entry}
    PATIENTS.put_item(Item=json.loads(json.dumps(item), parse_float=Decimal))
    return {k: num(v) for k, v in item.items() if k not in ("PK", "SK")}


def get_health_log(claims: dict, pid: str) -> Any:
    require_access(claims, pid)
    rows = PATIENTS.query(
        KeyConditionExpression=Key("PK").eq(f"PATIENT#{pid}") & Key("SK").begins_with("HEALTH#"),
        ScanIndexForward=False, Limit=100,
    ).get("Items", [])
    return [{k: num(v) for k, v in r.items() if k not in ("PK", "SK")} for r in rows]


def pair_device(claims: dict, device_id: str, body: dict) -> Any:
    pid = body.get("patientId")
    if not pid:
        raise HttpError(400, "patientId is required")
    require_access(claims, pid)
    # The pairing lives in the telemetry table so ingest never needs a key to
    # the patients table. See infra/README.md.
    TELEMETRY.put_item(Item={
        "PK": f"DEVICE#{device_id}", "SK": "PAIRING",
        "deviceId": device_id, "patientId": pid,
        "pairedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    return {"deviceId": device_id, "patientId": pid}


# --------------------------------------------------------------- handler ----

def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    route = event.get("routeKey", "")
    path = event.get("pathParameters") or {}
    qs = event.get("queryStringParameters") or {}
    claims = claims_of(event)

    try:
        body = json.loads(event["body"]) if event.get("body") else {}
    except json.JSONDecodeError:
        return reply(400, {"detail": "body is not JSON"})

    try:
        if route == "GET /v1/patients":
            return reply(200, get_patients(claims, qs))
        if route == "GET /v1/patients/{patientId}/summary":
            return reply(200, get_summary(claims, path["patientId"], qs))
        if route == "GET /v1/patients/{patientId}/bites":
            return reply(200, get_bites(claims, path["patientId"], qs))
        if route == "PUT /v1/patients/{patientId}/target":
            return reply(200, put_target(claims, path["patientId"], body))
        if route == "POST /v1/patients/{patientId}/health-log":
            return reply(200, post_health_log(claims, path["patientId"], body))
        if route == "GET /v1/patients/{patientId}/health-log":
            return reply(200, get_health_log(claims, path["patientId"]))
        if route == "POST /v1/devices/{deviceId}/pair":
            return reply(200, pair_device(claims, path["deviceId"], body))
        return reply(404, {"detail": "no such endpoint"})
    except HttpError as e:
        return reply(e.status, {"detail": e.detail})
    except Exception:
        # Never log the exception's payload context: this handler touches
        # health data. The request id in CloudWatch is the thread to pull.
        log.exception("unhandled error on %s", route)
        return reply(500, {"detail": "the server had a problem. Try again in a moment."})


def reply(status: int, body: Any) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body, default=str),
    }
