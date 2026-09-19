# Load-cell firmware (alternative design)

ESP32 firmware that **weighs every bite** with a load cell instead of assuming a
fixed scoop volume. It's an alternative to `firmware/spoon/` and is here to be
compared, not merged over it. See the PR for the side-by-side.

Status: compiles for the ESP32 (25% flash). Sensors confirmed reading on the real
board (DS18B20, ADS1115, MPU-6050, HX711). **Bite logic tested in simulation only**;
load cell and EC not calibrated yet.

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

`SalinityTest/BiteDetector.h` has the rules and every threshold at the top.

- **Scoop:** weight ≥ 4 g **and** EC probe wet.
- **Measure:** average of 0.5 s held level and still (else while moving, flagged).
  Salinity is temperature compensated; the load cell is tilt-corrected up to 20°.
- **Food leaves** (weight < 30% of the scoop for 0.3 s), then ask where it went:
  - probe out of the food (EC fell) → **bite**, eaten = loaded − leftover
  - probe still in liquid (EC high) → dipped back into the soup, no bite
  - tipped past 70° → poured out, no bite
- **Pace:** two bites < 6 s apart → LED on for 5 s.

Motion is used for "still" and "tilt" only. Estimating up/down by integrating the
accelerometer was tried and rejected: with this MPU's per-axis error (reads 10.88
at rest) plus hand tremor it drifted by metres in simulation.

## Simulation results

400 randomized sessions never used for tuning (random speeds, heights, tilts,
pauses, tremor, MPU errors). `cd test && make run`

| Action | Correct |
|---|---|
| Normal bite | 99% |
| Full spoon dipped back into soup, re-scoop, eat | 96% |
| Lift, then put back in the soup | 100% |
| Tip food back out | 100% |
| Hesitate, then eat | 100% |
| Knock the table, then eat | 100% |
| Eat half, lower, eat the rest | 87% |
| **Real bites missed / false bites** | **8 / 1534, 0** |
| Eaten grams error (median / 95th pct) | 2% / 10% |

Simulated, not measured. The dip-vs-eaten rule assumes the EC electrodes are
uncovered once < ~3 g is left in the bowl; check `EC now X% of loaded` in the
debug line after a real bite (must fall below 50%).

## Before real use

1. `LoadCellCalibrate` → paste `LOADCELL_SCALE` into `Sensors.h` (grams thresholds
   are meaningless until then).
2. `ECCalibrate` with both solutions.
3. Boot with the spoon empty, level and still (or type `z`).
4. Measure the salt factor `NACL_MG_PER_G_PER_MS` (placeholder 0.55) with known
   salt solutions.
