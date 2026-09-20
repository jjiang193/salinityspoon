# Salinity Spoon

A spoon that measures the salt in what you eat and tells you what it means for your
sodium intake.

An ESP32 reads a conductivity probe, a temperature probe, a load cell and an
accelerometer, fuses them into per-bite sodium estimates, and streams them to a live
dashboard that tracks intake against a daily limit — on a laptop at the table, in the
cloud, or both at once.

## See it running

**https://d1ayprvp3flyqt.cloudfront.net**

| Sign in as | Email | Password |
|---|---|---|
| Clinician | `clinician@natrack-demo.com` | `NaDemo` |
| Patient | `patient@natrack-demo.com` | `NaDemo` |

Every patient behind that login is invented, and both accounts are demo accounts over
synthetic data — which is why their password is in a public README. Real patient data
needs a signed AWS BAA and the checklist at the end of this file first.

The clinician sees a roster of patients against their own sodium targets; the patient
sees what is left today, logs solid food and blood pressure, and reads a month of
history. Bites arrive live, about a second after the spoon is tipped.

## Quick start — no hardware needed

The mock spoon runs the same state machine the firmware does and speaks the real
protocol over the real WebSocket, so dashboard work never blocks on hardware.

```bash
# 1. Backend
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
cd backend && ../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

# 2. Demo cohort (once) — two weeks of synthetic history for the clinician view
.venv/bin/python tools/seed_demo.py

# 3. Mock spoon (new terminal)
.venv/bin/python tools/mock_spoon.py --salt 0.62 --temp 26 --pace 9

# 4. Dashboard (new terminal)
cd dashboard && npm install && npm run dev
```

Open http://localhost:5173. NaTrack's three views: **Clinician** (a roster of five
synthetic patients, each against their own sodium target; per patient, where the sodium
comes from and blood pressure and weight on the same days), **Patient portal** (what is
left today and how much of this bowl fits in it, start a meal, log solid food and blood
pressure, a month of history) and **Live** (whoever holds the spoon, as it happens). A
silent spoon, a refused dip and an unreachable server each say so rather than leaving
the last number on screen.

This local path needs no accounts and no internet. It is the demo path, deliberately:
a venue's Wi-Fi is not a dependency you want on stage.

On Windows the venv's interpreter is `.venv/Scripts/python`, not `.venv/bin/`.

`--host 0.0.0.0` on the backend matters: the ESP32 connects from another machine, so
binding to localhost makes the spoon invisible.

Useful flags:

| Flag | Effect |
|---|---|
| `--salt 0.9` | a saltier liquid |
| `--temp 55` | above the probe's 40 °C limit — watch every bite get refused |
| `--pace 8` | eat fast, to drive the pace cue red |
| `--noise 0.5` | crank EC noise until the quality gate rejects bites |

## Two spoons, one contract

| | `firmware/spoon/` | `firmware/loadcell/` |
|---|---|---|
| Per-bite mass | calibrated scoop volume | **weighed**, load cell + HX711 |
| Probe | rides in the bowl | a separate instrument, dipped in |
| Transport | WebSocket to the local backend | MQTT over TLS to AWS IoT Core |
| Status | simulator-verified | **running on real hardware** |

Both emit the same `bite/v2` event, so the backend, the dashboard and the cloud cannot
tell which spoon sent a bite except by the `volume_source` field that says so. That is
the point of having one contract: two hardware answers to "how much was in the
spoonful" compete on their merits instead of forking the system.

## Operating envelope

Salt in liquids between **0 and 40 °C**. Cooled or room-temperature broths, stocks,
cold soups, brines, beverages and cooking liquids.

This is the probe's rating, and it is enforced rather than hoped for. Above 40 °C the
firmware refuses to log a bite, the LED signals wait, and the backend rejects the event
even if a device sends it anyway — as does the cloud ingest, which is a third
independent refusal. A reading taken outside the rated range is not a less-precise
reading — it is an *unsupported* one, because the temperature compensation was never
characterised out there.

Read `docs/measurement-protocol.md` before trusting a number.

## How it works

```
                      ┌── WebSocket ──► FastAPI ──► React dashboard   (the demo path)
ESP32 ── EC+temp ─────┤                   └── SQLite: meals & bites
        +IMU+load cell │
                      └── MQTT/TLS ──► AWS IoT Core ──► SQS ──► Lambda ──► DynamoDB
                                                                   │
                                        CloudFront ◄── React ◄─────┴── WebSocket + REST
```

Everything is built around one contract — `docs/telemetry-schema.md`. Firmware, mock,
backend, cloud and dashboard all speak it, in two event types: high-rate `sample/v2`
that stays local, and `bite/v2`, the durable record. Field names follow
`docs/natrack-system-design.pdf` wherever NaTrack names the field.

### Only fused bites leave the spoon

Four sensors sample at about 70 readings a second. One bite event leaves the device.
That is the scaling decision the whole design rests on: at the design point of 100,000
spoons, sending samples would be 7 million messages a second and sending bites is about
10,000. The pace LED is driven on the device for the same reason — feedback a person
feels must not wait for a network.

### The accelerometer decides which readings count

A probe in air reads near zero; a probe in a liquid being stirred reads turbulence.
Every sample carries a quality score fused from submersion, settledness and signal
stability. Low-quality samples are charted faintly and excluded from every reported
number, and a bite's salinity is the median of its captured samples — so one bubble
cannot move a sodium figure.

On the load-cell spoon the accelerometer does one more job: **a bite is only recorded
if the bowl was tipped past 45° while it emptied.** Weight leaving a level bowl is
something lifted off it, not food poured out of it, and without the tilt the two are
indistinguishable. The angle that confirmed the bite is stored with it, as
`pour_tilt_deg`.

### Sampling fast is what makes bites measurable

A real scoop is ~0.5 s in the liquid. Sampling EC at 100 Hz through the ADS1115 yields
~50 samples in that window — more evidence than a slow 2-second settle ever had, in a
tenth of the time. See `docs/bite-detection.md`.

### Conductivity can spot a potassium salt substitute

The probe cannot tell sodium from potassium — it reads all ions. Normally a limitation.
But salt substitutes are potassium chloride, so a product labelled low-sodium that
measures high ionic content is probably substituting.

That matters clinically: for people with kidney disease, or on ACE inhibitors, ARBs or
potassium-sparing diuretics, excess potassium risks hyperkalemia. No food database or
barcode app can detect it. A conductivity measurement can.

Declare a label claim on the Patient portal and the meal's mean salinity is checked
against FDA per-serving limits from the first bite. It flags; it never diagnoses.

### Liquids only, and honest about it

The probe reads liquids, so solids are entered by hand and shown as self-reported,
never merged into the measured figure. In a representative day that is 1,040 mg
self-reported against 870 mg measured — over half the total would be invisible if the
gap were papered over.

### Replay mode

The backend records every ingested event, and `tools/replay.py` plays a session back
through the identical pipeline with timestamps shifted to now. If the hardware dies
before judging, the demo still runs. It is also how thresholds get tuned without
standing over a bowl.

```bash
curl -X POST localhost:8000/api/recording/start -H 'Content-Type: application/json' -d '{"label":"broth"}'
# ... take some bites ...
curl -X POST localhost:8000/api/recording/stop
python tools/replay.py backend/recordings/<file>.jsonl --loop
```

## Using the real spoon

```bash
# calibrate once, in this order
arduino-cli compile --fqbn esp32:esp32:esp32 --upload -p /dev/cu.SLAB_USBtoUART firmware/loadcell/LoadCellCalibrate
arduino-cli compile --fqbn esp32:esp32:esp32 --upload -p /dev/cu.SLAB_USBtoUART firmware/loadcell/ECCalibrate
# then the real sketch
cp firmware/loadcell/SalinityTest/secrets.h.example firmware/loadcell/SalinityTest/secrets.h   # fill in Wi-Fi + certs
arduino-cli compile --fqbn esp32:esp32:esp32 --upload -p /dev/cu.SLAB_USBtoUART firmware/loadcell/SalinityTest
```

Then, at 115200 baud: **fill the bowl → wait ~3 s for `Loaded X g` → dip both probes for
a second or two → lift them out → tip the bowl out.** The weight latches before the dip
(the probes lean on the bowl, so the load cell is only honest while they are out), the
salinity latches when the dip ends, and the bite is logged once the bowl has stayed
empty for 2 s and was tipped past 45°.

Dip **6–12 s for anything warm**: the probe arrives from room air, and a short dip reads
the food as cooler than it is — which is the one hole in the temperature interlock, and
it is measured rather than hidden (`firmware/loadcell/README.md`).

`secrets.h` holds Wi-Fi credentials and the device's private key. It is gitignored, and
the certificate it carries is created by `infra/scripts/create-device-cert.sh`.

## The cloud, if you want it

```bash
cd infra && sam build && sam deploy --guided       # the whole stack
python3 infra/scripts/seed-cloud.py                # demo patient, clinician, accounts
infra/scripts/deploy-dashboard.sh                  # build the dashboard against it
```

`infra/README.md` is the guided tour: what each phase does, what was tested against the
deployed stack, and which parts of the design are still unbuilt. Everything idles at
about $0 and a budget alerts at $20.

## Layout

| Path | What it is |
|---|---|
| `firmware/spoon/` | ESP32 sketch — volume-calibrated spoon, WebSocket to the local backend |
| `firmware/loadcell/` | ESP32 sketch — weighed bites, dipped probe, MQTT to AWS |
| `backend/app/` | FastAPI — ingest, broadcast, meal segmentation, SQLite |
| `dashboard/` | React + Vite + TypeScript — one build, local or cloud |
| `infra/` | The AWS stack as SAM: IoT rule, queue, Lambdas, DynamoDB, Cognito, CloudFront |
| `tools/mock_spoon.py` | Simulator running the same state machine |
| `tools/seed_demo.py` | Synthetic history for the demo cohort; `--reset` removes it |
| `tools/replay.py` | Replays a recorded session through the live pipeline |
| `docs/` | Contract, measurement protocol, bite detection, wiring, calibration |

Picking this up cold? Start with **`HANDOFF.md`** — current state, hard constraints,
decisions already made, and what to do next.

Also: `docs/engineering-notes.md` — what was hard and how it was solved.
`docs/demo-script.md` — the ninety-second walkthrough.

## Hardware

ESP32-WROOM-32 · DFRobot Gravity Analog EC V2 (DFR0300, K=1) · ADS1115 · DS18B20 ·
MPU-6050 (GY-521) · 100 g load cell + HX711 · LED

Read `docs/wiring.md` before wiring anything. The EC probe goes through the ADS1115,
never into an ESP32 ADC pin.

**Arduino libraries:** OneWire · DallasTemperature · Adafruit MPU6050 ·
Adafruit ADS1X15 · ArduinoJson · HX711 (Bogdan Necula) · PubSubClient ·
WebSockets (Markus Sattler) · DFRobot_ESP_EC (install as ZIP — not in the Library
Manager)

Board: ESP32 Dev Module. No COM port? Install the Silicon Labs CP210x VCP driver — the
HiLetgo board uses a CP2102.

## Accuracy, honestly

- **It measures NaCl-equivalent salinity, not sodium.** Conductivity reads all ions —
  potassium, magnesium, dissolved organics. Say the former, never the latter.
- **±5 % of full scale**, so ±1 mS/cm absolute. Relative error grows as readings shrink,
  which is why we measure high in the 1–15 mS/cm recommended band and do not dilute by
  default.
- **The probe is a consumable.** Rated >0.5 year, distilled water only, never soaked.
  The platinum-black coating is destroyed by tap water, permanently.
- **Not food-safe.** A measurement instrument, not a utensil.
- **Per-bite mass is the other half of the error budget.** On `firmware/spoon/` it is a
  calibrated scoop volume: ±27 % per bite, ±10 % per meal, because random scoop
  variation cancels as √n. On `firmware/loadcell/` it is weighed, and the simulation
  puts the cost of the "a tipped, emptied bowl is a bite" rule at about 1 % of grams
  counted beyond what was eaten.
- **Sodium is computed on the device** from the quadratic EC→NaCl curve, and the backend
  recomputes it from the raw fields so a recalibration does not need a reflash.

## Status

**Working end to end on real hardware.** A bite taken on the bench — 31.2 g,
13.04 mS/cm at 21.9 °C, 125 EC readings, 88.3 mg sodium — published from the ESP32 over
MQTT/TLS, through IoT Core, a queue and a Lambda, into DynamoDB, and onto the hosted
dashboard about a second later.

- Load cell and EC probe are both calibrated on the real spoon.
- Bite detection is verified in simulation (100 % on eight of nine scripted actions, 0
  real bites missed in 1,618) and by hand on the bench.
- The local demo path — backend, mock spoon, dashboard — is unchanged and needs no
  accounts, no internet and no cloud.

Not built yet, and listed in `infra/README.md` rather than glossed over: `MealSummary`
rows from DynamoDB Streams (meals are derived on read instead), the S3 archive for
expired bites, a VPC with private subnets and a DynamoDB endpoint, customer-managed KMS
keys, CloudTrail, an access-log row per read of patient data, and MFA required for
clinicians rather than optional.

Before any real patient: sign the AWS BAA in Artifact, confirm every service used is on
the HIPAA-eligible list, restore the 12-character password policy, write a risk
assessment, and define data retention and breach response.
