/*
 * BiteDetector.cpp - the bite state machine. Rules and thresholds are in BiteDetector.h.
 *
 *   EMPTY -> FILLING -> LOADED -> DIPPING -> MEASURED -> EMPTY (bite logged)
 *
 * Everything below follows from three latches: the weight is latched once the
 * food has been sitting there for LOAD_SETTLE_MS, the salinity is latched when
 * a dip ends, and the bite is only logged once the bowl has been empty for
 * EMPTY_HOLD_MS. Between those moments the sensors can say whatever they like.
 */
#include "BiteDetector.h"
#include "Salinity.h"
#include <math.h>

enum State { EMPTY, FILLING, LOADED, DIPPING, MEASURED };
static const char *STATE_NAMES[] = { "EMPTY", "FILLING", "LOADED", "DIPPING", "MEASURED" };
static State    state = EMPTY;
static uint32_t nextBiteId = 1;

// ---------- Calibration (set by biteBegin) ----------
static float zeroG;                        // load cell zero, follows slow drift while empty
static float level[3];                     // "up" in sensor axes when level (unit vector)
static float gravityRef = 9.81f;           // |accel| at rest (this MPU reads ~10.9)
static float gyroBias[3];                  // gyro reading at rest
static bool  haveMpu;                      // no MPU = no tilt correction, quality flagged down

// ---------- Tilt tracking ----------
static float up[3];                        // "up" now (unit vector)
static unsigned long lastMs;

// ---------- Temperature settling ----------
static float         tempRef;
static unsigned long tempRefAt;

// ---------- The scoop ----------
// A plain rolling mean: the latched weight is the average of the last half
// second, taken once the food has been sitting there long enough to be real.
struct WeightWindow {
  float w[LATCH_SAMPLES];
  int idx, count;
  void clear() { idx = count = 0; }
  void add(float g) {
    w[idx] = g;
    idx = (idx + 1) % LATCH_SAMPLES;
    if (count < LATCH_SAMPLES) count++;
  }
  bool full() const { return count == LATCH_SAMPLES; }
  float avg() const { float s = 0; for (int i = 0; i < count; i++) s += w[i]; return s / count; }
};
static WeightWindow  weightWin;
static unsigned long loadedSince;          // when the weight first came up (0 = it has not)
static float         loadedG;              // the scoop, latched. 0 = nothing latched yet
static bool          loadedStill;          // latched while the spoon was still and level
static unsigned long weightTrustedAt;      // before this, the load cell is still flushing a lifted probe

// ---------- The dip ----------
// Only the tail is kept: the probes arrive from room air and the EC reading is
// compensated with a temperature that is still climbing, so early samples
// describe a food that does not exist.
struct DipWindow {
  float ec[DIP_TAIL_SAMPLES], temp[DIP_TAIL_SAMPLES];
  int idx, count, total;
  void clear() { idx = count = total = 0; }
  void add(float e, float t) {
    ec[idx] = e; temp[idx] = t;
    idx = (idx + 1) % DIP_TAIL_SAMPLES;
    if (count < DIP_TAIL_SAMPLES) count++;
    total++;
  }
  static float median(const float *src, int n) {
    float v[DIP_TAIL_SAMPLES];
    for (int i = 0; i < n; i++) {          // insertion sort, n <= 20
      float x = src[i]; int j = i - 1;
      while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
      v[j + 1] = x;
    }
    return n & 1 ? v[n / 2] : 0.5f * (v[n / 2 - 1] + v[n / 2]);
  }
  float medianEc() const { return median(ec, count); }
  float medianTemp() const { return median(temp, count); }
};
static DipWindow     dipWin;
static unsigned long lastDipSampleAt;
static unsigned long drySince;             // when EC first fell below DRY_MV (0 = not)

// ---------- The measurement this scoop is carrying ----------
// Latched: taking the probes out does not touch it. Only a new dip replaces it.
static float measSalinity, measTemp;
static int   measSamples;
static bool  measTempSettled;
static bool  haveMeasurement;

// ---------- Emptying ----------
static unsigned long emptySince;           // when the weight fell below EMPTY_FRACTION (0 = not)
static float         pourTilt;             // peak tilt since the food was last plainly there
static unsigned long heavySince;           // when it rose above the scoop + TOPUP_G (0 = not)
static bool          outOfRange;           // this spoonful failed the interlock: record nothing

// ================= Helpers =================

static float mag(float x, float y, float z) { return sqrtf(x * x + y * y + z * z); }
static float accelMag(const SensorReadings &r) { return mag(r.ax, r.ay, r.az); }
static float gyroMag(const SensorReadings &r) {
  return mag(r.gx - gyroBias[0], r.gy - gyroBias[1], r.gz - gyroBias[2]);
}

// Without an MPU there is no motion evidence either way. Treat the spoon as
// level and still, and let heldStill carry the doubt into the sodium range.
static bool isStill(const SensorReadings &r) {
  if (!haveMpu || !r.mpuOk) return true;
  return gyroMag(r) < STILL_GYRO_RAD_S && fabsf(accelMag(r) - gravityRef) < STILL_ACCEL_DEV;
}
static bool isWet(const SensorReadings &r) { return r.adsOk && r.ecVoltageMv > WET_MV; }
static bool isDry(const SensorReadings &r) { return !r.adsOk || r.ecVoltageMv < DRY_MV; }
static bool tempInRange(float t) {
  return !isnan(t) && t >= PROBE_TEMP_MIN_C && t <= PROBE_TEMP_MAX_C;
}
static bool tempSettled(unsigned long now) { return now - tempRefAt >= TEMP_SETTLE_MS; }

// Angle between "up" now and "up" when level.
static float tiltDeg() {
  if (!haveMpu) return 0.0f;
  float c = up[0] * level[0] + up[1] * level[1] + up[2] * level[2];
  return acosf(constrain(c, -1.0f, 1.0f)) * 180.0f / PI;
}
static bool isLevel() { return tiltDeg() <= LEVEL_MAX_DEG; }

// Weight minus zero, corrected for small tilts (the load cell only feels gravity
// along its axis). Capped at LEVEL_MAX_DEG: the weight average lags a fast tilt,
// so more correction would over-read.
static float netWeight(const SensorReadings &r) {
  float t = fminf(tiltDeg(), LEVEL_MAX_DEG);
  return (r.weightG - zeroG) / cosf(t * PI / 180.0f);
}

// Track "up": rotate it with the gyro, then nudge it toward gravity from the
// accelerometer so it cannot drift. Accel alone reads tilt wrong while moving.
static void updateTilt(const SensorReadings &r, unsigned long now) {
  float dt = constrain((now - lastMs) / 1000.0f, 0.0f, 0.1f);
  lastMs = now;
  if (!haveMpu || !r.mpuOk) return;

  float w[3] = { r.gx - gyroBias[0], r.gy - gyroBias[1], r.gz - gyroBias[2] };
  float a[3] = { r.ax, r.ay, r.az };
  float p[3] = { up[0] - dt * (w[1] * up[2] - w[2] * up[1]),     // up -= dt * (w x up)
                 up[1] - dt * (w[2] * up[0] - w[0] * up[2]),
                 up[2] - dt * (w[0] * up[1] - w[1] * up[0]) };

  float am = accelMag(r);
  float k = fabsf(am - gravityRef) < STILL_ACCEL_DEV ? 0.02f : 0.002f;   // trust accel less mid-move
  if (am > 0.1f) for (int i = 0; i < 3; i++) p[i] += k * (a[i] / am - p[i]);

  float n = mag(p[0], p[1], p[2]);
  for (int i = 0; i < 3; i++) up[i] = p[i] / n;
}

// The team's curve (Salinity.h), not a flat factor: EC -> g/L -> mg sodium.
// The backend recomputes this from salinityIndex and weightGrams, so the two
// must agree about the same bite.
static void estimateSodium(Bite &b) {
  float range = SODIUM_RANGE_FRAC + (b.heldStill ? 0 : SODIUM_RANGE_EXTRA)
                                  + (b.tempSettled ? 0 : SODIUM_RANGE_EXTRA);
  b.salinityGPerL = ecToGPerLitre(fmaxf(b.salinityMsCm, 0.0f));
  b.sodiumMg      = sodiumMgFrom(b.salinityGPerL, b.weightG);
  b.sodiumLowMg  = b.sodiumMg * (1.0f - range);
  b.sodiumHighMg = b.sodiumMg * (1.0f + range);
}

// Start a fresh spoonful. The measurement goes with it: a new scoop has not
// been dipped yet, whatever the last one read.
static void resetScoop() {
  weightWin.clear();
  dipWin.clear();
  loadedSince = 0;
  loadedG = 0;
  loadedStill = false;
  haveMeasurement = false;
  emptySince = 0;
  pourTilt = 0;
  drySince = 0;
  heavySince = 0;
  outOfRange = false;
  weightTrustedAt = 0;
}

// Latch the scoop: the mean of the last half second, plus whether the spoon was
// behaving while that was taken.
static void latchWeight(const SensorReadings &r) {
  loadedG = weightWin.avg();
  loadedStill = haveMpu && r.mpuOk && isStill(r) && isLevel();
}

// The bowl has been empty long enough. Report what left it.
// Never returns false: a spoonful that was weighed is a bite even if nobody
// dipped the probes, and then it carries salinity 0 and says so.
static bool emitBite(float leftoverW, unsigned long now, Bite &out) {
  out = Bite{};
  out.biteId          = nextBiteId++;
  out.ms              = now;
  out.salinityMeasured = haveMeasurement;
  out.salinityMsCm    = haveMeasurement ? measSalinity : 0.0f;
  out.tempC           = haveMeasurement ? measTemp : NAN;
  out.dipSamples      = haveMeasurement ? measSamples : 0;
  out.tempSettled     = haveMeasurement && measTempSettled;
  out.heldStill       = loadedStill;
  out.pourTiltDeg     = pourTilt;
  out.loadedG         = loadedG;
  out.leftoverG       = fmaxf(leftoverW, 0.0f);
  out.weightG         = fmaxf(out.loadedG - out.leftoverG, 0.0f);
  estimateSodium(out);
  return true;
}

// ================= Public =================

// Average 0.5 s at rest: weight zero, "level", |gravity| and gyro offsets.
// Retries (up to 10x) if the spoon moved, since everything after depends on it.
void biteBegin() {
  float aSum[3], gSum[3];
  for (int attempt = 0; attempt < 10; attempt++) {
    float aMin = 1e9f, aMax = 0, gMin[3] = { 1e9f, 1e9f, 1e9f }, gMax[3] = { -1e9f, -1e9f, -1e9f };
    for (int k = 0; k < 3; k++) aSum[k] = gSum[k] = 0;

    for (int i = 0; i < LATCH_SAMPLES; i++) {
      sensorsUpdate();
      const SensorReadings &s = sensorsLatest();
      float a[3] = { s.ax, s.ay, s.az }, g[3] = { s.gx, s.gy, s.gz };
      for (int k = 0; k < 3; k++) {
        aSum[k] += a[k]; gSum[k] += g[k];
        gMin[k] = fminf(gMin[k], g[k]); gMax[k] = fmaxf(gMax[k], g[k]);
      }
      aMin = fminf(aMin, accelMag(s)); aMax = fmaxf(aMax, accelMag(s));
      delay(20);
    }

    float gSpread = fmaxf(gMax[0] - gMin[0], fmaxf(gMax[1] - gMin[1], gMax[2] - gMin[2]));
    if (aMax - aMin < 1.5f && gSpread < 0.5f) break;   // hand tremor is fine, real motion isn't
    Serial.println("[WARN] Spoon moved while zeroing, hold it level and still...");
  }

  const SensorReadings &r = sensorsLatest();
  zeroG = r.weightG;                                    // already a 0.5 s average
  haveMpu = r.mpuOk;
  if (haveMpu) {
    gravityRef = mag(aSum[0], aSum[1], aSum[2]) / LATCH_SAMPLES;
    float n = gravityRef * LATCH_SAMPLES;
    for (int k = 0; k < 3; k++) {
      level[k] = up[k] = aSum[k] / n;
      gyroBias[k] = gSum[k] / LATCH_SAMPLES;
    }
    Serial.printf("At rest: gravity %.2f m/s^2, gyro offset %.2f %.2f %.2f rad/s\n",
                  gravityRef, gyroBias[0], gyroBias[1], gyroBias[2]);
  } else {
    Serial.println("[WARN] No MPU-6050: no tilt correction, hold the spoon level.");
  }
  lastMs = tempRefAt = millis();
  tempRef = r.tempC;
  resetScoop();
  state = EMPTY;
}

bool biteUpdate(const SensorReadings &r, unsigned long now, Bite &out) {
  // Restart the temp settle timer whenever the temp moves (probe entering food)
  if (fabsf(r.tempC - tempRef) > TEMP_SETTLE_C) {
    tempRef = r.tempC;
    tempRefAt = now;
  }

  // The load cell is the one sensor a bite cannot be made without. A missing EC
  // probe costs the salinity, not the bite.
  if (!r.scaleOk) return false;
  updateTilt(r, now);
  float w = netWeight(r);

  // Watch the tipping every loop, not only where the weight is read. A pour
  // that starts the moment the probes lift happens inside WEIGHT_TRUST_MS, and
  // by the time the load cell is believed again the bowl is level once more -
  // the tip would be missed and a real bite refused. The peak is cleared below,
  // whenever the food is plainly still there.
  if (state == LOADED || state == MEASURED) pourTilt = fmaxf(pourTilt, tiltDeg());

  switch (state) {
    // ---------------- EMPTY ----------------
    // Nothing in the bowl. Follow the load cell's slow drift so tomorrow's zero
    // is still today's.
    case EMPTY:
      if (isStill(r) && fabsf(w) < MIN_SCOOP_G) zeroG += (r.weightG - zeroG) * 0.005f;
      if (w >= MIN_SCOOP_G) {
        resetScoop();
        loadedSince = now;
        weightWin.add(w);
        state = FILLING;
      }
      return false;

    // ---------------- FILLING ----------------
    // Food is going in. Do not believe any of it yet: pouring takes a moment and
    // the load cell's average is chasing it. Wait LOAD_SETTLE_MS, then latch.
    case FILLING:
      if (w < MIN_SCOOP_G) {                   // taken straight back out
        state = EMPTY;
        return false;
      }
      weightWin.add(w);
      if (now - loadedSince >= LOAD_SETTLE_MS && weightWin.full()) {
        latchWeight(r);
        Serial.printf("--- Loaded %.1f g%s. Dip the probes in to measure.\n",
                      loadedG, loadedStill ? "" : " (moving, so the range is wider)");
        state = LOADED;
      }
      return false;

    // ---------------- LOADED ----------------
    // Weight latched, waiting for the dip. Nothing here changes loadedG: more
    // food is a re-latch (below), less food is the bowl emptying (below).
    case LOADED:
      if (isWet(r)) {                          // probes going in
        dipWin.clear();
        lastDipSampleAt = now - DIP_SAMPLE_MS;
        drySince = 0;
        state = DIPPING;
        return false;
      }
      break;                                   // shared checks below

    // ---------------- DIPPING ----------------
    // The probes are resting in the food, so the load cell is reading them too.
    // Weight is frozen: nothing it does here ends a bite or moves loadedG.
    case DIPPING: {
      if (isWet(r) && now - lastDipSampleAt >= DIP_SAMPLE_MS) {
        dipWin.add(r.ecMsCm, r.tempC);
        lastDipSampleAt = now;
        drySince = 0;
      } else if (isDry(r)) {
        if (!drySince) drySince = now;
        if (now - drySince >= DRY_HOLD_MS) {   // probes are out: close the dip
          float dipTemp = dipWin.medianTemp();
          if (dipWin.total < MIN_DIP_SAMPLES) {
            Serial.printf("[WARN] Dip too short (%d of %d readings), not measured. "
                          "Hold the probes in longer.\n", dipWin.total, MIN_DIP_SAMPLES);
          } else if (!tempInRange(dipTemp)) {
            // THE interlock. Outside the probe's rated range the compensation
            // was never characterised, so this is not a worse reading, it is
            // not a reading. Drop it, and refuse to record the spoonful at all.
            Serial.printf("[DROP] %.1f C is outside the probe's %.0f-%.0f C range. "
                          "Dip discarded and this spoonful will not be recorded.\n",
                          dipTemp, PROBE_TEMP_MIN_C, PROBE_TEMP_MAX_C);
            outOfRange = true;
          } else {
            measSalinity    = dipWin.medianEc();
            measTemp        = dipTemp;
            measSamples     = dipWin.total;
            measTempSettled = tempSettled(now);
            haveMeasurement = true;
            Serial.printf("--- Measured %.2f mS/cm at %.1f C from %d reading(s). "
                          "Latched: taking the probes out will not change it.%s\n",
                          measSalinity, measTemp, measSamples,
                          measTempSettled ? "" : " [temp still climbing - dip longer next time]");
          }
          // The probes leaned on the spoon for the whole dip, so the weight
          // window is full of nonsense and the load cell's rolling average is
          // still flushing them out. Start over, and wait.
          weightWin.clear();
          emptySince = 0;
          weightTrustedAt = now + WEIGHT_TRUST_MS;
          state = haveMeasurement ? MEASURED : LOADED;
        }
      }
      return false;
    }

    // ---------------- MEASURED ----------------
    // Probes out, measurement latched, waiting for the food to go.
    case MEASURED:
      if (isWet(r)) {                          // dipped again: the newer dip wins
        dipWin.clear();
        lastDipSampleAt = now - DIP_SAMPLE_MS;
        drySince = 0;
        haveMeasurement = false;
        state = DIPPING;
        return false;
      }
      break;                                   // shared checks below
  }

  // ---- Shared checks, for LOADED and MEASURED ----
  if (now < weightTrustedAt) return false;     // load cell still flushing lifted probes
  weightWin.add(w);

  // More food went in, and stayed in: re-latch the scoop, keeping the dip.
  if (w > loadedG + TOPUP_G) {
    if (!heavySince) heavySince = now;
    if (now - heavySince >= TOPUP_HOLD_MS && weightWin.full()) {
      latchWeight(r);
      heavySince = 0;
      emptySince = 0;
      Serial.printf("--- More food: now %.1f g.\n", loadedG);
    }
    return false;
  }
  heavySince = 0;

  // The food is plainly still there. Any tipping before now was not a pour.
  if (w >= loadedG * EMPTY_FRACTION) {
    emptySince = 0;
    pourTilt = 0;
    return false;
  }

  // Wait for it to be gone: pouring a bowl out takes a moment, and half a pour
  // must not read as a bite.
  if (!emptySince) emptySince = now;
  if (now - emptySince < EMPTY_HOLD_MS) return false;

  bool ok = true;
  if (outOfRange) {                            // the interlock already refused this one
    Serial.println("--- Spoonful discarded (out of range), not recorded.");
    ok = false;
#if REQUIRE_POUR
  } else if (haveMpu && pourTilt < POUR_TILT_DEG) {
    // Weight left a bowl that stayed level. Something was lifted off it, not
    // poured out of it, so nothing was eaten. Without an MPU there is no
    // evidence either way and the drop is taken at face value.
    Serial.printf("--- Weight left but the bowl never tipped (%.0f deg, needs %.0f). "
                  "Lifted out, not poured: not a bite.\n", pourTilt, POUR_TILT_DEG);
    ok = false;
#endif
  } else {
    ok = emitBite(w, now, out);
  }
  resetScoop();
  state = EMPTY;
  return ok;
}

// One status line a second: enough to tune every threshold above from the bench.
void biteDebugPrint(const SensorReadings &r) {
  const SensorReadings &s = r;
  float w = netWeight(s);
  unsigned long now = millis();

  Serial.printf("[%s] weight %.1f g", STATE_NAMES[state], w);
  if (loadedG > 0) Serial.printf(" (loaded %.1f g, %.0f%%)", loadedG, 100.0f * w / loadedG);
  Serial.printf(" | EC %.0f mV %s", s.ecVoltageMv,
                isWet(s) ? "WET" : (isDry(s) ? "dry" : "--"));
  if (haveMeasurement) Serial.printf(" | latched %.2f mS/cm at %.1f C", measSalinity, measTemp);

  if (state == FILLING)  Serial.printf(" | settling %lu/%d ms", now - loadedSince, LOAD_SETTLE_MS);
  if (emptySince)        Serial.printf(" | emptying %lu/%d ms", now - emptySince, EMPTY_HOLD_MS);
  if (now < weightTrustedAt) Serial.printf(" | weight ignored for %lu ms", weightTrustedAt - now);
  if (!isLevel())        Serial.printf(" | tilted %.0f deg", tiltDeg());
  if (emptySince)        Serial.printf(" | tipped %.0f/%.0f deg", pourTilt, (float)POUR_TILT_DEG);
  Serial.println();
}
