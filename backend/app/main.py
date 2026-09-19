"""Salinity Spoon backend.

    uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

--host 0.0.0.0 matters: the ESP32 connects from another machine on the network,
so binding to localhost makes the spoon invisible.
"""

import json

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError

from . import salinity, store
from .hub import Hub, MealTracker
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


@app.on_event("startup")
def _startup() -> None:
    store.init_db()


# --- Ingest ------------------------------------------------------------------
@app.websocket("/ws/ingest")
async def ws_ingest(ws: WebSocket) -> None:
    """The spoon (or tools/mock_spoon.py) connects here.

    Accepts both sample/v1 and bite/v1 on one socket, dispatched on the
    `schema` field.
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

            kind = payload.get("schema")
            try:
                if kind == SAMPLE_SCHEMA:
                    await _handle_sample(payload)
                elif kind == BITE_SCHEMA:
                    await _handle_bite(payload)
                else:
                    await ws.send_text(
                        json.dumps({"type": "error", "detail": f"unknown schema {kind!r}"})
                    )
            except ValidationError as exc:
                await ws.send_text(json.dumps({"type": "error", "detail": str(exc)}))
    except WebSocketDisconnect:
        pass


async def _handle_sample(payload: dict) -> None:
    Sample.model_validate(payload)  # validate, then forward verbatim
    message = {
        "type": "sample",
        "received_at": utcnow_iso(),
        "meal_id": meals.meal_id,
        "data": payload,
    }
    hub.last_sample = message
    await hub.broadcast(message)


async def _handle_bite(payload: dict) -> None:
    bite = Bite.model_validate(payload)

    # The interlock is enforced here too, not only on the device. A bite
    # measured outside the probe's range is not a less-precise bite, it is an
    # unsupported one, and it must not enter the record.
    if not salinity.temp_in_range(bite.temp_c):
        await hub.broadcast(
            {
                "type": "error",
                "detail": f"bite rejected: {bite.temp_c} °C outside probe range "
                          f"{salinity.PROBE_TEMP_MIN_C}–{salinity.PROBE_TEMP_MAX_C} °C",
            }
        )
        return

    meal_id = await meals.assign(payload)
    stored = store.insert_bite(meal_id, payload)
    if not stored:
        return  # idempotent replay, already recorded

    totals = store.recompute_meal(meal_id)

    message = {
        "type": "bite",
        "received_at": utcnow_iso(),
        "meal_id": meal_id,
        "data": payload,
        "meal_totals": totals,
    }
    hub.last_bite = message
    await hub.broadcast(message)


# --- Live feed ---------------------------------------------------------------
@app.websocket("/ws/live")
async def ws_live(ws: WebSocket) -> None:
    """The dashboard connects here."""
    await ws.accept()
    await hub.register(ws)
    try:
        # Prime a freshly-opened tab so it is not staring at an empty chart.
        for primer in (hub.last_bite, hub.last_sample):
            if primer:
                await ws.send_text(json.dumps(primer))
        while True:
            await ws.receive_text()  # keepalive / future client commands
    except WebSocketDisconnect:
        pass
    finally:
        await hub.unregister(ws)


# --- REST --------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "sample_schema": SAMPLE_SCHEMA,
        "bite_schema": BITE_SCHEMA,
        "active_meal": meals.meal_id,
        "spoon_seen": hub.last_sample is not None or hub.last_bite is not None,
        "probe_temp_range_c": [salinity.PROBE_TEMP_MIN_C, salinity.PROBE_TEMP_MAX_C],
    }


@app.get("/api/meals")
def list_meals(limit: int = 25) -> list[dict]:
    return store.list_meals(limit)


@app.get("/api/meals/{meal_id}")
def meal_detail(meal_id: int) -> dict:
    meal = store.get_meal(meal_id)
    if not meal:
        raise HTTPException(404, "meal not found")
    return meal


@app.post("/api/meals/close")
async def close_meal() -> dict:
    closed = await meals.force_close()
    return {"closed_meal_id": closed}


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
def intake_today() -> dict:
    totals = store.intake_today()
    ctx = salinity.contextualise(totals["total_sodium_mg"])
    return {
        **totals,
        "fda_daily_limit_mg": salinity.FDA_DAILY_LIMIT_MG,
        "aha_ideal_limit_mg": salinity.AHA_IDEAL_LIMIT_MG,
        "pct_of_fda_limit": ctx.pct_of_fda_limit,
        "pct_of_aha_ideal": ctx.pct_of_aha_ideal,
        "verdict": ctx.verdict,
    }
