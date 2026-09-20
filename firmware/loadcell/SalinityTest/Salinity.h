/*
 * Salinity.h - EC -> NaCl -> sodium, the team's curve.
 *
 * Mirror of backend/app/salinity.py and firmware/spoon/salinity.h. If the fit
 * changes there, change it here. The backend recomputes sodium from the raw
 * fields, so the two must agree or the dashboard and the spoon will disagree
 * about the same bite.
 *
 * The curve is quadratic on purpose. A flat factor (the old 0.55 mg/g/mS) reads
 * about 2% high at 10 mS/cm and drifts further from there.
 */
#ifndef SALINITY_H
#define SALINITY_H

#include <math.h>

// g/L NaCl = A*ec25 + B*ec25^2, fitted to reference NaCl conductivity at 25 C:
//   2.0 mS/cm -> 1.0 g/L,  17.5 mS/cm -> 10.0 g/L
// Replace with your own fit - see docs/calibration.md.
#define COEFF_A            0.49078f
#define COEFF_B            0.004608f
#define SODIUM_PER_G_NACL  0.3934f   // 1 g NaCl = 393.4 mg sodium

// mS/cm at 25 C -> g/L NaCl-equivalent.
static inline float ecToGPerLitre(float ec25MsCm) {
  if (ec25MsCm <= 0.0f) return 0.0f;
  return COEFF_A * ec25MsCm + COEFF_B * ec25MsCm * ec25MsCm;
}

// g/L x grams x 0.3934 = mg sodium. (g/L x g is mg of NaCl at 1 g/mL; soups run
// 1.00-1.03, well inside the error budget.) Same expression as the contract.
static inline float sodiumMgFrom(float gPerLitre, float weightG) {
  return gPerLitre * fmaxf(weightG, 0.0f) * SODIUM_PER_G_NACL;
}

#endif
