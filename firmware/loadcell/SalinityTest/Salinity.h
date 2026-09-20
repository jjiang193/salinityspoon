/*
 * Salinity.h - EC (mS/cm at 25 C) -> NaCl g/L -> sodium mg.
 *
 * Mirrors firmware/spoon/salinity.h and backend/app/salinity.py. Change the
 * curve in one, change it in all three. Constants live in Config.h.
 *
 * The backend does NOT recompute sodium from salinityIndex - store.recompute_meal
 * sums the device's sodiumEstimate - so whatever this file computes is the number
 * on the clinician's screen.
 */
#ifndef SALINITY_H
#define SALINITY_H

#include <math.h>
#include "Config.h"

namespace salinity {

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

// The volume spoon passes millilitres here; this one passes the grams the load
// cell actually weighed. For broths and stocks density is within a percent of
// 1 g/mL, which is far inside the EC error, so the two are interchangeable.
inline float sodiumMg(float gPerL, float grams) {
  return gPerL * SODIUM_FRACTION_OF_NACL * grams;
}

}  // namespace salinity

#endif
