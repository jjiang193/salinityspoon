"""Salinity Spoon backend.

    uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

--host 0.0.0.0 matters: the ESP32 connects from another machine on the network,
so binding to localhost makes the spoon invisible.

Two route families, and the split is the contract (docs/telemetry-schema.md):

    /v1/...   and  /session/{patientId}   NaTrack's API, at NaTrack's paths
    /api/...  and  /ws/ingest             everything NaTrack does not cover
"""

import asyncio
import json
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError

from typing import Literal, Optional

from . import cohort, labels, salinity, store
from .hub import Hub, MealTracker
from .recorder import Recorder
from .schema import BITE_SCHEMA, SAMPLE_SCHEMA, Bite, Sample, utcnow_iso

app = FastAPI(title="Salinity Spoon")

# The Vite dev server runs on a different port; without this the dashboard's
# fetch calls die at the browser before they reach us.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

hub = Hub()
meals = MealTracker(hub)
recorder = Recorder()


# How often an open meal is checked for having gone idle. The promise on the
# patient's screen is "ends by itself after 20 minutes"; half a minute late is
# within it.
IDLE_CHECK_S = 30.0


async def _close_idle_meals() -> None:
    while True:
        await asyncio.sleep(IDLE_CHECK_S)
        try:
            await meals.close_if_idle()
        except Exception:
            # One failed check must not end the checking.
            pass


@app.on_event("startup")
async def _startup() -> None:
    store.init_db()
    # Held on app.state: a task nothing references can be garbage-collected.
    app.state.idle_closer = asyncio.create_task(_close_idle_meals())


@app.on_event("shutdown")
async def _shutdown() -> None:
    app.state.idle_closer.cancel()


# --- Ingest ------------------------------------------------------------------
@app.websocket("/ws/ingest")
async def ws_ingest(ws: WebSocket) -> None:
    """The spoon (or tools/mock_spoon.py) connects here.

    Accepts both sample/v2 and bite/v2 on one socket, dispatched on the
    `schema` field. NaTrack's cloud ingest is MQTT; this is the local transport
    carrying the same bite.
    """
    await ws.accept()
    try:
        while True:
            raw = await ws.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError as exc:
                await ws.send_text(json.dumps({"type": "error", "detail": str(exc)}))
                continue

            recorder.write(payload)
            kind = payload.get("schema")
            try:
                if kind == SAMPLE_SCHEMA:
                    await _handle_sample(payload)
                elif kind == BITE_SCHEMA:
                    await _handle_bite(payload)
                else:
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "detail": f"unknown schema {kind!r}; this backend speaks "
                                  f"{SAMPLE_SCHEMA} and {BITE_SCHEMA}",
                    }))
            except ValidationError as exc:
                await ws.send_text(json.dumps({"type": "error", "detail": str(exc)}))
    except WebSocketDisconnect:
        pass


async def _handle_sample(payload: dict) -> None:
    Sample.model_validate(payload)  # validate, then forward verbatim
    message = {
        "type": "sample",
        "received_at": utcnow_iso(),
        "mealId": meals.meal_id,
        "patientId": meals.patient_id,
        "data": payload,
    }
    hub.last_sample = message
    await hub.send(meals.patient_id, message)


async def _handle_bite(payload: dict) -> None:
    bite = Bite.model_validate(payload)

    # The interlock is enforced here too, not only on the device. A bite
    # measured outside the probe's range is not a less-precise bite, it is an
    # unsupported one, and it must not enter the record.
    if not salinity.temp_in_range(bite.tempC):
        await hub.send(
            meals.patient_id,
            {
                "type": "error",
                "detail": f"bite rejected: {bite.tempC} °C outside probe range "
                          f"{salinity.PROBE_TEMP_MIN_C}–{salinity.PROBE_TEMP_MAX_C} °C",
            },
        )
        return

    meal_id = await meals.assign(payload)
    stored = store.insert_bite(meal_id, payload, meals.patient_id)
    if not stored:
        return  # idempotent replay, already recorded

    totals = store.recompute_meal(meal_id)

    message = {
        "type": "bite",
        "received_at": utcnow_iso(),
        "mealId": meal_id,
        "patientId": meals.patient_id,
        "data": payload,
        "meal_totals": totals,
        # The meal's mean against its label, not this one bite's.
        "label_check": cohort.live_label_check(meal_id),
    }
    hub.last_bite = message
    await hub.send(meals.patient_id, message)


# --- Live session ------------------------------------------------------------
@app.websocket("/session/{patient_id}")
async def ws_session(ws: WebSocket, patient_id: str) -> None:
    """NaTrack's live session: one patient's bites, as they land."""
    await ws.accept()
    if not store.get_patient(patient_id):
        await ws.close(code=4404, reason="patient not found")
        return

    await hub.register(ws, patient_id)
    try:
        await ws.send_text(json.dumps(meals.spoon_state(patient_id)))
        # Prime a freshly-opened tab so it is not staring at an empty chart -
        # but only with this patient's own data.
        if patient_id == meals.patient_id:
            bite = hub.last_bite
            # The last bite is replayed only into the meal it belongs to, and
            # with the label check as it stands now: the one it carries was
            # frozen when it landed, and the label may have been declared since.
            if bite and bite["patientId"] == patient_id and bite["mealId"] == meals.meal_id:
                await ws.send_text(json.dumps({
                    **bite, "label_check": cohort.live_label_check(meals.meal_id),
                }))
            sample = hub.last_sample
            if sample and sample["patientId"] == patient_id:
                await ws.send_text(json.dumps(sample))
        while True:
            await ws.receive_text()  # keepalive / future client commands
    except WebSocketDisconnect:
        pass
    finally:
        await hub.unregister(ws, patient_id)


def _require_patient(patient_id: str) -> dict:
    """Every patient-scoped endpoint passes through here.

    There is no sign-in yet, so this only checks the patient exists. PLAN.md §9
    is explicit that it must become can_access(user, patient_id) before any of
    this leaves a laptop, and this is the one place that check belongs.
    """
    patient = store.get_patient(patient_id)
    if not patient:
        raise HTTPException(404, "patient not found")
    return patient


def _in_meal(patient_id: str) -> bool:
    return meals.meal_id is not None and meals.patient_id == patient_id


def _with_label_check(meal: dict) -> dict:
    """A stored meal plus what the bowl was and how it sat against its label.

    The salinity and per-serving figure are there for every weighed meal,
    declared or not: "which foods" is a question about the bowl, and most
    bowls carry no claim. The label_* keys are None / 'none' without a claim.
    """
    check = cohort.label_check(meal)
    g_l = cohort.meal_salinity_g_l(meal)
    return {
        **meal,
        "mean_salinity_g_l": g_l,
        "mg_per_serving": salinity.sodium_mg(g_l, labels.REFERENCE_SERVING_ML)
        if g_l is not None else None,
        "label_claim_label": labels.CLAIM_LABEL.get(meal["label_claim"]),
        "label_flagged": bool(check and check.flagged),
        "label_severity": check.severity if check else "none",
        "label_ratio": check.ratio if check else None,
        "label_headline": check.headline if check else None,
        "label_detail": check.detail if check else None,
    }


# =============================================================================
# NaTrack API - /v1
# =============================================================================
@app.get("/v1/patients")
def list_patients(
    clinicianId: Optional[str] = None, tz_offset_min: int = 0
) -> list[dict]:
    """The clinician's roster: every patient, with a trailing-window summary."""
    return [
        cohort.summarise(p, tz_offset_min, in_meal=_in_meal(p["patientId"]))
        for p in store.list_patients(clinicianId)
    ]


@app.get("/v1/patients/{patient_id}/summary")
def patient_summary(
    patient_id: str,
    range: Literal["day", "week", "month"] = "week",
    tz_offset_min: int = 0,
) -> dict:
    """Precomputed trend, sodium and pace. `range` sets the length of `daily`;
    the averages always cover the last seven full days."""
    patient = _require_patient(patient_id)
    summary = cohort.summarise(
        patient, tz_offset_min, in_meal=_in_meal(patient_id),
        history_days=cohort.RANGE_DAYS[range],
    )
    return {
        **summary,
        "range": range,
        "meals": [_with_label_check(m) for m in store.list_meals(60, patient_id)],
        "manual_meals": store.list_manual_meals(40, patient_id),
        # Summed server-side over the whole range: the two lists above are
        # capped, so a client adding them up would undercount a month.
        "sources": cohort.sources(
            patient_id, cohort.RANGE_DAYS[range], tz_offset_min, summary["daily"]
        ),
    }


@app.get("/v1/patients/{patient_id}/bites")
def patient_bites(
    patient_id: str,
    since: Optional[str] = Query(None, alias="from"),
    until: Optional[str] = Query(None, alias="to"),
) -> list[dict]:
    """Time-ranged raw bites, oldest first. `from` and `to` are ISO-8601."""
    _require_patient(patient_id)
    try:
        return store.bites_between(patient_id, since, until)
    except ValueError:
        raise HTTPException(400, "from and to must be ISO-8601 timestamps")


class PatientTarget(BaseModel):
    sodiumTarget: float


@app.put("/v1/patients/{patient_id}/target")
def set_patient_target(patient_id: str, body: PatientTarget) -> dict:
    """Set the daily sodium target. Clinician-side only."""
    _require_patient(patient_id)
    if not cohort.TARGET_MIN_MG <= body.sodiumTarget <= cohort.TARGET_MAX_MG:
        raise HTTPException(
            400,
            f"target must be between {cohort.TARGET_MIN_MG} and "
            f"{cohort.TARGET_MAX_MG} mg per day",
        )
    return store.set_patient_target(patient_id, round(body.sodiumTarget))


class HealthLogEntry(BaseModel):
    systolic: Optional[int] = None
    diastolic: Optional[int] = None
    weightKg: Optional[float] = None
    note: Optional[str] = None


# Reject implausible entries (PLAN.md §7). A systolic of 400 is a typo, and a
# typo stored in a medical record misleads whoever reads it next.
HEALTH_RANGES = {"systolic": (60, 260), "diastolic": (30, 160), "weightKg": (20, 350)}

# One self-reported item, mg. 99999 is a typo, and it turns a roster row critical.
MANUAL_MAX_MG = 5000


@app.post("/v1/patients/{patient_id}/health-log")
def add_health_log(patient_id: str, entry: HealthLogEntry) -> dict:
    """The patient logs blood pressure, weight, or a note."""
    _require_patient(patient_id)
    note = (entry.note or "").strip() or None

    if (entry.systolic is None) != (entry.diastolic is None):
        raise HTTPException(400, "blood pressure needs both systolic and diastolic")
    if entry.systolic is None and entry.weightKg is None and note is None:
        raise HTTPException(400, "nothing to log: give a blood pressure, a weight or a note")
    for field, (low, high) in HEALTH_RANGES.items():
        value = getattr(entry, field)
        if value is not None and not low <= value <= high:
            raise HTTPException(400, f"{field} must be between {low} and {high}")
    if entry.systolic is not None and entry.diastolic >= entry.systolic:
        raise HTTPException(400, "diastolic must be lower than systolic")

    return store.add_health_log(
        patient_id, entry.systolic, entry.diastolic, entry.weightKg, note
    )


@app.get("/v1/patients/{patient_id}/health-log")
def list_health_log(patient_id: str, limit: int = 30) -> list[dict]:
    """NaTrack specifies only the write; a log nobody can read is not much use."""
    _require_patient(patient_id)
    return store.list_health_logs(patient_id, limit)


class DevicePairing(BaseModel):
    patientId: str


@app.post("/v1/devices/{device_id}/pair")
async def pair_device(device_id: str, body: DevicePairing) -> dict:
    """Bind a spoon to a patient. Its unannounced meals are theirs from now on."""
    _require_patient(body.patientId)
    device = store.pair_device(device_id, body.patientId)
    # If this is the spoon on the table, it has just changed hands.
    if meals.device_id in (None, device_id) and meals.patient_id != body.patientId:
        await meals.hand_to(body.patientId)
    return device


# =============================================================================
# Everything NaTrack does not cover - /api
# =============================================================================
@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "sample_schema": SAMPLE_SCHEMA,
        "bite_schema": BITE_SCHEMA,
        "active_meal": meals.meal_id,
        "spoon_seen": hub.last_sample is not None or hub.last_bite is not None,
        "probe_temp_range_c": [salinity.PROBE_TEMP_MIN_C, salinity.PROBE_TEMP_MAX_C],
        "recording": recorder.active,
    }


@app.get("/api/spoon")
def spoon() -> dict:
    """Who holds the spoon, and whether they are mid-meal.

    Not called /api/session: in NaTrack a session is the live WebSocket, and
    one word for two things is how this contract got into trouble.

    `sample_age_s` is how long the spoon has been silent. /api/health's
    spoon_seen latches for the life of the process; a spoon that was switched
    off an hour ago is not a connected one. The age is computed here so a
    client's clock cannot be wrong about it.
    """
    sample_age_s: Optional[float] = None
    if hub.last_sample is not None:
        heard = datetime.fromisoformat(hub.last_sample["received_at"])
        sample_age_s = max(0.0, (datetime.now(timezone.utc) - heard).total_seconds())
    return {
        "patientId": meals.patient_id,
        "mealId": meals.meal_id,
        "deviceId": meals.device_id,
        "spoon_seen": hub.last_sample is not None,
        "sample_age_s": sample_age_s,
    }


# --- Meals -------------------------------------------------------------------
@app.get("/api/meals")
def list_meals(limit: int = 25, patientId: str = store.DEFAULT_PATIENT_ID) -> list[dict]:
    _require_patient(patientId)
    return store.list_meals(limit, patientId)


@app.get("/api/meals/{meal_id}")
def meal_detail(meal_id: int) -> dict:
    meal = store.get_meal(meal_id)
    if not meal:
        raise HTTPException(404, "meal not found")
    return meal


class MealStart(BaseModel):
    patientId: str = store.DEFAULT_PATIENT_ID
    product_name: Optional[str] = None
    label_claim: str = "none"


@app.post("/api/meals/start")
async def start_meal(req: MealStart) -> dict:
    """Open a meal for a patient, optionally declaring what is in the bowl.

    Bites still open a meal on their own; this exists so the session belongs to
    the right patient and the label is checked from the first bite.
    """
    _require_patient(req.patientId)
    if req.label_claim not in labels.CLAIM_LABEL:
        raise HTTPException(
            400, f"unknown claim; expected one of {list(labels.CLAIM_LABEL)}"
        )
    meal_id = await meals.start(req.patientId)
    product = (req.product_name or "").strip() or None
    if product or req.label_claim != "none":
        store.set_meal_label(meal_id, product, req.label_claim)
        # meals.start announced the meal before it had a label.
        await meals.announce()
    return {"mealId": meal_id, "patientId": req.patientId}


class MealClose(BaseModel):
    patientId: str


def _require_holder(patient_id: str) -> None:
    """An open meal is its holder's to label or end, and nobody else's."""
    _require_patient(patient_id)
    if meals.meal_id is not None and meals.patient_id != patient_id:
        raise HTTPException(409, "the spoon is in another patient's meal")


@app.post("/api/meals/close")
async def close_meal(req: MealClose) -> dict:
    _require_holder(req.patientId)
    closed = await meals.force_close()
    return {"mealId": closed}


@app.get("/api/devices/{device_id}")
def device(device_id: str) -> dict:
    return store.get_device(device_id)


class VolumeCalibration(BaseModel):
    volume_ml_mean: float
    volume_ml_sd: float


@app.post("/api/devices/{device_id}/volume")
def set_volume(device_id: str, cal: VolumeCalibration) -> dict:
    """Store a scoop-volume calibration. See docs/calibration.md §3."""
    if cal.volume_ml_mean <= 0:
        raise HTTPException(400, "volume_ml_mean must be positive")
    if cal.volume_ml_sd < 0:
        raise HTTPException(400, "volume_ml_sd cannot be negative")
    return store.set_device_volume(device_id, cal.volume_ml_mean, cal.volume_ml_sd)


@app.get("/api/intake/today")
def intake_today(
    patientId: str = store.DEFAULT_PATIENT_ID, tz_offset_min: int = 0
) -> dict:
    patient = _require_patient(patientId)
    totals = store.intake_today(patientId, tz_offset_min)
    ctx = salinity.contextualise(totals["total_sodium_mg"])
    target = patient["sodiumTarget"]
    return {
        **totals,
        "patientId": patientId,
        "sodiumTarget": target,
        "pct_of_target": totals["total_sodium_mg"] / target * 100.0,
        "fda_daily_limit_mg": salinity.FDA_DAILY_LIMIT_MG,
        "aha_ideal_limit_mg": salinity.AHA_IDEAL_LIMIT_MG,
        "pct_of_fda_limit": ctx.pct_of_fda_limit,
        "pct_of_aha_ideal": ctx.pct_of_aha_ideal,
        "verdict": ctx.verdict,
    }


# --- Label claims ------------------------------------------------------------
class MealLabel(BaseModel):
    patientId: str
    product_name: Optional[str] = None
    label_claim: str = "none"


@app.post("/api/meals/label")
async def set_meal_label(label: MealLabel) -> dict:
    """Declare what is being measured, so its claim can be checked.

    This is what makes the potassium flag possible: the sensor supplies the
    ionic content, the label supplies what the product says about itself, and
    the interesting case is where they disagree.

    NaTrack puts potassium alerts out of scope for v1 ("possible to integrate").
    This is that integration, kept outside /v1 for that reason.
    """
    if label.label_claim not in labels.CLAIM_LABEL:
        raise HTTPException(
            400, f"unknown claim; expected one of {list(labels.CLAIM_LABEL)}"
        )
    _require_holder(label.patientId)
    if meals.meal_id is None:
        raise HTTPException(409, "no meal in progress — log a bite first")
    # Stripped as /api/meals/start strips it: a trailing space is not a product.
    product = (label.product_name or "").strip() or None
    store.set_meal_label(meals.meal_id, product, label.label_claim)
    # The session learns the label, and its check, now and not at the next bite.
    await meals.announce()
    return {
        "mealId": meals.meal_id,
        "product_name": product,
        "label_claim": label.label_claim,
    }


@app.get("/api/label-claims")
def label_claims() -> dict:
    """The claims we can check, and their FDA per-serving limits."""
    return {
        "claims": [
            {
                "value": key,
                "label": text,
                "max_sodium_mg_per_serving": labels.CLAIM_MAX_SODIUM_MG_PER_SERVING.get(key),
            }
            for key, text in labels.CLAIM_LABEL.items()
        ],
        "reference_serving_ml": labels.REFERENCE_SERVING_ML,
    }


class LabelCheckRequest(BaseModel):
    salinity_g_l: float
    label_claim: str
    serving_ml: float = labels.REFERENCE_SERVING_ML


@app.post("/api/label-check")
def label_check(req: LabelCheckRequest) -> dict:
    """Check a salinity against a claim without needing a live meal."""
    if req.label_claim not in labels.CLAIM_LABEL:
        raise HTTPException(400, "unknown claim")
    return labels.check(req.salinity_g_l, req.label_claim, req.serving_ml).__dict__


# --- Self-reported food ------------------------------------------------------
class ManualMeal(BaseModel):
    name: str
    sodium_mg: float
    portion: Optional[str] = None
    patientId: str = store.DEFAULT_PATIENT_ID
    # When it was eaten, if not now. Exists for Undo: an entry deleted by
    # mistake and restored keeps its original time, and so its original day.
    ts_utc: Optional[str] = None
    # Exists for Undo as well, and is honoured only beside ts_utc: a seeded
    # entry removed and restored stays tagged, so `seed_demo.py --reset` still
    # removes exactly the seeded rows.
    source: Literal["manual", "seed"] = "manual"


@app.post("/api/manual-meals")
def add_manual_meal(entry: ManualMeal) -> dict:
    """Log something the spoon cannot read.

    The probe only reads liquids, so without this the daily total is blind to
    bread, crackers, cheese and most of what actually carries dietary sodium.
    Stored separately from measured bites and always labelled as self-reported.
    """
    if entry.sodium_mg < 0:
        raise HTTPException(400, "sodium_mg cannot be negative")
    if entry.sodium_mg > MANUAL_MAX_MG:
        raise HTTPException(
            400, f"Sodium for one item must be {MANUAL_MAX_MG:,} mg or less. Check the label."
        )
    if not entry.name.strip():
        raise HTTPException(400, "name is required")
    _require_patient(entry.patientId)

    ts_utc: Optional[str] = None
    if entry.ts_utc is not None:
        try:
            ts_utc = store.normalise_ts(entry.ts_utc)
        except ValueError:
            raise HTTPException(400, "ts_utc must be an ISO-8601 timestamp")
        # A minute of grace for a client clock that runs fast.
        limit = datetime.now(timezone.utc) + timedelta(seconds=60)
        if ts_utc > limit.isoformat(timespec="milliseconds"):
            raise HTTPException(400, "ts_utc cannot be in the future")

    return store.add_manual_meal(
        entry.name.strip(), entry.sodium_mg, entry.portion,
        ts_utc=ts_utc, patient_id=entry.patientId,
        source=entry.source if ts_utc is not None else "manual",
    )


@app.get("/api/manual-meals")
def list_manual_meals(
    limit: int = 25, patientId: str = store.DEFAULT_PATIENT_ID
) -> list[dict]:
    # An unknown patient is a 404, not an empty log.
    _require_patient(patientId)
    return store.list_manual_meals(limit, patientId)


@app.delete("/api/manual-meals/{entry_id}")
def delete_manual_meal(entry_id: int, patientId: str = store.DEFAULT_PATIENT_ID) -> dict:
    _require_patient(patientId)
    if not store.delete_manual_meal(entry_id, patientId):
        raise HTTPException(404, "entry not found")
    return {"deleted": entry_id}


# --- Recording ---------------------------------------------------------------
class RecordingStart(BaseModel):
    label: str = "session"


@app.post("/api/recording/start")
def recording_start(req: RecordingStart) -> dict:
    return {"recording": True, "path": recorder.start(req.label)}


@app.post("/api/recording/stop")
def recording_stop() -> dict:
    return {"recording": False, "path": recorder.stop()}


@app.get("/api/recording")
def recording_status() -> dict:
    return {
        "recording": recorder.active,
        "path": recorder.path,
        "events": recorder.count,
        "available": Recorder.list_recordings(),
    }
