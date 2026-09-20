# Load-cell firmware (alternative design)

ESP32 firmware that **weighs every bite** with a load cell instead of assuming a
fixed scoop volume. It's an alternative to `firmware/spoon/` and is here to be
compared, not merged over it. See the PR for the side-by-side.

Status: compiles for the ESP32 (25% flash). Sensors confirmed reading on the real
board (DS18B20, ADS1115, MPU-6050, HX711). **Bite logic tested in simulation only**;
load cell and EC not calibrated yet.

The measurement flow was rebuilt around a **probe dipped into the spoon** rather
than one riding in the bowl — see *How a bite is decided*. The simulation has
been rewritten to match but **has not been run since**; its numbers are gone
until it is.

## What's here

| Path | What it is |
|---|---|
| `SalinityTest/` | Main sketch: sensors at 50 Hz, bite detection, sodium per bite, pace LED |
| `ECCalibrate/` | Two-point EC calibration (1413 µS/cm, 12.88 mS/cm), saves K to flash |
| `LoadCellCalibrate/` | Finds `LOADCELL_SCALE` with a known weight |
| `test/` | Host-side simulation of the real `BiteDetector.cpp` (`make run`) |

## Hardware / pins

| Part | ESP32 |
|---|---|
| EC probe → ADS1115 A0 | I²C SDA 21 / SCL 22 (0x48) |
| MPU-6050 | I²C SDA 21 / SCL 22 (0x68) |
| DS18B20 | GPIO4, 4.7 kΩ pull-up |
| HX711 (100 g load cell) | DT GPIO16 (RX2), SCK GPIO17 (TX2) |
| Pace LED (red) | GPIO25 → 220–330 Ω → LED → GND |

Everything on 3.3 V. Libraries: DFRobot_EC, OneWire, DallasTemperature, Adafruit
MPU6050, Adafruit ADS1X15, HX711 (Bogdan Necula).

## How a bite is decided

The probe is a **separate instrument dipped into the bowl**, not a sensor riding
in it. Five states, one per physical step, all of them in
`SalinityTest/BiteDetector.h` with every threshold at the top.

Three latches shape the whole thing: the weight is latched once it has been
there long enough to be real, the salinity is latched when the dip ends, and the
bite is only logged once the bowl has stayed empty long enough to be sure.

1. **Fill** (`EMPTY → FILLING`). Weight ≥ 4 g starts a 3 s timer
   (`LOAD_SETTLE_MS`). Nothing is believed while food is still going in: pouring
   takes a moment and the load cell's rolling average is chasing it.
2. **Latch** (`FILLING → LOADED`). The scoop weight is the mean of the last
   0.5 s, tilt-corrected up to 20°. Nothing after this changes it — not the
   probes leaning on the bowl, not a knock. More food (> 2 g for 0.5 s) re-latches
   deliberately.
3. **Dip** (`LOADED → DIPPING`). EC above `WET_MV` means the probes are in the
   food. They lean on the bowl, so **the weight is frozen for the whole dip**.
4. **Measure** (`DIPPING → MEASURED`). EC below `DRY_MV` for 0.3 s means they are
   out. Salinity is the **median of the last 2 s** of the dip, not its mean: the
   probe arrives from room air and the EC reading is compensated with a
   temperature that is still climbing, so early samples describe a food that does
   not exist. Shorter than 5 readings (0.5 s) is discarded. **The measurement is
   latched**: lifting the probes out cannot change it, only a new dip can.
5. **Pour** (`MEASURED → EMPTY`). Weight below 30 % of the latched scoop for a
   full **2 s**, *and* the bowl tipped past **45°** while it emptied → **bite**,
   eaten = loaded − leftover.

**Both halves of that last rule matter.** The 2 s is why emptying in stages is
one bite rather than three. The tilt is why lifting a coin off a level bowl is
not a bite at all: weight leaving is not the same event as food being poured out,
and without the tilt the two are indistinguishable. The angle that confirmed the
bite travels with it, as `pour_tilt_deg`, so a suspicious bite can be checked
against how firmly it was actually poured. With no MPU-6050 there is no evidence
either way and the weight drop is taken at face value (`REQUIRE_POUR 0` restores
that behaviour deliberately).

Tilt is measured **against the orientation learned at boot or at `z`**, not
against true vertical, so a bowl that rests at an angle is still "level" — but it
has to be zeroed in the pose it will sit in.

**Wet/dry thresholds are per probe.** This one reads **3 mV dry, 9–17 mV just
after lifting out of 13 mS/cm brine, and 150–1735 mV in food**, so `WET_MV` is
120 and `DRY_MV` is 80. The previous 250/150 pair never triggered on it: the dip
was invisible and every bite was silently discarded. Measure yours with the debug
line (it prints `EC ### mV WET/dry`) before trusting any of this.

**No false-bite logic.** No "was the probe still in liquid", no abort. Tipping a
measured spoonful back into the bowl is recorded as a bite, and the simulation
asserts it so the guesswork cannot quietly come back.

- **Emptied without a dip.** The bite is logged with salinity 0 and marked
  `[NOT DIPPED]` on Serial. It is **not** sent to the cloud: every field in
  `bite/v2` is a measurement, and there is no way to say "no salinity" in it.
- **The interlock.** A dip whose median temperature falls outside the probe's
  rated **0–40 °C** is dropped and the spoonful is not recorded at all. Same
  numbers as `firmware/spoon/config.h` and `backend/app/salinity.py`, for the
  same reason: outside that range the compensation was never characterised, so a
  reading there is not less precise, it is unsupported.

**Sodium** uses the team's quadratic EC→NaCl curve (`SalinityTest/Salinity.h`,
mirroring `backend/app/salinity.py`), not the old flat ×0.55 factor. The backend
recomputes sodium from the raw fields, so the two have to agree.

**Pace:** two bites < 6 s apart → LED on for 5 s.

## Sending bites to AWS

`SalinityTest/Net.cpp`: Wi-Fi, NTP, and MQTT over TLS to AWS IoT Core, publishing
one `bite/v2` per bite to `devices/<id>/bites`. Nothing else leaves the device —
no raw samples, no motion data, no patient identity; the cloud adds the patient
from the device's pairing. The stack it lands in is `infra/` (IoT rule → SQS →
`ingestBite` → DynamoDB).

Everything is non-blocking: the loop keeps running at 50 Hz whether the network
is up, down or mid-handshake. Bites queue in RAM (24 of them) while offline and
drain when the link returns; the queue is lost on reboot. `millis()` is stamped
through the NTP offset at send time, so bites queued before the clock was right
still get correct ISO-8601 UTC timestamps.

Credentials live in `SalinityTest/secrets.h`, which is gitignored. Copy
`secrets.h.example`, then fill in Wi-Fi and paste the three PEMs from
`infra/scripts/create-device-cert.sh`. **The device private key identifies this
spoon to AWS: never commit it, and deactivate the certificate in IoT Core if it
leaks.**

Verified end to end on 2026-09-20: a real bite (31.2 g, 13.04 mS/cm at 21.9 °C,
125 EC readings) published from the board and landed in DynamoDB as
`BITE#2026-09-20T07:33:07.494Z#spoon-01#2`, 21 s later.

## How long does the dip have to be?

Long enough for the temperature probe to reach the food, because the EC reading
is compensated with it at ~2 %/°C. Going from room air into 45 °C soup with a
~3 s time constant, a 1 s dip reads the soup as ~27 °C and the salinity comes out
tens of percent high. The firmware cannot fix this — it flags it (`tempSettled`
false, a wider range, and a warning on Serial) and the simulation reports
salinity error with and without the flag so the cost is visible. **Tune
`TAU_IN` in `test/bite_sim.cpp` against the real probe before believing any of
these numbers.**

## Simulation results

400 randomized sessions never used for tuning (random speeds, heights, tilts,
pauses, dip lengths, probe pressure, tremor, MPU errors). `cd test && make run`

Hold-out seeds (`SEEDBASE=90000`), so none of these sessions were used for
tuning. Two things in the harness changed with this firmware, and both are
corrections rather than conveniences:

- The simulated probe used to read **120 mV forever** after touching food. The
  real probe falls to 9 mV within one reading and settles at 3–4. Against the
  old model the detector never saw the probe leave and no bite ever completed.
- Actions hold still for ~3 s after the scoop and stay open ~3 s after the pour,
  because the weight now latches after 3 s and the bite confirms 2 s after the
  food goes. Without that the confirm lands in the next action's window.

| Action | Correct |
|---|---|
| Scoop, dip ~1 s, eat | 100% |
| Scoop, dip 6–12 s, eat | 100% |
| Scoop and eat, never dipped | 100% |
| Dip too briefly to count, eat | 100% |
| Dip, look again, dip, eat | 100% |
| Dip, add more food, dip again, eat | 100% |
| Dip, then tip it back in the bowl | 100% |
| Dip, eat half, lower, eat the rest | 95% |
| Knock the table with a dipped spoonful, then eat | 100% |
| **Real bites missed** | **0 / 1618** |

And what the design costs, as numbers rather than caveats:

| | |
|---|---|
| Eaten grams error (median / 95th pct) | 1% / 7% |
| **Grams counted beyond what was eaten** | **1.1%** — was 11.2% before the pour requirement: re-scooping a measured spoonful no longer closes a bite unless the bowl was tipped. |
| Salinity error, all bites (median / 95th pct) | 8.8% / 100% |
| **Salinity error, temperature settled** (median / 95th pct) | **1.2% / 4.3%** — what a dip long enough to stop the probe climbing buys |
| Bites whose salinity was never measured (no dip) | 20% |

The 100% tail on "all bites" is the never-dipped bites, which carry salinity 0 by
design and are not sent to the cloud.

### The interlock, and the hole in it

100 sessions of 45–70 °C soup, which must never be recorded:

| Dip length | Dropped | Slipped through |
|---|---|---|
| 0.8–1.5 s | 56 / 400 | **344 (86%)** |
| 6–12 s | 400 / 400 | 0 |

A short dip does not defeat the interlock by being wrong — it defeats it by being
honest. The probe is still at room temperature, so it correctly reports ~27 °C,
which is in range, and the food's 60 °C is never seen. **The interlock is only as
good as the dip is long**, which is the same requirement the salinity numbers
have. If the device must guarantee it, the dip has to be enforced by length, or
the temperature probe has to live in the food rather than visit it.

Simulated, not measured.

## Before real use

1. `LoadCellCalibrate` → paste `LOADCELL_SCALE` into `Sensors.h` (grams thresholds
   are meaningless until then).
2. `ECCalibrate` with both solutions.
3. Boot with the spoon empty, level and still (or type `z`).
4. Measure the salt factor `NACL_MG_PER_G_PER_MS` (placeholder 0.55) with known
   salt solutions.
5. Watch the debug line through one dip and check the two thresholds the new flow
   rests on: `probe IN` must appear while the probe is in the spoon and `out`
   within a second of lifting it (that is `WET_MV` / `DRY_MV` against the
   residue this probe actually leaves), and `loaded X g` must not move while the
   probe is down.
6. Time how long the probe takes to stop climbing in the food, and set the dip
   length — and `TAU_IN` in the simulation — from that, not from a guess.
