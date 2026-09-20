# Load-cell firmware (alternative design)

ESP32 firmware that **weighs every bite** with a load cell instead of assuming a
fixed scoop volume. It's an alternative to `firmware/spoon/` and is here to be
compared, not merged over it. See the PR for the side-by-side.

Status: compiles for the ESP32 (25% flash). Sensors confirmed reading on the real
board (DS18B20, ADS1115, MPU-6050, HX711). **Bite logic tested in simulation only**;
load cell and EC not calibrated yet.

The measurement flow was rebuilt around a **probe dipped into the spoon** rather
than one riding in the bowl — see *How a bite is decided*. It now also **sends
bites to the backend** over WiFi (`Uplink.cpp`), so this sketch no longer stops
at Serial.

## What's here

| Path | What it is |
|---|---|
| `SalinityTest/` | Main sketch: sensors at 50 Hz, bite detection, sodium per bite, pace LED, WiFi uplink |
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
MPU6050, Adafruit ADS1X15, HX711 (Bogdan Necula), and for the uplink
**ArduinoJson** (Benoit Blanchon) and **WebSockets** (Markus Sattler,
"arduinoWebSockets").

## How a bite is decided

The probe is a **separate instrument dipped into the spoon**, not a sensor riding
in the bowl. That gives four steps, and each one is a state in
`SalinityTest/BiteDetector.h`, which has the rules and every threshold at the top.

1. **Scoop** (`EMPTY → LOADED`). Weight ≥ 4 g. The probe is out, so the load cell
   reads food and nothing else — **this is the only moment the scoop weight can
   be trusted**, so it is measured and latched here: the mean of 0.5 s held level
   and still, tilt-corrected up to 20°, or the instantaneous weight if the user
   never pauses (flagged, wider range).
2. **Dip** (`LOADED → DIPPING`). EC above 250 mV means the probe is in the food.
   It leans on the spoon, so **the weight is frozen for the whole dip** and
   nothing it does means anything.
3. **Measure** (`DIPPING → MEASURED`). EC below 150 mV for 0.3 s means the probe
   is out. Salinity is the **median of the last 2 s** of the dip, not its mean:
   the probe arrives from room air and the EC reading is compensated with a
   temperature that is still climbing, so early samples describe a food that does
   not exist. A dip shorter than 5 readings (0.5 s) is discarded.
4. **Eat** (`MEASURED → EMPTY`). Weight below 30 % of the latched scoop for 0.3 s
   → **bite**, eaten = loaded − leftover.

**The interlock.** A dip whose median temperature falls outside the probe's rated
**0–40 °C** is dropped, and the spoonful is not recorded at all — not even with
the previous dip's salinity, because carrying a number onto food we know is out
of range is the log-it-anyway path wearing a different hat. Same numbers as
`firmware/spoon/config.h` and `backend/app/salinity.py`, for the same reason:
outside that range the temperature compensation was never characterised, so a
reading there is not less precise, it is unsupported.

**A falling weight ends the bite. Full stop.** There is no pour detection, no
abort, no "was the probe still in liquid" — tipping a measured spoonful back into
the bowl is recorded as a bite. That is the accepted cost of a rule a user can
predict, and the simulation asserts it so it cannot quietly come back.

Two things the flow has to handle because the probe is separate:

- **Eaten without a dip.** The salinity of the last dip is reused (same bowl,
  same soup), the bite is flagged `salinityCarried` and its range widens by 25 %.
  With no earlier dip the spoonful is not recorded, and says so on Serial.
- **Topping up.** Weight rising more than 2 g above a measured scoop sends it
  back to `LOADED` — the new food needs its own dip.

Motion is now an instrument, not a judge: tilt correction and a "weighed while
moving" flag. A missing MPU-6050 lowers quality instead of blocking bites.
Estimating up/down by integrating the accelerometer was tried and rejected: with
this MPU's per-axis error (reads 10.88 at rest) plus hand tremor it drifted by
metres in simulation.

**Pace:** two bites < 6 s apart → LED on for 5 s.

## Sending bites to the backend

`Uplink.cpp` connects to `ws://BACKEND_HOST:8000/ws/ingest` and emits one
`bite/v2` per bite, the format in `docs/telemetry-schema.md`. Ported from
`firmware/spoon`, which had the transport but no load cell.

Credentials go in `SalinityTest/secrets.h` (gitignored, create it yourself):

```c
#define WIFI_SSID      "my-network"
#define WIFI_PASSWORD  "..."
#define BACKEND_HOST   "192.168.1.100"   // the laptop, not localhost
```

Start the backend with `--host 0.0.0.0`. Bound to localhost it is invisible to
the spoon, which connects from another machine.

**Offline is a supported state.** With no `secrets.h`, no WiFi or no server, the
sketch keeps detecting and printing bites over Serial — that is how you bench it,
and the socket reconnects by itself. But **bites taken offline are dropped, not
queued**, so the debug line counts them (`3 LOST while offline`) rather than let
a demo look healthy while the dashboard sits empty.

Three mappings worth knowing, all of which the contract already had a place for:

| Firmware | `bite/v2` | Why |
|---|---|---|
| measured grams | `weightGrams` + `volume_source: "load_cell"` | the whole point of this spoon; `backend/app/schema.py` already accepts `load_cell` |
| `salinityCarried` | `salinity_source: "bowl_reference"` | the contract's own term for a salinity inherited from an earlier in-range reading of the same vessel — the dashboard labels it |
| `heldStill`, `tempSettled` | `flags: ["moving", "tempUnsettled"]` | both already documented as load-cell-only flags |

**The salt model changed.** This firmware used a linear
`NACL_MG_PER_G_PER_MS = 0.55`; it now uses the quadratic curve shared with
`firmware/spoon/config.h` and `backend/app/salinity.py`, because
`docs/telemetry-schema.md` says `salinity_g_l` comes from "the calibrated
quadratic curve, not a linear factor". This is not cosmetic: `store.recompute_meal`
**sums the device's `sodiumEstimate`** rather than recomputing it, so whatever the
firmware calculates is the number on the clinician's screen.

### Verified end to end, minus the ESP32

The exact JSON this emits was pushed through a running backend over the real
socket: 3 in-range bites stored with every field round-tripping, meal total
74.9 mg against 74.9 mg expected, 33.2 g, and a 55 °C bite **refused by the
server** as well as by the device.

One gap that double enforcement does not close: the backend judges the
temperature the device reports, so a dip too short for the probe to warm up
sends an honest-looking in-range reading and **both** checks pass. The server
also sends its rejection to the patient's session socket, not back down
`/ws/ingest`, so the device never learns a bite was refused.

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

Hold-out seeds (`SEEDBASE=90000`), so none of these sessions were used for tuning.
The previous design's table described a spoon-mounted probe and does not carry
over; it has been removed rather than left to be misread.

| Action | Correct |
|---|---|
| Scoop, dip ~1 s, eat | 97% |
| Scoop, dip 6–12 s, eat | 97% |
| Scoop and eat, never dipped | 91% |
| Dip too briefly to count, eat | 97% |
| Dip, look again, dip, eat | 100% |
| Dip, add more food, dip again, eat | 99% |
| Dip, then tip it back in the bowl | 96% |
| Dip, eat half, lower, eat the rest | 91% |
| Knock the table with a dipped spoonful, then eat | 97% |
| **Real bites missed** | **8 / 1623** |

And what the design costs, as numbers rather than caveats:

| | |
|---|---|
| Eaten grams error (median / 95th pct) | 3% / 66% |
| **Grams counted beyond what was eaten** | **11.2%** — re-scooping a measured spoonful is a falling weight, so it closes a bite and the re-scoop opens another. The 95th-pct grams error above is mostly this. |
| Salinity error, all bites (median / 95th pct) | 5.3% / 20.8% |
| **Salinity error, temperature settled** (median / 95th pct) | **1.3% / 5.1%** — what a dip long enough to stop the probe climbing buys |
| Bites whose salinity came from an earlier dip | 15% |
| Bites weighed while moving | 30% |

The 8 missed bites are cold, dilute food: EC scales with temperature, so near
5 °C a weak broth can sit under `WET_MV` and the dip is never noticed at all.
`WET_MV` cannot simply be lowered — `DRY_MV` has to clear the conductive film the
probe keeps after a dip, and `WET_MV` has to clear `DRY_MV`. Measure that film on
the real probe (step 5 below) and set all three together.

### The interlock, and the hole in it

100 sessions of 45–70 °C soup, which must never be recorded:

| Dip length | Dropped | Slipped through |
|---|---|---|
| 0.8–1.5 s | 98 / 400 | **302 (76%)** |
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
7. Create `SalinityTest/secrets.h`, start the backend on `0.0.0.0`, and watch for
   `[ws] connected` and then `[uplink] connected | N sent` in the debug line.
   The dashboard should show the same bite the Serial monitor just printed.
