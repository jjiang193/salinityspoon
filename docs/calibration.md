# Calibration

Three calibrations. Doing only the first is the most common reason a salinity
number is confidently wrong.

---

## 1. EC probe (voltage → mS/cm)

The DFRobot library's own routine. Teaches it how your specific probe's voltage
maps to conductivity.

**You need** the 1413 µS/cm and 12.88 mS/cm standards that ship with the DFR0300.

1. Serial Monitor at 115200 baud.
2. Rinse the probe in **distilled water**, shake off the drops. Never tap water.
3. Place in the **1413 µS/cm** standard, let it settle.
4. Type `enterec`, then `calec`, then `exitec`.
5. Rinse, repeat in the **12.88 mS/cm** standard.

The library recognises which standard it is in, so order does not matter, and it
stores the result in EEPROM.

**Redo it** if readings drift between sessions, the probe has been in anything
oily, or the ADC path changed. A switch between the internal ADC and the ADS1115
invalidates the stored calibration outright — the library is seeing voltages
measured by different hardware.

---

## 2. Salinity curve (mS/cm → g/L NaCl)

**The one people skip, and the one that decides whether the sodium number means
anything.**

Generic TDS meters multiply EC by ~0.5 and call it ppm. That is a rough
approximation for tap water and a poor one for anything salted.

### Protocol

Make known solutions by mass in distilled water, record the EC your system
reports at a stable in-range temperature (20–25 °C is ideal):

| Target | NaCl | Water | Expected EC |
|---|---|---|---|
| 0.25 % | 2.5 g | 1000 mL | ~4.9 mS/cm |
| 0.50 % | 5.0 g | 1000 mL | ~9.7 mS/cm |
| 0.75 % | 7.5 g | 1000 mL | ~14.2 mS/cm |
| 1.00 % | 10.0 g | 1000 mL | ~17.5 mS/cm |

Use a scale with 0.1 g resolution. Dip, let settle, record `salinityIndex` (the conductivity at 25 °C, in mS/cm).

Fit `g/L = A·EC + B·EC²` (any spreadsheet's polynomial trendline through the
origin) and put the coefficients in **both**:

- `firmware/spoon/config.h` → `SALINITY_COEFF_A`, `SALINITY_COEFF_B`
- `backend/app/salinity.py` → `COEFF_A`, `COEFF_B`

The shipped defaults are fitted to reference NaCl conductivity tables. They are a
starting point, **not a calibration of your probe**.

### Why quadratic

NaCl conductivity is slightly sublinear over this range — ions interfere with
each other as concentration rises. A single multiplier fitted at 0.5 % will
over-read at 1 %, which is exactly where the interesting samples live.

### Note on the 1.00 % point

17.5 mS/cm is above the probe's **recommended** 1–15 mS/cm range, though inside
its 0–20 detection range. Include it in the fit, but expect it to be the least
reliable point. If your samples routinely exceed 15 mS/cm, dilute 1:1 and apply
the correction after conversion — see `measurement-protocol.md`.

---

## 3. Scoop volume (per user)

Replaces the load cell. See `../PLAN.md` §2 for why this works.

Run **once per user**, about ten minutes:

1. Fill the vessel with water and place it on the scale.
2. Take **20 scoops**, discarding each, and **weigh every individual scoop**.
3. Compute mean and standard deviation. Water is 1.0 g/mL; for broth use
   1.02 g/mL.
4. Store `volume_ml_mean` and `volume_ml_sd` in the device profile.

**The standard deviation is not overhead — it is the reported error bar.**
`sodium_mg_low` and `sodium_mg_high` come straight from it.

### Why per user, not per device

Random scoop-to-scoop variation cancels across a meal as √n. **Systematic bias
does not.** Someone who consistently underfills has a genuinely different mean,
and only their own calibration captures it.

Frame this as a personalised scoop profile. It is honest and it is true.

### Quick recalibration

Weigh the vessel before and after 20 scoops, divide by 20. Gives the mean only,
no error bar. Use the full method at least once.

---

## 4. Validate the whole chain

Measure a solution you did **not** use in the fit — 0.6 % is a good choice. If
the dashboard reports within ±0.05 % of that, the chain is trustworthy end to
end.

Do this before the demo. Five minutes, and it is the difference between "our
sensor says 0.62 %" and "our sensor says 0.62 %, and we checked."
