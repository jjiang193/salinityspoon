#pragma once
#include <Arduino.h>
#include "config.h"

// ---------------------------------------------------------------------------
// EC (mS/cm @ 25 C) -> NaCl -> sodium
//
// Mirrors backend/app/salinity.py. Change the curve in one, change it in both.
// ---------------------------------------------------------------------------

namespace salinity {

// NaCl is slightly sublinear in conductivity over our range, so a quadratic
// beats a single multiplier. Reference points the defaults hit:
//   2.0 mS/cm -> 1.0 g/L      17.5 mS/cm -> 10.0 g/L
inline float ecToGramsPerLitre(float ec25) {
  if (ec25 <= 0.0f) return 0.0f;
  return SALINITY_COEFF_A * ec25 + SALINITY_COEFF_B * ec25 * ec25;
}

// Scale AFTER conversion. The curve is quadratic, so scaling the input does
// not scale the output: for a true 10 g/L sample read at 1:1, convert-then-
// scale gives 10.0 g/L and scale-then-convert gives 11.3 g/L. Do not "fix" this.
inline float applyDilution(float gPerL, float factor) {
  return gPerL * factor;
}

inline float sodiumMg(float gPerL, float volumeMl) {
  return gPerL * SODIUM_FRACTION_OF_NACL * volumeMl;
}

// The interlock. A reading outside the probe's rated range is not a
// less-precise reading, it is an unsupported one: the library's 2%/C
// compensation was never characterised out there.
inline bool tempInRange(float tempC) {
  return !isnan(tempC) && tempC >= PROBE_TEMP_MIN_C && tempC <= PROBE_TEMP_MAX_C;
}

}  // namespace salinity
