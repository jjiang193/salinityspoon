# Sodium Sensing Spoon — System Plan (v2)

Supersedes the three source documents (`HopHacks_System_Design.pdf`,
`ESP32_to_DynamoDB.pdf`, `salinity-system-reference.html`). Where this
disagrees with them, this wins.

This is the decision record — *why* the system is shaped the way it is. The
authoritative specifications live in `docs/`; where this and a doc disagree, the
doc wins.

Ported from the v1 skeleton (`jjiang193/hophacks`), per §9.

---

## 1. Decisions locked

| Decision | Choice | Why |
|---|---|---|
| Operating range | **0–40 °C liquids**, framed as measuring salt | The DFR0300 probe's rating. Not hot soup — see §3 |
| Per-bite mass | **Fixed spoon volume**, no load cell | §2 — averaging beats precision here, and the cell was the largest schedule risk |
| Cloud | **Local only** (FastAPI + SQLite) | Hardware and bite detection must work first; schema is shaped for AWS migration |
| EC front-end | **ADS1115 mandatory** | Per-bite timing needs 100+ Hz sampling, which the internal ADC cannot deliver cleanly |
| Feedback | **LED pace cue** on device | No OLED; dashboard carries detail |
| Out-of-range | **Hard interlock**, enforced on device *and* server | An unsupported reading must be impossible to record, not merely discouraged |
| Record granularity | **Bite event** is the durable record; samples are local-only telemetry | Edge aggregation, per the original design doc's deep dive |

### Dropped from the source documents

- **Load cell + HX711.** Frees GPIO16/17 and removes the interrupt-timing
  conflict described in §7.
- **AWS IoT Core / Lambda / DynamoDB / Cognito**, deferred. Not deleted —
  §8 keeps the migration path cheap.
- **Potassium-substitute flag** moves from "can do now" to future work. Its
  prerequisite (barcode or label entry) does not exist yet, and as written it is
  a safety claim for kidney patients, which conflicts with the project's own
  "monitoring, not diagnosis" framing.

---

## 2. The volume model (replaces weight)

> Settled. Implemented in `backend/app/salinity.py` and
> `firmware/spoon/config.h`; protocol in `docs/calibration.md` §3.

### Why this is defensible, with numbers

A scoop's volume varies. Call the per-scoop standard deviation σ and the mean μ.
Realistic figures for a soup spoon: μ ≈ 10 mL, σ ≈ 2.5 mL.

- **Per bite:** CV = σ/μ = **25%**. Genuinely imprecise.
- **Per meal (n = 30 bites):** the total's standard deviation is σ√n = 2.5 × √30
  = 13.7 mL on a mean of 300 mL → CV = **4.6%**.

Scoop-to-scoop variation is random, so it cancels across a meal. The meal total —
the number a clinician actually reads — is roughly **five times more accurate than
any single bite**, from zero additional hardware.

This is exactly the precision the pitch already claims ("we sell the loop, not the
number"; "an estimate with a range"). A load cell would have bought per-bite
precision the project explicitly disclaims needing, at the cost of the hardest
mechanical problem in the build.

### What does not average out

Systematic bias does. If someone consistently underfills, the mean is wrong and
stays wrong. Mitigation: **calibration is per-user**, not per-device. Frame this
as a feature — a personalised scoop profile — because it is both honest and true.

### Calibration protocol

Run once per user, ~10 minutes:

1. Fill the bowl with water. Record mass.
2. Take 20 scoops, discarding each. **Weigh each scoop individually** on the
   0.1 g scale.
3. Compute mean and standard deviation. Water at 1.0 g/mL means grams ≈ mL;
   for soup use 1.02 g/mL.
4. Store `volume_ml_mean` and `volume_ml_sd` in the device profile.

The standard deviation is not diagnostic overhead — it **is** the reported error
bar. `sodium_mg_low/high` come directly from it (§3).

Quick recalibration: bulk method — weigh the bowl before and after 20 scoops,
divide. Gives the mean only, no error bar.

### Formula

```
salinity_g_l  = A·ec25 + B·ec25²            (per-probe fit, see calibration doc)
sodium_mg     = salinity_g_l × (volume_ml / 1000) × 393.4
sodium_mg_low = same, with (volume_ml_mean − volume_ml_sd)
sodium_mg_high= same, with (volume_ml_mean + volume_ml_sd)
```

393.4 mg sodium per gram of NaCl. (The source HTML has this right: "salt g × 393
= sodium mg".)

Worked example: 5.12 g/L at 10.2 mL → 52.2 mg NaCl → **20.5 mg sodium**, range
15.4–25.7 mg.

---

## 3. The operating range, and why the framing changed

The DFR0300 probe is rated **0–40 °C**. Soup is served at 70–80 °C and eaten
around 60–65 °C, so measuring soup at eating temperature was never available to
us — not as a precision trade, but as an unsupported one: the library's 2%/°C
compensation was never characterised 30 °C outside its range.

Two options were considered and one was taken.

**Rejected — cool and dilute.** Take a sample, dilute it with room-temperature
water to bring it under 40 °C, correct afterwards. Workable, and it also pulls
over-range readings down into the recommended band. Rejected because it turns a
passive device into a manual laboratory ritual, and because the probe's
**±5% of full scale** accuracy means diluting *worsens* relative error: ±1 mS/cm
is ±7% at 14 mS/cm and ±20% at 5.

**Taken — reframe to what the hardware actually does well.** Measure salt in
liquids that are natively in range. Cooled broths and stocks, cold soups,
brines, beverages, cooking liquids off the heat. Typical salted liquids read
9–15 mS/cm, which is high in the recommended band and where the fixed error
matters least.

The limit then becomes a feature rather than a caveat: the DS18B20 (rated −55 to
+125 °C, so never itself the constraint) gates every measurement, and the device
visibly refuses to record what it cannot support. Dilution survives as a tool for
over-range samples only — see `docs/measurement-protocol.md`.

## 4. The unified contract

All three source documents call this step one, and all three name the same field
differently (`salinity_mScm` / `salinity` / `salinityIndex`). Every numeric field
below **carries its unit in its name**. No exceptions.

### Two event types, deliberately separate

| | `sample` | `bite` |
|---|---|---|
| Rate | 5–100 Hz | one per scoop |
| Scope | local only, never persisted long-term | the durable health record |
| Purpose | live chart, debugging, tuning | everything else |

The original design doc's edge-aggregation argument is right and is preserved:
raw samples never leave the laptop, and would never leave the device in a
cloud deployment.

### The events themselves

**`docs/telemetry-schema.md` is authoritative.** It carries the full field
tables, units, and the `sample/v1` shape. Duplicating the JSON here is how the
three source documents ended up with three spellings of one field, so this
section deliberately does not.

Two points of rationale worth keeping in the decision record:

**ISO-8601 UTC timestamps, not epoch seconds.** The source documents contradicted
each other. ISO-8601 is unambiguous, sorts lexicographically, and survives a
cloud migration unchanged.

**The sort key is `BITE#{ts_utc}#{bite_id}`.** The source document's
`{ts}#{deviceId}`, guarded by `attribute_not_exists`, lets two genuine bites in
the same second collide — and the guard would then silently discard the second
one. Data loss disguised as deduplication. `bite_id` is in the key to prevent it.

**`salinity_source` distinguishes `measured` from `bowl_reference`.** Dissolved
NaCl diffuses to uniformity, so carrying a vessel's reading forward across bites
is sound chemistry — but a measured number and an inherited one are not the same
claim, and the dashboard labels which is which.

## 5. Bite detection

### The timing collision, resolved

A real scoop is in the bowl for roughly **0.5 s**. The v1 quality gate required
~2 s of settled samples at 5 Hz. At eating cadence, every bite would fail.

Neither source document notices this. It is the single most important firmware
change.

Fix: sample EC far faster. The ADS1115 does 860 SPS; at 400 kHz I²C a read costs
~100 µs, so 100+ Hz is comfortable. A 0.5 s submersion then yields ~50 EC samples
— *more* statistical evidence than v1's 2-second window ever had, in a tenth the
time.

### State machine

```
IDLE ──submerged──► WETTING ──150ms──► CAPTURE ──lift──► CONFIRM ──► LOG → IDLE
                                          │
                                    (unstable EC)
                                          └──────────────────► ABORT → IDLE
```

| State | Entry | Action |
|---|---|---|
| `IDLE` | — | watch EC floor + temp rise for submersion |
| `WETTING` | submerged | **discard 150 ms** — probe film formation is a transient |
| `CAPTURE` | wetting done | accumulate EC at 100 Hz while submerged |
| `CONFIRM` | EC drops + IMU lift | require both — either alone is noise |
| `LOG` | confirmed | median of CAPTURE samples → bite event |
| `ABORT` | EC σ too high, or < 20 samples | discard, no bite logged |

Median, not mean — one bubble against the probe must not move the number.

**Temperature does not gate anything.** The DS18B20's 750 ms conversion cannot
keep up with bites, and does not need to: soup temperature changes slowly. Read
it at 1 Hz, hold the last value, never block on it.

### Known limitation to state plainly

The spoon cannot distinguish *scooped and eaten* from *scooped and put back*. IMU
tilt toward the mouth is a plausible refinement, but do not claim it until it is
measured. Add this to the "cannot do yet" list.

---

## 6. Hardware

### Pin map

| Component | Signal | ESP32 pin | Bus |
|---|---|---|---|
| EC probe | analog → **ADS1115 A0** | — | — |
| ADS1115 | SDA / SCL | GPIO21 / GPIO22 | I²C `0x48` |
| MPU-6050 | SDA / SCL | GPIO21 / GPIO22 | I²C `0x68` |
| DS18B20 | data | GPIO4 | 1-Wire, 4.7 kΩ pull-up |
| Pace LED | R / Y / G | GPIO25 / 26 / 27 | digital |

Freed by dropping the load cell: **GPIO16, GPIO17**.
Freed by moving EC to the ADS1115: **GPIO35**.

### Notes

- **The ADC2/WiFi conflict is now moot** — EC no longer touches an ESP32 ADC pin.
  Keep it documented anyway; anyone falling back to the internal ADC will hit it.
- Get the **ADS1115** (16-bit), not the ADS1015 (12-bit).
- Power the EC board from **3.3 V**. At 5 V its output can exceed the ESP32's
  input maximum.
- **Check the RGB LED's polarity** — common-cathode vs common-anode inverts every
  `digitalWrite`. 220–330 Ω per leg.
- GPIO16/17 are free on WROOM-32 but are PSRAM pins on WROVER. Irrelevant now
  that they are unused, but note it if the board is ever swapped.
- **The EC probe's rating is 0–40 °C** — confirmed from the datasheet, and the
  reason for the framing in §3. Also **±5% F.S.**, recommended range
  1–15 mS/cm, >0.5 year life, **distilled water only** (the platinum-black
  coating is destroyed by tap water), and never soak it.

### Pace cue thresholds

Gap since previous bite, from `seconds_since_prev_bite`:

| Gap | LED | Rationale |
|---|---|---|
| > 30 s | green | 30 bites × 30 s ≈ a 15-minute meal |
| 15–30 s | yellow | speeding up |
| < 15 s | red | too fast |

These are **invented defaults**. Make them config constants, and say in the pitch
that they are placeholders pending a clinical source.

---

## 7. Backend and data model

SQLite now, with field names and units identical to the future DynamoDB items so
migration is mechanical rather than a rewrite.

| Table | Key fields |
|---|---|
| `patients` | `patient_id`, `sodium_target_mg`, `clinician_id` |
| `devices` | `device_id`, `patient_id`, `volume_ml_mean`, `volume_ml_sd`, EC coefficients |
| `bites` | `patient_id`, `ts_utc`, `bite_id`, + every `bite/v1` field |
| `meals` | derived: `meal_id`, start, end, `bite_count`, `total_sodium_mg` |
| `manual_meals` | self-reported solids: food, portion, `sodium_mg`, `source` |
| `vitals` | `ts_utc`, systolic, diastolic, pulse, position |
| `labs` | `date`, analyte, value, **unit**, reference range |
| `conditions` | condition, status, diagnosis date, medications |

### Meal segmentation

A meal is a run of bites with no gap longer than `MEAL_GAP_MINUTES` (default 20).
Recompute on insert; it is cheap at this scale.

### Rules that carry over from the source documents

These were good and survive unchanged:

- **Store the unit with every value**, normalise on write. Sodium in mmol/L vs
  mEq/L and creatinine in mg/dL vs µmol/L are real trap doors.
- **Reject implausible entries** (systolic 400, serum sodium 14). Typos in
  medical data mislead clinicians.
- **Warn on double counting** when a manual meal overlaps a spoon session.
- **Label measured vs self-reported** everywhere in the UI.
- **UTC in storage, local zone in render**, or daily totals split wrong.
- **Synthetic patients only.** No teammate's real labs or blood pressure.

---

## 8. Why the load cell was dropped — the engineering record

Kept so the decision is not relitigated at 3 a.m.

1. **Grip coupling is not tareable.** A strain-gauge beam needs rigid mounting at
   one end and load at the other. Gripping the handle injects a moment that
   varies continuously; taring at attach time cannot remove it.
2. **Signal-to-noise.** ~12 g on a 100 g cell is 10% of full scale, while hand
   tremor (0.05–0.2 m/s², i.e. 0.5–2% of g) adds noise the 24-bit HX711 cannot
   help with. The limit is mechanical, not electrical.
3. **The HX711 conflicts with WiFi.** Its read is bit-banged; an interrupt that
   stretches the clock line HIGH past ~60 µs powers the chip down mid-conversion.
   *The source document states the opposite* — "Wi-Fi doesn't affect ADS1115
   readings, it only matters for ADC2 pins" is true of the ADC and false of the
   HX711.
4. **The precision was not needed** (§2).

**If mass is ever wanted:** put the cell in a coaster under the bowl, not in the
spoon. Static, gravity-aligned, rigidly mounted, tare once; mass decrease between
bites is the bite mass. This preserves the entire "why a spoon not a bowl"
argument, because it is *salinity* that must be measured per bite, not mass.

---

## 9. Keeping the AWS door open

Deferred, not abandoned. Three things keep the migration cheap, and all three are
free to do now:

1. **`bite/v1` is already the wire format.** Publishing it to
   `devices/{id}/bites` is a transport change, not a schema change.
2. **ISO-8601 UTC timestamps and the `BITE#{ts}#{bite_id}` sort key** are chosen
   for DynamoDB, not SQLite.
3. **Authorisation is a single helper from day one.** `can_access(user,
   patient_id)` in front of every read, deriving the patient from the session
   rather than the request. Broken access control is the source documents'
   correctly-identified top risk, and retrofitting it is far more expensive than
   writing it now.

When AWS does happen, the useful parts of `ESP32_to_DynamoDB.pdf` stand:
`topic(2) AS deviceId` so a spoon cannot impersonate another, a narrow per-cert
policy, idempotent writes, SQS between IoT Core and the writer, `setBufferSize(512)`,
NTP before timestamping, and no secrets in git.

One correction to carry forward: a resend queue in RAM dies on power cycle.
Either put it in NVS or soften "a bite must never be lost" to "at-least-once once
connected".

---

## 10. What carries over from the v1 repo

Nothing is wasted.

| v1 asset | v2 fate |
|---|---|
| `SessionTracker` | **Becomes bite detection.** Same state machine, retuned constants, plus WETTING and ABORT |
| Quality gating | Survives intact — same three signals, shorter window |
| Salinity model + calibration docs | Unchanged |
| Mock spoon | Extended to emit `bite/v1` and simulate eating cadence |
| Dashboard | Charts and palette carry over; add per-bite view, meal totals, patient/clinician split |
| Wiring doc | Update pin map; keep the ADC2 warning as historical |
| FastAPI + SQLite | Stays, schema per §6 |

---

## 11. Build order

**Phase 0 — bench, before any integration.** Non-negotiable; debugging three
sensors at once is far harder than one.

1. I²C scan → expect `0x48` and `0x68`
2. DS18B20 alone → room temperature, not −127
3. EC in air → near 0 mS/cm
4. EC two-point calibration (1413 µS/cm, 12.88 mS/cm)
5. **EC→NaCl curve** with known solutions — the calibration everyone skips
6. **Scoop volume calibration** (§2)
7. **Measure actual scoop submersion time** — every §4 constant depends on it

**Phase 1 — contract.** `bite/v1` and `sample/v1` in one schema module. Mock
emits both. Backend ingests and stores. Nothing touches hardware.

**Phase 2 — firmware.** ADS1115 at 100 Hz, bite state machine, LED, WebSocket.

**Phase 3 — backend.** Bite ingest, meal segmentation, manual meal log, vitals
and labs with unit normalisation, `can_access` from the first endpoint.

**Phase 4 — dashboard.** Patient view, then clinician view with the combined
timeline.

**Phase 5 — stretch.** AWS, per §8.

Phases 1 and 2 parallelise cleanly once the contract is locked. That is the whole
reason to lock it first.

---

## 12. Claims, revised

**Can do now**
- Estimate sodium per bite from volume × salinity, passively, with a stated range
- Detect a bite by fusing motion and salinity
- Refuse to record anything the probe cannot support, visibly
- Live eating-pace cue on the LED
- Log and trend sodium to a clinician dashboard
- Work on any liquid food between 0 and 40 °C

**Cannot do yet**
- Report exact milligrams — it is an estimate with a range
- Distinguish sodium from potassium — it reads all ions
- Read dry solids
- Capture food eaten without the device
- **Distinguish a scoop that was eaten from one put back**
- **Measure anything above 40 °C** — the probe's rating, enforced as an interlock
- **Flag potassium substitutes** — needs label or barcode entry *(moved from
  "can do now")*

**Say "monitoring and trends for a clinician."** Not "diagnoses", not "treats".
Medical claims invite regulatory scrutiny the project does not want.
