# Telemetry Contract

The contract between firmware, mock, backend and dashboard. Change it here
first, then update all four.

**Naming follows `docs/natrack-system-design.pdf`.** Where NaTrack names a thing
— an entity, a field, an endpoint — that name is used, spelled as NaTrack spells
it (camelCase). Where NaTrack is silent, the field keeps this repo's original
name (snake_case, unit in the name). So the casing of a field tells you whose it
is: `sodiumEstimate` is NaTrack's, `sodium_mg_low` is an extension NaTrack does
not cover. Do not "tidy" the extensions into camelCase; the distinction is the
point, and NaTrack consumers can ignore every snake_case key.

NaTrack names fields but rarely gives them a unit or a format. **This document
does, and it is binding**: a NaTrack name without the unit below is not the
contract.

Two event types, deliberately separate. This is the edge-aggregation principle:
raw samples stay local, and only fused bites become durable records.

| | `sample/v2` | `bite/v2` |
|---|---|---|
| Rate | 5–100 Hz | one per scoop |
| Scope | local only, not persisted long-term | the durable record (NaTrack `BiteEvent`) |
| Purpose | live chart, tuning, debugging | everything else |

`v1` of both used this repo's own names throughout (`ec25_ms_cm`, `ts_utc`,
`sodium_mg`, …). It is retired; the backend rejects it by schema tag.

---

## `bite/v2` — NaTrack `BiteEvent`

```json
{
  "schema": "bite/v2",
  "deviceId": "spoon-01",
  "bite_id": 42,
  "timestamp": "2026-09-19T18:04:12.317Z",

  "salinityIndex": 11.84,
  "tempC": 24.6,
  "salinity_g_l": 6.46,
  "salinity_source": "measured",
  "dilution_factor": 1.0,

  "weightGrams": 10.2,
  "volume_source": "user_calibrated",

  "sodiumEstimate": 25.9,
  "sodium_mg_low": 19.5,
  "sodium_mg_high": 32.4,

  "quality": 0.93,
  "ec_sample_count": 47,
  "biteIntervalSec": 34.1,
  "pace": "green",
  "flags": [],
  "fw_version": "0.2.0"
}
```

### NaTrack fields

| Field | Type, unit | Definition |
|---|---|---|
| `deviceId` | string | Which spoon. In the cloud path the IoT Rule sets it from the topic, so a spoon cannot claim to be another |
| `timestamp` | string | **ISO-8601 UTC with milliseconds**, e.g. `2026-09-19T18:04:12.317Z`. Not epoch. Milliseconds are required: they are what makes `deviceId` + `timestamp` a safe key |
| `salinityIndex` | float, **mS/cm** | Electrical conductivity, temperature-compensated to 25 °C. An *index* of salinity, not salinity: conductivity reads every ion. Was `ec25_ms_cm` |
| `tempC` | float, °C | Liquid temperature. **Must be 0–40 or no bite is logged at all** |
| `weightGrams` | float, g | Mass of food in the bite. Measured by the load-cell spoon; for the volume-calibrated spoon it is calibrated scoop volume × 1.0 g/mL. `volume_source` says which. Was `volume_ml` |
| `sodiumEstimate` | float, **mg** | Computed **on the device**: `salinity_g_l × weightGrams × 0.3934`. (g/L × g is mg of NaCl at 1 g/mL; soups run 1.00–1.03, well inside the error budget.) Was `sodium_mg` |
| `biteIntervalSec` | float s, or `null` | Seconds since the previous bite. `null` for the first bite after boot |
| `flags` | array of strings | Conditions true of this bite, from the vocabulary below. Empty is the normal case |
| `patientId` | string | **Not sent by the device** — a spoon does not know who is holding it. The backend adds it on ingest, from the device's pairing |

`flags` vocabulary. A consumer must ignore values it does not know.

| Flag | Meaning |
|---|---|
| `fast` | The device judged this bite too soon after the last and lit the LED red. The threshold is the device's (15 s on `firmware/spoon`, 6 s on `firmware/loadcell`) and both are placeholders |
| `moving` | Load-cell spoon only: weighed while moving, so `weightGrams` is less accurate |
| `tempUnsettled` | Load-cell spoon only: the temperature probe was still catching up |

### Extensions NaTrack does not cover

| Field | Unit | Notes |
|---|---|---|
| `schema` | — | Reject mismatches loudly |
| `bite_id` | — | Monotonic per boot. Part of the dedupe key, below |
| `salinity_g_l` | g/L NaCl-equivalent | From `salinityIndex` via the calibrated **quadratic** curve. Not a linear factor |
| `salinity_source` | — | `measured` \| `bowl_reference` — see below |
| `dilution_factor` | — | 1.0 normally. Applied **after** the conversion to g/L |
| `volume_source` | — | Where `weightGrams` came from: `load_cell` \| `user_calibrated` \| `default` |
| `sodium_mg_low/high` | mg | The range `sodiumEstimate` actually carries |
| `quality` | 0–1 | Trust score, see below |
| `ec_sample_count` | — | EC samples behind this bite. Low count = suspect |
| `pace` | — | `green` \| `yellow` \| `red`. The LED's state; `red` is what sets the `fast` flag |

### `salinity_source`

`measured` — the probe read this bite directly, in range and settled.

`bowl_reference` — inherited from an earlier in-range measurement of the same
vessel. The bite is still real (the IMU counted it), but the salinity is carried
forward rather than freshly measured.

Dissolved NaCl diffuses to uniformity, so carrying a bowl reading forward is
sound chemistry. The dashboard still labels it, because a measured number and an
inherited one are not the same claim.

### Dedupe key

NaTrack: partition key `patientId`, sort key `timestamp`, idempotent writes
keyed on `deviceId` plus `timestamp`.

```
PK: PATIENT#{patientId}
SK: BITE#{timestamp}#{deviceId}#{bite_id}
```

`bite_id` is appended. For a replayed bite all three parts are identical, so it
dedupes exactly as NaTrack specifies. It is there for the case NaTrack's key
alone gets wrong: an earlier design keyed on timestamp plus device with
one-second timestamps, and an idempotency guard silently discarded the second of
two genuine bites — data loss disguised as deduplication. Millisecond timestamps
make that collision implausible; `bite_id` makes it impossible. SQLite enforces
the same thing as `UNIQUE(deviceId, timestamp, bite_id)`.

### Validation on ingest

| Field | Accepted | Otherwise |
|---|---|---|
| `tempC` | 0–40 | **Bite refused.** Not flagged, not stored: refused. See `docs/measurement-protocol.md` |
| `schema` | `bite/v2` | Refused with an error naming the schema |
| everything else | type-checked | Refused with the validation error |

---

## NaTrack `MealSummary`

Derived by the backend, never sent by a device. Recomputed from the meal's bites
on every insert.

| Field | Type, unit | Definition |
|---|---|---|
| `mealId` | int | |
| `patientId`, `deviceId` | string | |
| `start`, `end` | ISO-8601 UTC | `end` is `null` while the meal is open |
| `biteCount` | int | |
| `totalSodium` | float, mg | Sum of `sodiumEstimate` |
| `avgBiteIntervalSec` | float s, or `null` | Mean `biteIntervalSec`, **excluding the meal's first bite** — its interval spans the hours since the previous meal |
| `minBiteIntervalSec` | float s, or `null` | The quickest bite, same exclusion |
| `paceFlag` | bool | More than half the meal's bites carry the `fast` flag. A placeholder rule, like the LED thresholds it rests on: it reports what the device saw and claims nothing clinical |

Extensions: `total_sodium_mg_low`, `total_sodium_mg_high`, `total_weight_g`,
`product_name`, `label_claim`.

In `GET /v1/patients/{id}/summary` each meal also carries what the bowl was and
how it sat against its label. All derived from the stored totals, none stored:

| Field | Type, unit | Definition |
|---|---|---|
| `mean_salinity_g_l` | float g/L NaCl-equivalent, or `null` | `totalSodium / (0.3934 × total_weight_g)`: the weight-averaged salinity of the bowl. Present for every weighed meal, declared or not. `null` only when `total_weight_g` is 0 |
| `mg_per_serving` | float mg, or `null` | Sodium in a 240 mL reference serving at that salinity. `null` with `mean_salinity_g_l` |
| `label_claim_label` | string | The claim in words, e.g. `Low sodium` |
| `label_flagged` | bool | The mean is at least 2× the claim's limit |
| `label_severity` | `none` \| `info` \| `warning` | `info` is 1–2× the limit: over the claim, under the flag. It is **not** "consistent with the label". `none` covers both a consistent meal and a meal with no check |
| `label_ratio` | float, or `null` | `mg_per_serving` over the claim's per-serving limit. `null` with no claim, or a claim with no absolute limit (`reduced_sodium`) |
| `label_headline`, `label_detail` | string, or `null` | The check in words. `null` when there is no claim to check |

**Meal grouping.** A meal is a run of bites from one device with no gap longer
than 20 minutes (`MEAL_GAP_MINUTES`), or an explicit start and end from the
patient portal. The gap is enforced by the server's clock as well as by the next
bite: an open meal that has been neither started nor fed for 20 minutes is closed
by a timer (`MealTracker.close_if_idle`, checked every 30 s) and `meal_ended` is
sent, so a patient who puts the spoon down is not "in a meal" until tomorrow.

## Other NaTrack entities

| Entity | NaTrack fields | Extensions |
|---|---|---|
| `Patient` | `patientId`, `sodiumTarget` (mg/day), `clinicianId`, `condition` | `name`, `age`, `enrolled_at` |
| `Device` | `deviceId`, `patientId`, `calibration` (object), `status` (`paired` \| `unpaired`) | inside `calibration`: `volume_ml_mean`, `volume_ml_sd`, `volume_source`, `coeff_a`, `coeff_b` |
| `HealthLog` | `patientId`, `timestamp`, `systolic` (mmHg), `diastolic` (mmHg), `weightKg`, `note` | `id` |
| `Clinician` | `userId`, `role` | `name` |

`HealthLog` entries are patient-entered and range-checked on write: systolic
60–260, diastolic 30–160, `weightKg` 20–350. A typo in medical data misleads a
clinician, so an implausible value is rejected, not stored with a warning.

**Upward drift.** NaTrack says a clinician "is flagged on upward drift" and does
not define it. Here: the mean daily sodium over the last 7 full days is at least
15 % above the mean over the 7 days before that, with at least 3 logged days in
each window. Days with nothing logged are excluded, never counted as zero.

---

## REST

NaTrack's endpoints, at NaTrack's paths. Responses carry the entities above.

| Endpoint | Returns |
|---|---|
| `GET /v1/patients?clinicianId=` | Patients with a trailing-window summary each |
| `GET /v1/patients/{id}/summary?range=day\|week\|month` | One patient: summary, a `daily` series of 1 / 8 / 30 days, `MealSummary` rows, self-reported food |
| `GET /v1/patients/{id}/bites?from=&to=` | `BiteEvent`s, oldest first. `from` / `to` are ISO-8601 |
| `PUT /v1/patients/{id}/target` | Body `{"sodiumTarget": 1500}`. 500–5000 |
| `POST /v1/patients/{id}/health-log` | Body: any of `systolic` + `diastolic`, `weightKg`, `note` |
| `POST /v1/devices/{id}/pair` | Body `{"patientId": "demo-2"}` |

`daily` ends on today. For `range=week` it is **8 rows**: the seven full days
the averages and `days_over_target` cover, then today, so the finished days a
chart draws are exactly the days the summary counted. `month` is 30 rows, today
included.

Not in NaTrack, kept under `/api/`: meal start/close/label, self-reported food,
today's intake, the label check, device calibration, recording, and
`GET /v1/patients/{id}/health-log` (NaTrack specifies only the write).

### Days carry their range

Every row of `daily` (and `today`), and `GET /api/intake/today`, carries the
range beside each sodium figure. All mg.

| Field | Definition |
|---|---|
| `measured_sodium_mg_low`, `measured_sodium_mg_high` | Sum of the day's bites' `sodium_mg_low` / `sodium_mg_high` |
| `total_sodium_mg_low`, `total_sodium_mg_high` | The measured range plus `manual_sodium_mg` as entered. Self-reported food carries no range of its own |

A linear sum, the same method a meal's `total_sodium_mg_low/high` uses. It
overstates a day's spread, because random scoop error cancels as √n; it is kept
because it is the one error model the contract already has. A day with
`logged: false` has all four at 0 and is still not a zero day.

### `sources` — where the logged sodium came from

In `GET /v1/patients/{id}/summary`, covering the same local days as `daily`
(today included). Summed server-side because `meals` and `manual_meals` in the
same response are capped at 60 and 40 rows.

| Field | Type, unit | Definition |
|---|---|---|
| `days` | int | Length of the range, as `daily` |
| `days_logged` | int | Days in `daily` with `logged: true` |
| `total_sodium_mg`, `measured_sodium_mg`, `manual_sodium_mg` | float, mg | Sums over `items` |
| `items` | array | Sorted by `sodium_mg`, largest first. A sort order, not a score |

Each item:

| Field | Type, unit | Definition |
|---|---|---|
| `kind` | `measured` \| `manual` | Spoon-measured meals, or self-reported food. **Never merged into one row**, even under the same name |
| `name` | string, or `null` | Measured: `product_name`; `null` means the product was never declared. Manual: the entry's name. Both are grouped ignoring case and surrounding spaces, and shown as most recently typed |
| `portion` | string, or `null` | Manual only: the most recent entry's portion |
| `label_claim`, `label_claim_label` | string, or `null` | Measured only. Meals group by product **and** claim |
| `count` | int | Meals, or entries |
| `sodium_mg` | float, mg | |
| `share_pct` | float, 0–100 | Of `total_sodium_mg` — of **logged** sodium, not of what the patient ate. 0 when nothing was logged |
| `mean_salinity_g_l` | float g/L NaCl-equivalent, or `null` | Measured only: Σ `totalSodium` / (0.3934 × Σ `total_weight_g`) |
| `mg_per_serving` | float mg, or `null` | Measured only: per 240 mL reference serving |
| `flagged_count` | int | Meals in the group whose own label check is flagged |

A meal is placed by its `start` and a `daily` row by each bite's `timestamp`, so
a bowl eaten across the range's first midnight can leave `total_sodium_mg` a few
bites away from the sum of `daily`.

### `GET /api/spoon`

`patientId`, `mealId`, `deviceId` — who holds the spoon — plus:

| Field | Type, unit | Definition |
|---|---|---|
| `spoon_seen` | bool | A `sample/v2` has arrived since the backend started. Says nothing about now |
| `sample_age_s` | float s, or `null` | Seconds since the last sample, **by the server's clock**, so a client's clock skew cannot matter. `null` until the first sample. This is the liveness signal: `/api/health`'s `spoon_seen` latches for the life of the process |

### `POST /api/manual-meals`

Body `name`, `sodium_mg`, optional `portion`, `patientId`, `ts_utc`, `source`.

| Field | Accepted | Otherwise |
|---|---|---|
| `sodium_mg` | 0–5,000 mg for one item | 400. 99999 is a typo, and one typo turns a roster row critical |
| `ts_utc` | ISO-8601, no more than 60 s ahead of the server. Stored as UTC with milliseconds. Omitted means now | 400. Exists for Undo: a deleted entry restored keeps its original time, and so its original day |
| `source` | `manual` (default) or `seed`. Honoured only together with `ts_utc`; otherwise stored as `manual` | 422. Exists for Undo only: a seeded entry removed and restored stays tagged, so `seed_demo.py --reset` still removes exactly the seeded rows |

`GET /api/manual-meals`, `DELETE /api/manual-meals/{id}` and `GET /api/meals` answer
404 for an unknown `patientId`, like every other patient-scoped endpoint: an
unknown patient is not an empty log.

---

## `sample/v2`

Local telemetry. Never persisted beyond the session, never leaves the machine —
NaTrack's cloud never sees it. It still uses NaTrack's names for the quantities
it shares with a bite (`deviceId`, `tempC`, `salinityIndex`): one quantity, one name.

```json
{
  "schema": "sample/v2",
  "deviceId": "spoon-01",
  "seq": 1042,
  "uptime_ms": 208400,

  "tempC": 24.6,
  "temp_in_range": true,
  "salinityIndex": 11.84,
  "salinity_g_l": 6.46,

  "imu": { "ax": 0.02, "ay": -0.11, "az": 9.78,
           "gx": 0.01, "gy": 0.00, "gz": 0.03 },

  "motion": "still",
  "submerged": true,
  "state": "CAPTURE",
  "quality": 0.93
}
```

`state` is the bite detector's current state (see `docs/bite-detection.md`),
exposed so the dashboard can show the machine working rather than just its
output. It is the single most useful field when tuning thresholds.

`temp_in_range` is `0 ≤ tempC ≤ 40`. When false, no bite can be logged regardless
of anything else.

---

## Quality

An EC probe in air reads near zero. A probe in liquid being stirred reads
turbulence and bubbles. Charting either as "salinity" produces a graph of noise
and a sodium figure that is simply wrong.

`quality` fuses three independent failure modes into one number:

- **submerged** — EC floor combined with a temperature shift from ambient
- **settled** — gyroscope magnitude below threshold for a sustained window
- **stable** — low rolling standard deviation on the EC signal itself

Samples below `QUALITY_THRESHOLD` (0.6) are drawn faintly on the live chart and
**excluded from every number the system reports**. A bite's salinity is the
**median** of its trusted samples, never the mean, so one bubble against the
probe cannot move a sodium figure.

The MPU-6050 is not decoration. It is the gate that decides which EC readings are
allowed to count.

---

## Live session — `/session/{patientId}`

NaTrack: a WebSocket per patient, onto which the backend pushes each new bite.
A session receives that patient's events and nothing about anyone else.

An unknown `patientId` is accepted and then closed with code **4404** (reason
`patient not found`). Clients must not retry on 4404; any other close is a lost
server and is retried.

```json
{ "type": "spoon", "holder": true, "busy": false, "mealId": 7,
  "product_name": "Heart-Smart Broth", "label_claim": "low_sodium",
  "label_check": { } }
{ "type": "meal_started", "mealId": 7, "patientId": "demo-1" }
{ "type": "bite", "received_at": "...", "mealId": 7, "patientId": "demo-1",
  "data": { "...": "bite/v2" }, "meal_totals": { "...": "MealSummary totals" },
  "label_check": { } }
{ "type": "sample", "received_at": "...", "mealId": 7, "patientId": "demo-1",
  "data": { "...": "sample/v2" } }
{ "type": "meal_ended", "mealId": 7, "patientId": "demo-1" }
{ "type": "error", "detail": "bite rejected: 55.0 °C outside probe range 0–40 °C" }
```

`spoon` is sent on connect and whenever it changes. `holder` — this patient has
the spoon, so `sample`s will follow. `busy` — someone else is mid-meal with it;
deliberately says no more than that, because who is eating is another patient's
health data. `mealId` is this patient's open meal, for backfilling a page opened
mid-meal.

`product_name`, `label_claim` and `label_check` are what the holder declared for
their open meal, and how it sits against that claim. They are re-sent when the
label is set (`POST /api/meals/start`, `POST /api/meals/label`), so a session
learns the label without waiting for a bite. For everyone but the holder, and
with no meal open, they are `null`, `"none"` and `null`: nothing about another
patient's bowl is sent.

`POST /api/meals/label` takes `{"patientId", "product_name", "label_claim"}` and
`POST /api/meals/close` takes `{"patientId"}`. `patientId` is required on both:
it goes through the same patient check as every other patient-scoped call, and
the answer is `409` ("the spoon is in another patient's meal") when the open
meal is not that patient's. `product_name` is stored stripped, as
`POST /api/meals/start` stores it.

`label_check`, here and on `bite`, is the label check of the **meal's mean**
salinity so far — the same judgement `GET …/summary` makes of the finished meal
— plus `product_name`. It was the single bite's; near the 2× threshold that
flipped the flag on and off from one spoonful to the next. It is `null` until a
bite has been weighed. With `label_claim` `none` it is still present, unflagged,
carrying `measured_mg_per_serving`.

On connect the holder is primed with the last `bite` of the **open** meal (never
a closed one's) and the last `sample`. The primer bite carries the label check
as it stands at connect, not as it stood when the bite landed — the label may
have been declared since. The primer sample keeps its original `received_at`,
which is how a client tells a spoon switched off an hour ago from a live one.

`sample` is an extension: NaTrack pushes bites only. It reaches the holder's
sessions and exists for the live trace and for tuning.

The envelope (`type`, `received_at`, `data`, `meal_totals`, `label_check`) is
this repo's; NaTrack does not specify one.
