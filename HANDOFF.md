# Handoff

Context for picking this up cold — a fresh terminal session, or a teammate who
has not read the thread. Read this, then `README.md`, then whichever doc in
`docs/` covers what you are about to touch.

Repo: `jjiang193/salinityspoon` · branch `clinician-patient-views`, on top of
`7edb66d`. The trust-layer / Today / sources / vitals change described below is
stacked on it **uncommitted in the working tree**.

---

## What this is

A spoon that measures the salt in liquid food and reports **sodium per bite**
against daily limits. An ESP32 reads a conductivity probe, a temperature probe
and an accelerometer; the device fuses them into discrete bite events; a local
backend stores them; a dashboard shows the meal and the day.

There is a predecessor repo, `jjiang193/hophacks`, holding a v1 skeleton. It is
superseded. Nothing needs to come back from it.

---

## Current state

**Software is demo-ready against the simulator. No hardware has ever been
connected.** That is the single most important thing to know.

| Area | State |
|---|---|
| Firmware logic | 113 host-side tests pass. **Never compiled for ESP32** |
| Backend | Runs, verified end to end |
| Dashboard | Builds clean, verified in both themes and at 390 px. Clinician (roster, patient), Patient portal, Live. Patient Today leads with what is left and this bowl; the clinician's page has sodium sources, a meals table with the bowl's mean salinity, and blood pressure and weight on the same day axis as sodium. Spoon liveness, refused dips and failed fetches each have their own state |
| Patients | Five synthetic patients, per-patient targets. **No sign-in** — see below |
| Simulator | Runs the same state machine as the firmware |
| Record / replay | Verified: 1,074 events recorded, replayed, no duplicate loss |
| Hardware | **Nothing benched. Phase 0 not started** |
| AWS | Not built. Deliberately deferred — see below |

### Verified numbers

A simulated 0.62 % liquid reads back as 0.62 %. Meal totals aggregate to within
rounding. The temperature interlock refuses bites at 55 °C and −5 °C on **both**
device and server, and accepts the 40 °C boundary. The label check flags at 4.4×
a low-sodium claim, stays quiet at 1.6× and on a compliant liquid.

---

## Run it

No hardware needed.

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt

# terminal 1 — backend. 0.0.0.0 matters: the ESP32 connects from another machine
cd backend && ../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

# once — two weeks of synthetic history, or the clinician roster is five empty rows
.venv/bin/python tools/seed_demo.py

# terminal 2 — simulated spoon
.venv/bin/python tools/mock_spoon.py --salt 0.62 --temp 26 --pace 14

# terminal 3 — dashboard
cd dashboard && npm install && npm run dev        # http://localhost:5173
```

Firmware logic tests, no toolchain required:

```bash
make -C firmware/test          # 113 checks
```

On Windows: `.venv/Scripts/python`, not `.venv/bin/python`. And on Python 3.14
the pins in `backend/requirements.txt` have no wheels — `pydantic-core` tries to
compile and fails. `pip install fastapi uvicorn websockets` unpinned works; the
pins themselves have not been moved.

Useful simulator flags: `--temp 55` (watch every bite get refused), `--salt 0.9`,
`--noise 0.5` (watch the quality gate reject), `--pace 6`.

Record and replay, which is the demo insurance:

```bash
curl -X POST localhost:8000/api/recording/start -H 'Content-Type: application/json' -d '{"label":"broth"}'
curl -X POST localhost:8000/api/recording/stop
python tools/replay.py backend/recordings/<file>.jsonl --loop
```

There is also a published interactive preview, spoon simulated in-browser, no
setup: **https://claude.ai/artifact/DHGjoXRdRBvseNo7GQjSam** (private until
shared from its Share menu). It is a *separate implementation* from
`dashboard/src/` and will drift — treat it as a pitch artifact, not a source of
truth.

---

## Hard constraints — do not quietly relax these

**The probe is rated 0–40 °C.** Above that the firmware refuses to log a bite,
and the backend refuses it again even if a device sends one. This is enforced
twice on purpose. A reading outside the rated range is not less precise, it is
*unsupported* — the library's 2 %/°C compensation was never characterised out
there. Do not add a "log it anyway with a flag" path.

**Accuracy is ±5 % of full scale**, so ±1 mS/cm absolute — relative error grows
as readings shrink. Measure high in the 1–15 mS/cm recommended band. This is why
we do **not** dilute by default.

**Dilution corrections apply after converting EC to concentration, never
before.** The curve is quadratic. Getting this backwards reads 13 % high,
silently. Both the firmware and backend carry a comment saying not to "fix" it.

**The probe is platinum-black coated: distilled water only.** Tap water destroys
the coating permanently. Never soak it; dip and remove.

**It measures NaCl-equivalent salinity, not sodium.** Conductivity reads all
ions. Say the former everywhere, in code and in the pitch.

---

## Decisions already made, with reasons

These were argued through. Do not relitigate without new information.

**No load cell.** Scoop volume is calibrated per user instead. Error propagation
is the reason: per-bite CV is ~25 %, but random scoop variation cancels as √n, so
a 30-bite meal is ~4.6 %. The sensor, not the volume estimate, dominates the
meal-level budget — a load cell would have attacked the smaller term, while
adding grip-moment coupling that cannot be tared out and an HX711 whose
bit-banged read is corrupted by WiFi interrupts. Full record in
`docs/engineering-notes.md` §6.

**Framed as 0–40 °C liquids, not hot soup.** Forced by the probe rating. The
limit became a feature: the device visibly refuses what it cannot support.

**Local-only backend, AWS deferred.** Not a risk judgement — a sequencing one.
Hardware bring-up is the critical path; a DynamoDB table is worth nothing if the
probe does not read salt. `PLAN.md` §9 keeps the migration cheap: `bite/v2` is
already the wire format and already uses NaTrack's names, timestamps are
ISO-8601 UTC, and the sort key is `BITE#{timestamp}#{deviceId}#{bite_id}`.

**Sort key includes `bite_id`.** An earlier design keyed on timestamp plus
device with a skip-if-exists guard, which silently discarded a second genuine
bite in the same second. Data loss disguised as deduplication.

**Colour is rationed by tier** (`dashboard/src/lib/severity.ts`). The dashboard
previously drew sixteen coloured chips from eight status systems, so the
temperature interlock rendered identically to "the spoon is in air". Ambient
state is now neutral. Adding a new coloured indicator means justifying its tier.
`verdictFor`/`VERDICT_STATUS` were deleted rather than left as a competing way
to pick a colour — do not reintroduce one.

**NaTrack names win wherever NaTrack speaks.** `docs/natrack-system-design.pdf`
is the system design, and its entity, field and endpoint names are used as
written: `patientId`, `sodiumEstimate`, `GET /v1/patients/{id}/summary`,
`/session/{patientId}`. Where NaTrack is silent the original snake_case name
stays (`sodium_mg_low`, `salinity_g_l`, `/api/meals/start`). The casing therefore
says whose field it is — do not normalise it. NaTrack rarely gives a unit or a
format; `docs/telemetry-schema.md` does, for every field, and is binding. Three
calls NaTrack left open were made there and are worth knowing before you argue
with them: `salinityIndex` is conductivity in mS/cm (not g/L); `timestamp` is
ISO-8601 with milliseconds (not epoch); and `bite_id` stays in the dedupe key
beside NaTrack's `deviceId` + `timestamp`, because the key without it once lost
real bites.

**Three views, one session per patient.** Clinician, Patient portal, Live — NaTrack's
three. A live session is `/session/{patientId}` and carries that patient's events
only; another patient's session is told the spoon is `busy` and never by whom.
`useTelemetry(patientId)` follows whoever is on screen, the roster has no session
and polls, and stored per-patient data is fetched with `useApi`.

**The patient's target replaces 2,300 everywhere.** `patients.sodium_target_mg`
is set by the clinician and is the denominator of every percentage the patient
sees. A heart-failure patient on 1,500 mg shown a bar that fills at 2,300 has
been shown the wrong bar. FDA and AHA figures survive only as context.

**An unlogged day is not a zero day.** Averages in `backend/app/cohort.py` run
over logged days, the count of logged days is shown beside them, and today is
excluded from the trailing window because a half-finished day reads as
improvement every morning. Do not "simplify" this to a plain 7-day mean.

**One status chip per roster row** (`rosterStatus` in `severity.ts`). The roster
is the sixteen-chip problem one level up. A label flag outranks a logging lapse
because it can be true of a patient whose sodium looks perfect.

**No risk score.** The clinician view is arithmetic against a target the
clinician set. This device measures soup; it does not triage patients.

**Seeded history is tagged in the data, not just in a comment.** Seeded bites
carry `deviceId = seed-<patient>` and `fw_version = seed-0.1`; seeded manual
entries and health logs have `source = 'seed'`. `tools/seed_demo.py --reset` removes exactly
those rows. Today is never seeded for `demo-1`, so the live patient's "today" is
what the spoon measured.

**Light is the default theme, whatever the OS says.** A clinical white/blue
palette, applied before first paint by a script in `dashboard/index.html`; the
masthead toggle switches to dark and persists in `localStorage`. `--accent` is
the UI blue (buttons, focus, active tab) and is deliberately not
`--series-salinity` — a button the colour of a series reads as part of the
chart. The chart colours were re-validated against the white surface.

**Pace is reported, never judged.** NaTrack asks the clinician view for average
seconds between bites, the quickest bite and a `paceFlag`, so they are there —
as plain numbers and an uncoloured chip. The earlier decision below still holds
for everything past that: no threshold on eating speed is ours to claim.

**Upward drift is two weekly means, not a slope.** NaTrack requires the flag and
does not define it. Rule: last 7 full days at least 15 % above the 7 before, 3+
logged days in each. It was 10 % for an hour; on the seeded cohort that fired on
two steady patients by chance.

**Pace is projection, not coaching.** The device LED handles rhythm. The
dashboard does arithmetic: bites remaining to the daily limit. Deliberately no
threshold on eating speed — the evidence there concerns total energy intake, and
the sodium link runs through it rather than being ours to claim. The LED's
`PACE_GREEN_S 30` thresholds are **invented placeholders**; say so in the pitch.

**The live label check judges the meal's mean, not the bite.** `label_check` on
`bite` and on the session's `spoon` message is the check of the open meal's weight-averaged salinity
so far — the same judgement `/summary` makes of the finished meal. It was the
single bite's; near the 2× threshold the flag flipped on and off from one
spoonful to the next, and a flag that flickers is a flag nobody believes.

**A day's range is the linear sum of its per-bite ranges — overstated on
purpose.** Random scoop error cancels as √n, so the true spread of a day is
narrower than `total_sodium_mg_low/high` says. It is kept because it is the one
error model the contract already has (a meal's range is built the same way), and
an honest-but-wide range beats a second model nobody has validated. Self-reported
food is added as entered; it carries no range. Days now carry a range like every
other sodium figure, and today is drawn faded and labelled "today so far" in the
day chart and the roster sparkline, because it is excluded from the averages and
a chart that always ends low reads as improvement. `range=week` is therefore
eight rows - the seven full days the averages cover, then today - so the solid
bars a clinician counts are the days "6 of 7 over target" was counted over.

**A spoon silent in the middle of a meal is an attention-tier state.**
`sev.spoonLink` reuses the existing critical role; it did not earn a new colour.
The reason it gets colour at all: while it lasts every dip is lost and every
live value on the page is the last one, not the current one, so a frozen spoon
is otherwise indistinguishable from a working one — the same order of failure as
the interlock, and someone can fix it at once by switching the spoon on. Between
meals a silent spoon is a spoon in a drawer, and stays ambient. Mid-meal silence
is judged in `useTelemetry`, from the arrival of the session's samples: none for
3 s (`SILENT_MS`) is `spoonLive` false, and `silentForS` counts up. `sample_age_s`
on `GET /api/spoon` is a different, slower signal - "is any spoon switched on",
10 s (`SPOON_ONLINE_S` in `App.tsx`), by the server's clock - and only feeds the
ambient between-meals hints. On the patient's Today and on Live it is a banner
in the alert slot, above the interlock's, and Live pauses its projection; the
clinician's patient page says it as plain text ("Meal open, spoon silent for
…"), because the clinician cannot switch the spoon on. "Mid-meal" ends: the
server closes a meal nobody has fed for 20 minutes by its own clock
(`MealTracker.close_if_idle`, on a 30 s timer in `main.py`), not only lazily on
the next bite, so the alert cannot outlive the meal. Silence is only ever reported while the session socket is open:
with the server down the spoon cannot be heard, which is the server's fault to
report ("Can't reach the server"), not the spoon's.

**A dip "not counted" is inferred in the dashboard.** The simulator's state
machine goes CONFIRM → IDLE with no bite and never emits `ABORT`, so
`useTelemetry` counts a dip as refused when the detector leaves a dip and no
bite follows. Real firmware's `ABORT` is honoured as well. If the firmware ever
reports refusals itself, prefer that and delete the inference.

**Blood pressure and weight are drawn, never interpreted.** `VitalsTimeline`
puts the health log on the sodium chart's day axis as two small multiples, each
with its own y-axis, in one neutral ink: no thresholds, bands, arrows,
correlation figure or second axis on the sodium chart. It is there so the
clinician does not line a table up with a chart by eye — not to suggest cause.
The same readings as a table ("Readings as entered") are a closed `<details>`
inside that card; the separate health-log card was removed from the clinician's
page because it repeated the plot. The patient portal keeps its editable one.

**A self-reported item is bounded at 5,000 mg**, on the form and again on the
server (`MANUAL_MAX_MG`). 99999 is a typo, and one typo turns a roster row
critical. From 2,000 mg the form asks once before saving.

---

## Next steps, in order

**1. Phase 0 bench — nothing else matters until this is done.** `docs/wiring.md`.
Bench each sensor alone before flashing `spoon.ino`: I²C scan (expect `0x48` and
`0x68`), DS18B20 alone (room temp, not −127 — that means the 4.7 kΩ pull-up is
missing), EC in air (near 0), LED colours.

**2. Fill in `firmware/spoon/config.h`.** `WIFI_SSID`, `WIFI_PASSWORD` and
`BACKEND_HOST` are all `CHANGE_ME` / placeholder.

**3. Run all three calibrations.** `docs/calibration.md`. The one people skip is
the EC→NaCl curve — the shipped coefficients are reference-table values, not a
calibration of your probe, so **every number the dashboard shows is wrong until
that is done**. It needs a 0.1 g scale and four mixed solutions. Paste the fit
into *both* `firmware/spoon/config.h` and `backend/app/salinity.py`.

**4. Scoop volume calibration.** 20 individually weighed scoops. The standard
deviation *is* the error bar the dashboard displays; it is not optional overhead.

**5. Record a session the moment it works.** Before anything can break. That
recording is the demo insurance.

**6. Validate** against a solution you did not fit to. ±0.05 % is the bar.

Then, only if hardware is landing cleanly: AWS dual-publish (firmware MQTT
alongside the existing WebSocket, so the cloud path cannot break the demo), the
clinician view, and an enclosure.

---

## Gotchas for whoever picks this up

**This sandbox cannot compile the firmware.** Egress policy blocks the
arduino-cli release and `downloads.arduino.cc`, so the ESP32 toolchain cannot be
installed. `firmware/test/` exists because of that — it shims Arduino with a
controllable clock and tests the logic natively with `g++`. Everything in
`spoon.ino` itself (WiFi, I²C, the drivers) is **unverified** and will need a
real compile on someone's machine.

**The firmware tests earn their keep.** They found a real bug: the stability
gate used a standard deviation, which is not outlier-robust, so one bubble among
fifty good samples aborted a bite whose median was exactly right. Now a median
absolute deviation. If you change the capture logic, run the tests.

**There is no sign-in, and the API trusts the `patientId` it is given.** The
"Viewing as" dropdown on the Patient tab stands in for a session. PLAN.md §9's
`can_access(user, patientId)` does not exist yet and must before any of this
leaves a laptop. Every patient-scoped endpoint goes through `_require_patient`
in `main.py`, which is where that check belongs. That includes labelling and
ending a meal: `POST /api/meals/label` and `/api/meals/close` carry `patientId`
and answer 409 when the open meal is someone else's.

**One spoon, one holder.** A bite that opens a meal on its own belongs to whoever
the spoon is paired with (`POST /v1/devices/{id}/pair`), default `demo-1`.
Starting a meal from the patient portal pairs the spoon to that patient — handing
someone the spoon and pairing it are the same act. `MealTracker` still tracks one
spoon; several spoons at once is the next step, not this one.

**An old `spoon.db` will not open.** Columns were renamed and there are no
migrations, so the backend refuses a database from before the NaTrack rename and
says so. Delete `backend/spoon.db` and run `tools/seed_demo.py`. Recordings made
as `bite/v1` cannot be replayed either; none were ever made on real hardware.

**The simulator needed a fix to run on Windows.** `asyncio.sleep(0.02)` rounds
up to ~31 ms there, so it ran at 32 Hz, captured 16 samples per 500 ms dip, and
aborted every bite under `MIN_EC_SAMPLES = 20` — silently, because stdout was
buffered. It now paces against a deadline. If bites ever stop appearing, check
the sample rate first.

**Recharts is the chart library** and it does not love streaming data — the
telemetry hook buffers samples and flushes at 200 ms rather than re-rendering per
sample. Do not remove that.

**The dashboard backfills the open meal on load**, otherwise opening it mid-meal
shows an empty chart beside a large total. That in turn is why `BiteTable` caps
at 8 rows.

---

## Where things are

| Path | What |
|---|---|
| `docs/telemetry-schema.md` | **The contract.** Change it here first, then all four consumers |
| `docs/measurement-protocol.md` | Probe specs, the interlock, the error budget |
| `docs/engineering-notes.md` | What was hard and how it was solved — the difficulty record |
| `docs/demo-script.md` | Ninety-second walkthrough with anticipated questions |
| `docs/calibration.md` | Three calibrations, protocols for each |
| `docs/wiring.md` | Pin map and bench checks |
| `docs/bite-detection.md` | The state machine and why it samples at 100 Hz |
| `PLAN.md` | Decision record — why the system is shaped this way |
| `firmware/spoon/` | ESP32 sketch |
| `firmware/test/` | Host-side logic tests |
| `backend/app/` | FastAPI, SQLite. `cohort.py` is the clinician-view arithmetic |
| `dashboard/src/` | React + Vite + TS. `views/` holds the three screens |
| `dashboard/src/lib/severity.ts` | The only place a colour tier is chosen. `rosterReasons` feeds the roster's chip, tiles and the patient page's reasons, so they cannot disagree |
| `dashboard/src/lib/sodium.ts`, `lib/api.ts` | One number format (`fmtMg`) and one set of user-facing error wording. No URL path reaches a user |
| `dashboard/src/hooks/useTelemetry.ts` | The live session: spoon liveness, refused dips, the 200 ms flush |
| `dashboard/src/components/` | `TodayHero` + `BowlCard` (patient Today), `SessionCard` (the one place a label is declared), `SodiumSources`, `VitalsTimeline`, the three alert banners |
| `tools/` | Simulator, replay, and `seed_demo.py` |

One thing to internalise before touching the firmware: **a real scoop is half a
second long.** Every timing constant follows from that, and it is why EC samples
at 100 Hz through the ADS1115 rather than settling slowly. `docs/bite-detection.md`
has the reasoning.
