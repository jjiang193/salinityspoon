# Telemetry Contract

The contract between firmware, mock, backend and dashboard. Change it here
first, then update all four.

Two event types, deliberately separate. This is the edge-aggregation principle:
raw samples stay local, and only fused bites become durable records.

| | `sample/v1` | `bite/v1` |
|---|---|---|
| Rate | 5–100 Hz | one per scoop |
| Scope | local only, not persisted long-term | the durable record |
| Purpose | live chart, tuning, debugging | everything else |

**Every numeric field carries its unit in its name.** No exceptions — this is the
rule that prevents the `salinity` / `salinity_mScm` / `salinityIndex` drift that
cost the earlier design three incompatible spellings of one field.

---

## `bite/v1`

```json
{
  "schema": "bite/v1",
  "device_id": "spoon-01",
  "bite_id": 42,
  "ts_utc": "2026-09-19T18:04:12.317Z",

  "ec25_ms_cm": 11.84,
  "temp_c": 24.6,
  "salinity_g_l": 6.46,
  "salinity_source": "measured",
  "dilution_factor": 1.0,

  "volume_ml": 10.2,
  "volume_source": "user_calibrated",

  "sodium_mg": 25.9,
  "sodium_mg_low": 19.5,
  "sodium_mg_high": 32.4,

  "quality": 0.93,
  "ec_sample_count": 47,
  "seconds_since_prev_bite": 34.1,
  "pace": "green",
  "fw_version": "0.2.0"
}
```

| Field | Unit | Notes |
|---|---|---|
| `schema` | — | Reject mismatches loudly |
| `bite_id` | — | Monotonic per boot. With `ts_utc`, uniquely identifies a bite |
| `ts_utc` | — | **ISO-8601 UTC, milliseconds.** Not epoch seconds |
| `ec25_ms_cm` | mS/cm | Temperature-compensated to 25 °C |
| `temp_c` | °C | Must be ≤ 40 or no bite is logged at all |
| `salinity_g_l` | g/L NaCl | From `ec25_ms_cm` via the calibrated curve |
| `salinity_source` | — | `measured` \| `bowl_reference` — see below |
| `dilution_factor` | — | 1.0 normally. Applied **after** EC→g/L conversion |
| `volume_ml` | mL | Calibrated scoop mean, not a live measurement |
| `volume_source` | — | `user_calibrated` \| `default` |
| `sodium_mg` | mg | `salinity_g_l × volume_ml/1000 × 393.4` |
| `sodium_mg_low/high` | mg | From the scoop volume's standard deviation |
| `quality` | 0–1 | Trust score, see below |
| `ec_sample_count` | — | EC samples behind this bite. Low count = suspect |
| `pace` | — | `green` \| `yellow` \| `red` |

### `salinity_source`

`measured` — the probe read this bite directly, in range and settled.

`bowl_reference` — inherited from an earlier in-range measurement of the same
vessel. The bite is still real (the IMU counted it), but the salinity is carried
forward rather than freshly measured.

Dissolved NaCl diffuses to uniformity, so carrying a bowl reading forward is
sound chemistry. The dashboard still labels it, because a measured number and an
inherited one are not the same claim.

### Sort key, for a future cloud migration

```
PK: PATIENT#{patient_id}
SK: BITE#{ts_utc}#{bite_id}
```

`bite_id` is in the key deliberately. Keying on timestamp plus device alone lets
two genuine bites in the same second collide, and an idempotency guard would
then silently discard the second one — data loss disguised as deduplication.

---

## `sample/v1`

Local telemetry. Never persisted beyond the session, never leaves the machine.

```json
{
  "schema": "sample/v1",
  "device_id": "spoon-01",
  "seq": 1042,
  "uptime_ms": 208400,

  "temp_c": 24.6,
  "temp_in_range": true,
  "ec25_ms_cm": 11.84,
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

`temp_in_range` is `temp_c ≤ 40`. When false, no bite can be logged regardless
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

## Backend → dashboard

The backend rebroadcasts on `/ws/live` with server context added:

```json
{ "type": "sample", "received_at": "...", "meal_id": 7, "data": { ... } }
{ "type": "bite",   "received_at": "...", "meal_id": 7, "data": { ... } }
```

Other message types: `meal_started`, `meal_ended`, `status`, `error`.
