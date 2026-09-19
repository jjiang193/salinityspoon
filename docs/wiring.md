# Wiring

## Pin map

| Component | Signal | ESP32 pin | Bus |
|---|---|---|---|
| EC probe | analog → **ADS1115 A0** | — | — |
| ADS1115 | SDA / SCL | GPIO21 / GPIO22 | I²C `0x48` |
| MPU-6050 | SDA / SCL | GPIO21 / GPIO22 | I²C `0x68` |
| DS18B20 | data | GPIO4 | 1-Wire, **4.7 kΩ pull-up to 3.3 V** |
| Pace LED | green / yellow / red | GPIO25 / 26 / 27 | digital |

One I²C bus carries the ADS1115 (`0x48`) and the MPU-6050 (`0x68`); the
addresses do not collide. Power every sensor from the **3.3 V** rail.

## Things that will bite you

### The EC probe must go through the ADS1115

Not into an ESP32 pin. Two reasons:

1. **Resolution.** The DFRobot library was written for a 5 V 10-bit ADC. The
   ESP32's internal ADC is noisy and nonlinear, and EC readings drift.
2. **Sample rate.** Bite detection needs ~100 Hz EC sampling (see
   `bite-detection.md`). The ADS1115 does 860 SPS cleanly.

Get the **ADS1115** (16-bit), not the ADS1015 (12-bit), which defeats the point.

### Power the EC board from 3.3 V

It accepts 3.0–5.0 V, but its output swings 0–3.4 V. Driven at 5 V that can
exceed the ESP32's input maximum. At 3.3 V the output stays safe.

### ADC2 is unusable with WiFi — and no longer relevant

The ESP32's ADC2 is claimed by the WiFi radio; `analogRead()` on an ADC2 pin
returns garbage whenever WiFi is active. **This build routes EC through the
ADS1115, so the issue does not arise.**

Documented anyway, because anyone falling back to the internal ADC will hit it,
and the symptom — readings fine on the bench, insane once the network comes up —
looks exactly like a sensor fault.

### Check the LED's polarity

Common-cathode and common-anode RGB LEDs invert every `digitalWrite`. Confirm
which you have before debugging "the LED is backwards". 220–330 Ω per leg.

### DS18B20 pull-up is not optional

Without the 4.7 kΩ resistor between data and 3.3 V you get `-127 °C`, which the
firmware treats as a disconnected probe — and with no temperature there is no
interlock, so no bites will be logged at all.

## Bench checks before flashing anything

Debugging three sensors at once is much harder than debugging them one at a time.

1. **I²C scan** — expect `0x48` and `0x68`. Nothing found means a wiring or power
   fault.
2. **DS18B20 alone** — should report room temperature. `-127` means the pull-up
   is missing or the data line is on the wrong pin.
3. **EC in air** — should read near 0 mS/cm. A large nonzero reading means the
   probe is still wet or the analog line is floating.
4. **LED** — cycle all three colours.

Only then flash `spoon.ino`.

## Handling the probe

See `measurement-protocol.md`. In short: distilled water only, dip and remove,
never soak, never wipe the electrode. The platinum-black coating is delicate and
the damage is permanent.
