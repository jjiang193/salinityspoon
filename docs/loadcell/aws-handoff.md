# AWS handoff for the load-cell firmware

How `firmware/loadcell/` sends bites to AWS, following
`docs/natrack-system-design.pdf`.

**The message is `bite/v2`, defined in `docs/telemetry-schema.md`.** That file is
the contract; this one is only the AWS plumbing around it. An earlier draft of
this page had its own field names (`salinity`, `weightG`, `gapS`, `ts` in epoch
ms) and computed sodium in the Lambda. That draft is retired: there is one bite,
and the local backend, the simulator and the dashboard already speak it.

Still not built. `PLAN.md` defers AWS until hardware bring-up is done, and the
load-cell firmware has no Wi-Fi or MQTT code yet. When that code is written, it
sends exactly the JSON below.

## 1. Connection

| Item | Value |
|---|---|
| Path | ESP32 → Wi-Fi → AWS IoT Core (MQTT/TLS, port 8883) → IoT Rule → **SQS** → batch Lambda → DynamoDB |
| Thing / MQTT client ID | `spoon-01` |
| Topic | `devices/spoon-01/bites` |
| IoT Rule | `SELECT *, topic(2) AS deviceId FROM 'devices/+/bites'` → SQS queue `bite-ingest` |
| Lambda | `ingestBite`, triggered by the queue in batches |
| IoT policy | Connect as `spoon-01`, publish to that one topic only |
| Delivery | QoS 1 + resend after Wi-Fi drops, and SQS is at-least-once, so **a bite can arrive twice**. The write must be idempotent. |
| Rate | One message per bite (~every 5–60 s while eating). Nothing while idle, no raw sensor data. |
| Size | ~450 bytes. Give the ESP32 JSON document 768 |

The queue is NaTrack's: it absorbs the meal-time spike and gives retries for
free. `topic(2) AS deviceId` overwrites whatever `deviceId` the payload claims,
so a spoon cannot impersonate another.

The firmware side needs the IoT endpoint (`xxxx-ats.iot.<region>.amazonaws.com`),
device certificate, private key and `AmazonRootCA1.pem`, shared privately.
**Never in git or chat.**

## 2. Bite message

`bite/v2` exactly as in `docs/telemetry-schema.md`. From the load-cell spoon:

```json
{
  "schema": "bite/v2",
  "deviceId": "spoon-01",
  "bite_id": 7,
  "timestamp": "2026-09-19T18:04:12.317Z",
  "salinityIndex": 10.11,
  "tempC": 36.8,
  "salinity_g_l": 5.43,
  "salinity_source": "measured",
  "dilution_factor": 1.0,
  "weightGrams": 11.4,
  "volume_source": "load_cell",
  "sodiumEstimate": 24.4,
  "sodium_mg_low": 17.1,
  "sodium_mg_high": 31.7,
  "quality": 0.9,
  "ec_sample_count": 25,
  "biteIntervalSec": 3.8,
  "pace": "red",
  "flags": ["fast"],
  "fw_version": "0.2.0"
}
```

What the load-cell firmware has to map, from its `Bite` struct:

| Struct field | Wire field | Note |
|---|---|---|
| `salinityMsCm` | `salinityIndex` | mS/cm at 25 °C. **Conductivity, not salinity** — the word "salinity" alone is ambiguous by a factor of two, which is why neither name uses it bare |
| `tempC` | `tempC` | **Must be 0–40 °C or the bite is not sent.** See below |
| `weightG` | `weightGrams` | Eaten = loaded − leftover. `volume_source: "load_cell"` |
| `sodiumMg`, `…LowMg`, `…HighMg` | `sodiumEstimate`, `sodium_mg_low`, `sodium_mg_high` | Computed on the device, as NaTrack specifies |
| `heldStill == false` | `"moving"` in `flags` | |
| `tempSettled == false` | `"tempUnsettled"` in `flags` | |
| gap < `TOO_FAST_MS` | `"fast"` in `flags`, `pace: "red"` | The 6 s threshold is a placeholder |
| `ms` (millis since boot) | `timestamp` | Needs NTP: ISO-8601 UTC **with milliseconds**, not epoch |
| — | `salinity_g_l` | From `salinityIndex` by the **quadratic** curve in `backend/app/salinity.py`, not the flat ×0.55. The flat factor reads ~2 % high at 10 mS/cm and drifts further from there |

`loadedG` and `leftoverG` are not in `bite/v2`. If they earn their place, add them
to the contract first, as extensions (`loaded_g`, `leftover_g`).

Not sent: raw motion data, any patient identity. `patientId` is added on ingest,
from the device's pairing.

### Two things this firmware does not do yet, and must

**The 40 °C interlock.** The DFR0300 probe is rated 0–40 °C, and `HANDOFF.md`
lists the refusal as a hard constraint: above it the compensation was never
characterised, so a reading is not less precise, it is unsupported.
`firmware/loadcell/` currently lets temperature "only widen the range, never
block a bite". It has to refuse, as `firmware/spoon/` does, and the ingest below
refuses again. An earlier draft of this page used a 44.8 °C bite as its example;
that bite must never exist.

**The EC-to-NaCl curve.** Use the quadratic, per the table above.

## 3. Lambda `ingestBite`

1. **Validate:** `schema` is `bite/v2`; `tempC` 0–40 (**refuse**, do not flag);
   `weightGrams` 0–100 (load cell max); `salinityIndex` 0–20 (probe ceiling);
   `timestamp` within ±1 day of now. Reject otherwise.
2. **Find the patient** from pairing item `DEVICE#<deviceId>` → `PATIENT#<id>`,
   written by `POST /v1/devices/{id}/pair`. Fixed demo patient until a spoon is
   paired.
3. **Do not compute sodium.** The device sends `sodiumEstimate`. Store every raw
   field too, so old bites can be recomputed if the curve is recalibrated — that
   benefit does not need the computation to live in the cloud.
4. **Write** PK `PATIENT#<patientId>`, SK `BITE#<timestamp>#<deviceId>#<bite_id>`,
   with `ConditionExpression: attribute_not_exists(SK)` to drop duplicates.
   `bite_id` is in the key on purpose: see "Dedupe key" in the contract.
5. **Push** the stored bite to the API Gateway WebSocket for anyone on
   `session/<patientId>`. Best effort; the table is the source of truth.
6. **Never log the payload.** Once linked to a patient it's health data. Log
   request IDs and status only.

A Streams-triggered Lambda derives `MealSummary` rows (totals,
`avgBiteIntervalSec`, `minBiteIntervalSec`, `paceFlag`) by the rules in the
contract. `backend/app/store.py: recompute_meal` is a working reference.

## 4. Dashboard

Already built, against the local backend, which serves NaTrack's endpoints at
NaTrack's paths (`/v1/patients`, `/v1/patients/{id}/summary`, …,
`/session/{patientId}`). Pointing it at AWS is a change of base URL and adding
Cognito, not a rewrite.

## 5. Test without hardware

IoT Core → MQTT test client → publish the JSON above to `devices/spoon-01/bites`.
One item should appear with `deviceId: "spoon-01"` and a `patientId`. Publish it
again: still one item. Change `tempC` to 44.8 and publish: no item.

The same JSON can be checked today without AWS: send it to the local backend's
`ws://localhost:8000/ws/ingest` and it is validated, stored and pushed to the
live session exactly as the Lambda should.
