# Measurement Protocol

The probe's specifications decide how this device is used. They are not
negotiable, so the protocol is built around them rather than against them.

## Probe specifications (DFR0300, K=1)

| Spec | Value | Consequence |
|---|---|---|
| Temperature range | **0–40 °C** | Defines what we can measure. See below. |
| Detection range | 0–20 mS/cm | Hard ceiling |
| **Recommended** range | **1–15 mS/cm** | Where accuracy holds |
| Accuracy | **±5% F.S.** | ±1 mS/cm *absolute*, at any reading |
| Probe life | >0.5 year | Consumable |
| Cleaning | **distilled water only** | Platinum-black coating; tap water destroys it |
| Immersion | not for long periods | Dip and remove, never soak |

## Operating envelope

**We measure salt in liquids between 0 and 40 °C.** Not hot soup straight off
the stove. Cooled or room-temperature broths, stocks, cold soups, brines,
beverages, and cooking liquids taken off the heat.

This is a design decision, not a limitation we are hiding. A reading taken
outside the probe's rated range is not a less-precise reading, it is an
unsupported one: the library's 2%/°C temperature compensation was never
characterised above 40 °C, so extrapolating it produces an error nobody can
bound.

### The temperature interlock

The DS18B20 (rated −55 to +125 °C, so never itself the constraint) gates every
salinity measurement:

```
tempC ≤ 40 °C  → measure, log the bite
tempC > 40 °C  → refuse, LED signals wait, no bite logged
```

This protects the probe across hundreds of test cycles and makes invalid data
impossible to record rather than merely discouraged.

## Why ±5% of full scale changes the strategy

The accuracy spec is **±5% of full scale**, not of reading — ±1 mS/cm regardless
of what you are measuring. Relative error therefore grows as the reading shrinks:

| Reading | Absolute error | Relative error |
|---|---|---|
| 14 mS/cm | ±1 mS/cm | **±7%** |
| 10 mS/cm | ±1 mS/cm | **±10%** |
| 5 mS/cm | ±1 mS/cm | ±20% |
| 2 mS/cm | ±1 mS/cm | ±50% |

**Measure as high in the recommended band as you can.** A 0.5–0.8% salt liquid
reads 9.5–14.5 mS/cm, which is the sweet spot: inside the recommended range and
high enough that the fixed error stays small.

This is why we do **not** dilute by default. Dilution was attractive when the
goal was cooling a hot sample, but within 0–40 °C it only pushes the reading
down-scale and makes relative error worse.

## When to dilute anyway

Only for **over-range** samples above ~15 mS/cm (roughly >0.85% salt — very
salty brines and some commercial stocks).

Dilute 1:1 with distilled water, then apply the correction **in concentration
space, not EC space**:

```
CORRECT:  ec25 → salinity_g_l → × dilution_factor
WRONG:    ec25 × dilution_factor → salinity_g_l
```

The EC↔concentration curve is quadratic, so scaling the input does not scale the
output. For a true 10 g/L sample measured at 1:1:

| Order | Result | Error |
|---|---|---|
| convert, then scale | 10.0 g/L | — |
| scale, then convert | 11.3 g/L | **+13%** |

The firmware and backend both apply the factor after conversion. Do not "fix"
this.

## Error budget

The number to quote when asked how accurate this is.

| Source | Per bite | Per meal (30 bites) |
|---|---|---|
| EC sensor, ±5% F.S. at ~12 mS/cm | ±8% | ±8% |
| Scoop volume (σ/μ ≈ 25%, averages as √n) | ±25% | ±4.6% |
| EC→NaCl curve fit | ±5% | ±5% |
| **Combined (RSS)** | **≈ ±27%** | **≈ ±10%** |

Two things follow, and both are worth saying out loud:

1. **The meal total is roughly three times more accurate than any single bite**,
   because scoop-to-scoop variation is random and cancels over a meal. This is
   the entire justification for tracking bites instead of weighing them.
2. **The sensor dominates the meal-total budget**, not the volume estimate. A
   load cell would have attacked the smaller of the two error terms.

### Unquantified bias

Conductivity reads **all ions**, not sodium. Potassium, magnesium, calcium and
dissolved organics all contribute. Everything above is therefore the precision of
a **NaCl-equivalent salinity** measurement, not of true sodium content, and the
gap between those two is a bias we cannot measure with this hardware.

Say "salinity as NaCl equivalent". Never "sodium content".

## Handling rules

- **Rinse in distilled water only.** Tap water damages the platinum-black layer
  and the damage is permanent.
- **Dip and remove.** Never leave the probe sitting in liquid.
- **Never wipe the electrode surface.** Shake off droplets.
- **Not food-safe.** This is a measurement instrument, not a utensil. Nothing
  measured with it should be eaten during development.
