# Bite Detection

## The timing problem

A real scoop is in the liquid for roughly **0.5 seconds**.

An earlier design required ~2 seconds of settled samples at 5 Hz before trusting
a reading. At eating cadence, every bite would have failed that test. The two
requirements — trustworthy readings and real eating speed — are in direct
conflict at low sample rates.

**The resolution is to sample faster, not to trust less.** The ADS1115 runs at
860 SPS; at 400 kHz I²C a read costs ~100 µs, so 100 Hz is comfortable. A 0.5 s
submersion then yields ~50 EC samples — *more* statistical evidence than the old
2-second window ever had, in a tenth of the time.

Faster sampling buys both speed and confidence. It is the single most important
firmware decision in this project.

## State machine

```
IDLE ──submerged──► WETTING ──150 ms──► CAPTURE ──lift──► CONFIRM ──► LOG → IDLE
                                           │
                                     (unstable / too few samples)
                                           └───────────────────────► ABORT → IDLE
```

| State | Entry condition | Action |
|---|---|---|
| `IDLE` | — | Watch EC floor and temperature shift for submersion |
| `WETTING` | submerged | **Discard 150 ms.** Probe film formation is a transient and the first samples lie |
| `CAPTURE` | wetting done | Accumulate EC at 100 Hz while submerged |
| `CONFIRM` | EC drops **and** IMU sees a lift | Require both — either alone is noise |
| `LOG` | confirmed | Median of CAPTURE samples → `bite/v2` |
| `ABORT` | EC σ too high, or < 20 samples, or temperature out of range | Discard, log nothing |

### Why median, not mean

One bubble against the electrode must not move a sodium figure. A median over
~50 samples is immune to a handful of outliers; a mean is not.

### Why CONFIRM needs both signals

EC dropping alone could be the probe breaking the surface mid-stir. An IMU lift
alone could be repositioning the hand. A bite is the conjunction, and requiring
both is what keeps the count honest.

## Temperature gating

`tempC > 40 °C` forces `ABORT`. No bite is logged, and the LED signals wait.

The DS18B20's 750 ms conversion cannot keep up with bites — and does not need
to. Liquid temperature changes slowly. **Read it at 1 Hz, hold the last value,
and never block the EC loop on it.**

## Pace cue

Driven entirely by `biteIntervalSec`. No extra sensor.

| Gap | LED | Rationale |
|---|---|---|
| > 30 s | green | 30 bites × 30 s ≈ a 15-minute meal |
| 15–30 s | yellow | speeding up |
| < 15 s | red | too fast |

**These thresholds are invented defaults.** They are config constants, and the
pitch should say they are placeholders pending a clinical source rather than
implying they are evidence-based.

## Known limitations

State them; do not let a judge find them first.

- **Cannot distinguish a scoop that was eaten from one put back.** IMU tilt
  toward the mouth is a plausible refinement, but do not claim it until measured.
- **Cannot read dry solids.** Conductivity needs a liquid path.
- **Cannot separate sodium from potassium.** It reads all ions. Everything
  reported is NaCl-equivalent salinity.
- **Cannot capture food eaten without the device.**
