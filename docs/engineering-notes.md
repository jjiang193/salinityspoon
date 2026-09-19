# Engineering Notes — what was actually hard

Unnarrated difficulty scores zero. This is the record of the problems that took
real work, and what the resolution was.

---

## 1. A bite is half a second long

**The problem.** Trustworthy conductivity needs a settled probe. The obvious
approach — wait for the gyroscope to go quiet and the EC signal to stop moving,
then read — needs about two seconds. A real scoop is in the liquid for roughly
**0.5 s**. At eating cadence, every single bite fails that test.

**What did not work.** Loosening the stability threshold. That trades the
measurement's credibility for its existence, which is the wrong trade: a number
you cannot defend is worse than no number.

**The resolution.** Sample faster instead of trusting less. The ADS1115 runs at
860 SPS; at 400 kHz I²C a conversion read costs ~100 µs, so 100 Hz is
comfortable. A 0.5 s submersion then yields **~50 EC samples** — more statistical
evidence than the slow two-second settle ever had, in a tenth of the time.

Faster sampling bought both speed *and* confidence. That is the single most
important decision in the firmware.

## 2. The probe lies for the first 150 ms

Immersion is not instantaneous at the electrode surface. The first samples after
contact are a wetting transient, not a measurement, and averaging them in biases
every reading low.

The state machine has a dedicated `WETTING` state that **discards** those samples
rather than weighting them down. Throwing data away is usually wrong; here it is
the only correct option, because those samples are not noisy measurements — they
are not measurements.

## 3. One bubble must not move a sodium figure

Bubbles and turbulence break the conduction path intermittently, producing
outliers that are large and one-sided.

A **median** over ~50 samples is immune to a handful of them. A mean is not. This
is a one-word change with a large effect on how defensible the output is, and it
is why `ec_sample_count` is in the wire format — a bite computed from 22 samples
deserves less trust than one computed from 50, and the consumer can see which it
got.

## 4. ±5% of full scale, not of reading

The DFR0300's accuracy spec is **±5% F.S.** — ±1 mS/cm absolute, at any reading.
Relative error therefore grows as the measurement shrinks:

| Reading | Relative error |
|---|---|
| 14 mS/cm | ±7% |
| 10 mS/cm | ±10% |
| 5 mS/cm | ±20% |
| 2 mS/cm | ±50% |

This inverted a decision. Dilution had looked attractive for bringing samples
into the recommended 1–15 mS/cm band, but it pushes the reading *down-scale*,
where the fixed error dominates. The correct strategy is the opposite: measure as
high in the band as possible, and dilute only when genuinely over-range.

## 5. The quadratic does not commute with scaling

When dilution *is* necessary, the correction has to be applied after converting
EC to concentration, never before:

```
CORRECT:  ec25 → g/L → × factor
WRONG:    ec25 × factor → g/L
```

For a true 10 g/L sample measured at 1:1, the right order gives 10.0 g/L and the
wrong one gives **11.3 g/L** — 13% high, silently. The curve is quadratic, so
scaling the input does not scale the output. Both the firmware and the backend
carry a comment saying not to "fix" this.

## 6. Error propagation is what justified dropping the load cell

A load cell in the spoon handle looked necessary for per-bite mass. It is not,
and the reason is arithmetic.

Scoop volume varies with standard deviation σ around mean μ. Per bite the
coefficient of variation is σ/μ ≈ **25%**. But across a meal of *n* bites the
total's standard deviation is σ√n, so:

```
per bite:            2.5 / 10          = 25%
per meal (n = 30):   2.5·√30 / (30·10) = 4.6%
```

**Random scoop variation cancels as √n.** The meal total — the number anyone
actually acts on — is roughly five times more accurate than any single bite, from
zero additional hardware.

The full budget, combined in quadrature:

| Source | Per bite | Per meal |
|---|---|---|
| EC sensor (±5% F.S. at ~12 mS/cm) | ±8% | ±8% |
| Scoop volume | ±25% | ±4.6% |
| Curve fit | ±5% | ±5% |
| **Combined (RSS)** | **±27%** | **±10%** |

The sensor, not the volume estimate, dominates the meal-level budget. A load cell
would have attacked the smaller of the two terms — while introducing grip-moment
coupling that cannot be tared out, and an HX711 whose bit-banged read is
corrupted by WiFi interrupts stretching the clock line past ~60 µs.

## 7. The probe's temperature rating reshaped the product

The DFR0300 is rated **0–40 °C**. Soup is served at 70–80 °C and eaten at 60–65.
So the original framing — per-bite salinity in hot soup — was never available.

Not as a precision trade. The library's 2%/°C compensation was never
characterised 30 °C outside its range, which makes such a reading **unsupported**
rather than merely imprecise, with an error nobody can bound.

Rather than hide that, the limit became a feature: the DS18B20 (−55 to +125 °C,
so never itself the constraint) gates every measurement, and the device visibly
refuses to record what it cannot support. The refusal is enforced **twice** — on
the device and again at the server — so a firmware bug or a spoofed event cannot
put an unsupported reading into the record.

## 8. The interlock was invisible in practice

The out-of-range warning was keyed on the instantaneous reading: not in range
*and* submerged. Correct logic, useless behaviour. The probe is only submerged
~0.65 s per dip; between dips it reads room air, which *is* in range.

So the most important state in the system flashed for under a second and then
showed a reassuring green indicator while the liquid was still at 55 °C.

The fix was to latch the last *submerged* reading and key the warning on that.
Found by screenshotting the running dashboard, not by reading the code — the
logic was right and the behaviour was wrong.

## 9. Idempotency that silently lost data

An earlier design keyed stored bites on `{timestamp}#{device_id}` with a
"skip if exists" guard. Two genuine bites in the same second from one device
produce an identical key, and the guard discards the second — **data loss
disguised as deduplication**, in a system whose own requirements said a logged
bite must never be lost.

The key now includes `bite_id`. Replay is still idempotent; distinct bites are
still distinct.

## 10. Replay had to shift time

Recorded sessions replay through the identical ingest path. Naively resending
them breaks three things at once: the bites land in the past so "today's intake"
misses them, meal segmentation sees one enormous gap, and the uniqueness guard
above drops the whole second replay as duplicate.

Shifting every timestamp by a single offset — preserving internal spacing —
fixes all three, and makes a recording replayable any number of times.

---

## Traps avoided

Things that would have cost hours if they had not been caught in the design.

- **ADC2 is unusable while WiFi is active.** `analogRead()` on an ADC2 pin
  returns garbage once the radio is up. The symptom — readings fine on the
  bench, insane once networked — looks exactly like a sensor fault. Routing EC
  through the ADS1115 sidesteps it entirely.
- **The probe is platinum-black coated and can only be rinsed in distilled
  water.** Tap water destroys the coating permanently. A food utensil you cannot
  rinse in a sink is also an honest limit on the product claim.
- **"Should not be immersed for long periods."** A spoon resting in a bowl
  violates the datasheet. Dip-and-remove is both the correct usage pattern and
  what the bite detector already enforces.
- **DS18B20 conversion takes 750 ms** and cannot keep pace with bites. It does
  not need to — liquid temperature moves slowly. Read at 1 Hz, hold the last
  value, never block the EC loop on it.
