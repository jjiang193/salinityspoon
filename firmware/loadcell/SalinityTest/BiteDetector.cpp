/*
 * BiteDetector.cpp - bite state machine. Rules and thresholds are in BiteDetector.h.
 *
 * EMPTY -> LOADED -> DIPPING -> MEASURED -> EMPTY(bite)
 *
 * The one rule that shapes everything below: the load cell is only believable
 * while the probe is out of the spoon. Weight is measured in LOADED, frozen
 * through DIPPING, and believed again in MEASURED.
 */
#include "BiteDetector.h"
#include <math.h>

enum State { EMPTY, LOADED, DIPPING, MEASURED };
static const char *STATE_NAMES[] = { "EMPTY", "LOADED", "DIPPING", "MEASURED" };
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
static unsigned long lastMs;               // time of the last tilt update

// ---------- Temperature settling ----------
static float         tempRef;              // temp when the settle timer last restarted
static unsigned long tempRefAt;

// ---------- The scoop (weighed while the probe is out) ----------
// Rolling window of the last SNAP_SAMPLES weights.
struct WeightWindow {
  float w[SNAP_SAMPLES];
  int idx, count;
  void clear() { idx = count = 0; }
  void add(float g) {
    w[idx] = g;
    idx = (idx + 1) % SNAP_SAMPLES;
    if (count < SNAP_SAMPLES) count++;
  }
  bool full() const { return count == SNAP_SAMPLES; }
  float avg() const { float s = 0; for (int i = 0; i < count; i++) s += w[i]; return s / count; }
  bool steady() const {                    // stayed within +/-5% of its own mean
    float lo = w[0], hi = w[0];
    for (int i = 1; i < count; i++) { lo = fminf(lo, w[i]); hi = fmaxf(hi, w[i]); }
    return hi - lo <= SCOOP_SPREAD_FRAC * avg();
  }
};
static WeightWindow scoopWin;
static float loadedG;                    // the scoop, latched. 0 = nothing weighed yet
static bool  loadedStill;                  // that weight came from a steady, still, level window
static float peakDryG;                     // heaviest reading seen with the probe out, this scoop
static unsigned long weightTrustedAt;      // before this, the load cell is still flushing the probe

// ---------- The dip (probe in the spoon) ----------
// Only the tail is kept: the probe arrives from room air and the EC reading is
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
static DipWindow    dipWin;
static unsigned long lastDipSampleAt;
static unsigned long drySince;             // when EC first fell below DRY_MV (0 = not)

// ---------- The measurement this scoop is carrying ----------
static float measSalinity, measTemp;
static int   measSamples;
static bool  measTempSettled;
static bool  haveMeasurement;
// The last dip of the session, for a spoonful eaten without one. Same bowl.
static float lastSalinity, lastTemp;
static bool  haveLastSalinity;

// ---------- Food leaving ----------
static unsigned long emptySince;           // when the weight fell below EMPTY_FRACTION (0 = not)
static unsigned long heavySince;           // when it rose above the scoop + TOPUP_G (0 = not)
static bool outOfRange;                    // this scoop failed the interlock: record nothing

// ================= Helpers =================

static float mag(float x, float y, float z) { return sqrtf(x * x + y * y + z * z); }
static float accelMag(const SensorReadings &r) { return mag(r.ax, r.ay, r.az); }
static float gyroMag(const SensorReadings &r) {
  return mag(r.gx - gyroBias[0], r.gy - gyroBias[1], r.gz - gyroBias[2]);
}

// Without an MPU there is no motion evidence either way. Treat the spoon as
// level and still, and let loadedStill carry the doubt into the sodium range.
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

// Weight minus zero, corrected for small tilts (load cell only feels gravity along its axis).
// Capped at LEVEL_MAX_DEG: the weight average lags a fast tilt, so more would over-read.
static float netWeight(const SensorReadings &r) {
  float t = fminf(tiltDeg(), LEVEL_MAX_DEG);
  return (r.weightG - zeroG) / cosf(t * PI / 180.0f);
}

// Track "up": rotate it with the gyro, then nudge it toward gravity from the accelerometer
// so it can't drift. Accel alone reads tilt wrong while the spoon accelerates.
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

// Weigh the food while the probe is out. Only a steady, still, level window is
// allowed to set the scoop weight; anything else leaves the last one standing.
static void weighScoop(const SensorReadings &r, float w) {
  if (isStill(r) && isLevel()) {
    scoopWin.add(w);
    if (scoopWin.full() && scoopWin.steady()) {
      loadedG = scoopWin.avg();
      loadedStill = haveMpu && r.mpuOk;
    }
  } else {
    scoopWin.clear();
  }
  // Nobody held it still: fall back to the heaviest reading seen with the probe
  // out. The load cell average climbs toward the true weight after a scoop, so
  // the first reading over 4 g is the start of that climb, not the food - and a
  // later lighter one means some food already left, which still counts when the
  // rest goes.
  peakDryG = fmaxf(peakDryG, w);
  if (!loadedStill && peakDryG >= MIN_SCOOP_G) {
    loadedG = peakDryG;
    loadedStill = false;
  }
}

// EC -> g/L NaCl through the shared quadratic curve -> sodium mg for the grams
// the load cell weighed. Dilution is applied after the conversion, never before.
static void estimateSodium(Bite &b) {
  float range = SODIUM_RANGE_FRAC + (b.heldStill ? 0 : SODIUM_RANGE_EXTRA)
                                  + (b.tempSettled ? 0 : SODIUM_RANGE_EXTRA)
                                  + (b.salinityCarried ? SODIUM_RANGE_CARRIED : 0);
  b.salinityGL   = salinity::applyDilution(
                     salinity::ecToGramsPerLitre(fmaxf(b.salinityMsCm, 0.0f)), DILUTION_FACTOR);
  b.sodiumMg     = salinity::sodiumMg(b.salinityGL, fmaxf(b.weightG, 0.0f));
  b.sodiumLowMg  = b.sodiumMg * (1.0f - range);
  b.sodiumHighMg = b.sodiumMg * (1.0f + range);
}

// Start a fresh scoop: everything about the last one is gone except the soup
// it was made of, which the next spoonful is still made of too.
static void resetScoop() {
  scoopWin.clear();
  dipWin.clear();
  loadedG = 0;
  peakDryG = 0;
  loadedStill = false;
  haveMeasurement = false;
  emptySince = 0;
  drySince = 0;
  heavySince = 0;
  outOfRange = false;
  weightTrustedAt = 0;
}

// The weight has fallen away and stayed down. Report what was eaten.
// Returns false only when there is no salinity to report it with.
static bool emitBite(float leftoverW, unsigned long now, Bite &out) {
  if (outOfRange) return false;            // the interlock already refused this scoop
  out = Bite{};
  out.salinityCarried = !haveMeasurement;
  if (haveMeasurement) {
    out.salinityMsCm = measSalinity;
    out.tempC        = measTemp;
    out.dipSamples   = measSamples;
    out.tempSettled  = measTempSettled;
  } else {
#if CARRY_SALINITY
    if (!haveLastSalinity) return false;
    out.salinityMsCm = lastSalinity;
    out.tempC        = lastTemp;
    out.dipSamples   = 0;
    out.tempSettled  = false;
#else
    return false;
#endif
  }

  out.biteId    = nextBiteId++;
  out.ms        = now;
  out.heldStill = loadedStill;
  out.loadedG   = loadedG;
  out.leftoverG = fmaxf(leftoverW, 0.0f);
  out.weightG   = fmaxf(out.loadedG - out.leftoverG, 0.0f);
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

    for (int i = 0; i < SNAP_SAMPLES; i++) {
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
    gravityRef = mag(aSum[0], aSum[1], aSum[2]) / SNAP_SAMPLES;
    float n = gravityRef * SNAP_SAMPLES;
    for (int k = 0; k < 3; k++) {
      level[k] = up[k] = aSum[k] / n;
      gyroBias[k] = gSum[k] / SNAP_SAMPLES;
    }
    Serial.printf("At rest: gravity %.2f m/s^2, gyro offset %.2f %.2f %.2f rad/s\n",
                  gravityRef, gyroBias[0], gyroBias[1], gyroBias[2]);
  } else {
    Serial.println("[WARN] No MPU-6050: no tilt correction, hold the spoon level.");
  }
  lastMs = tempRefAt = millis();
  tempRef = r.tempC;
  haveLastSalinity = false;
  resetScoop();
  state = EMPTY;
}

bool biteUpdate(const SensorReadings &r, unsigned long now, Bite &out) {
  // Restart the temp settle timer whenever the temp moves (probe entering food)
  if (fabsf(r.tempC - tempRef) > TEMP_SETTLE_C) {
    tempRef = r.tempC;
    tempRefAt = now;
  }

  // The load cell and the EC probe are the two signals a bite cannot be made
  // without. The MPU only grades it.
  if (!r.scaleOk || !r.adsOk) return false;
  updateTilt(r, now);
  float w = netWeight(r);

  switch (state) {
    // ---------------- EMPTY ----------------
    case EMPTY:
      if (isStill(r) && fabsf(w) < MIN_SCOOP_G) zeroG += (r.weightG - zeroG) * 0.005f;  // follow drift
      if (w >= MIN_SCOOP_G) {
        resetScoop();
        state = LOADED;
      }
      return false;

    // ---------------- LOADED ----------------
    // Food on the spoon, probe not in it yet. Weigh it, and wait for the dip.
    case LOADED:
      if (now < weightTrustedAt) return false;    // load cell still flushing a lifted probe
      weighScoop(r, w);

      if (isWet(r) && loadedG >= MIN_SCOOP_G) {   // probe going in: freeze the weight
        dipWin.clear();
        lastDipSampleAt = now - DIP_SAMPLE_MS;
        drySince = 0;
        state = DIPPING;
        return false;
      }
      if (w < MIN_SCOOP_G && loadedG <= 0.0f) {   // put down before anything was weighed
        state = EMPTY;
        return false;
      }
      break;                                       // shared weight-drop check below

    // ---------------- DIPPING ----------------
    // The probe is resting in the spoon, so the load cell is reading the probe
    // too. Weight is frozen: nothing it does here ends a bite or moves loadedG.
    case DIPPING: {
      if (isWet(r) && now - lastDipSampleAt >= DIP_SAMPLE_MS) {
        dipWin.add(r.ecMsCm, r.tempC);
        lastDipSampleAt = now;
        drySince = 0;
      } else if (isDry(r)) {
        if (!drySince) drySince = now;
        if (now - drySince >= DRY_HOLD_MS) {       // probe is out: close the dip
          float dipTemp = dipWin.medianTemp();
          if (!tempInRange(dipTemp) && dipWin.total >= MIN_DIP_SAMPLES) {
            // THE interlock. Outside the probe's rated range the compensation
            // was never characterised, so this is not a worse reading, it is
            // not a reading. Drop it, and refuse to record the spoonful at all
            // - carrying an earlier salinity onto food we know is out of range
            // would be the log-it-anyway path wearing a different hat.
            Serial.printf("[DROP] %.1f C is outside the probe's %.0f-%.0f C range. "
                          "Dip discarded and this spoonful will not be recorded.\n",
                          dipTemp, PROBE_TEMP_MIN_C, PROBE_TEMP_MAX_C);
            outOfRange = true;
          } else if (dipWin.total >= MIN_DIP_SAMPLES) {
            measSalinity     = dipWin.medianEc();
            measTemp         = dipTemp;
            measSamples      = dipWin.total;
            measTempSettled  = tempSettled(now);
            haveMeasurement  = true;
            lastSalinity     = measSalinity;
            lastTemp         = measTemp;
            haveLastSalinity = true;
            if (!measTempSettled)
              Serial.println("[WARN] Probe temperature still climbing when the dip ended. "
                             "The EC compensation is reading a temperature the food never had - "
                             "hold the probe in longer.");
          } else {
            Serial.printf("[WARN] Dip too short (%d of %d readings), not measured. Hold it in longer.\n",
                          dipWin.total, MIN_DIP_SAMPLES);
          }
          // The probe leaned on the spoon for the whole dip, so the weight
          // window is full of nonsense and the load cell's rolling average is
          // still flushing the probe out. Start over, and wait.
          scoopWin.clear();
          emptySince = 0;
          weightTrustedAt = now + WEIGHT_TRUST_MS;
          state = haveMeasurement ? MEASURED : LOADED;
        }
      }
      return false;
    }

    // ---------------- MEASURED ----------------
    // Probe out, measurement in hand, spoon on its way to the mouth.
    case MEASURED:
      if (isWet(r)) {                              // dipped again: the newer dip wins
        dipWin.clear();
        lastDipSampleAt = now - DIP_SAMPLE_MS;
        drySince = 0;
        haveMeasurement = false;
        state = DIPPING;
        return false;
      }
      if (now < weightTrustedAt) return false;    // load cell still flushing the lifted probe
      if (w > loadedG + TOPUP_G) {                 // more food went in - if it stays in
        if (!heavySince) heavySince = now;
        if (now - heavySince >= TOPUP_HOLD_MS) {   // measure the new scoop
          haveMeasurement = false;
          scoopWin.clear();
          emptySince = 0;
          state = LOADED;
        }
        return false;
      }
      heavySince = 0;
      // Keep refining the scoop weight while the food is plainly still there,
      // so a droplet carried off by the probe does not read as a bite.
      if (w >= 0.7f * loadedG) weighScoop(r, w);
      break;
  }

  // ---- Shared: has the food left? (LOADED and MEASURED) ----
  if (loadedG < MIN_SCOOP_G) return false;         // nothing was ever on it to leave
  if (w >= loadedG * EMPTY_FRACTION) {
    emptySince = 0;
    return false;
  }
  if (!emptySince) emptySince = now;
  if (now - emptySince < EMPTY_HOLD_MS) return false;   // ignore a lip knock or a fast tilt

  bool reported = emitBite(w, now, out);
  if (!reported && state == LOADED) {
    Serial.println("[WARN] Spoonful eaten without a dip and no earlier salinity to reuse. Not recorded.");
  }
  resetScoop();
  state = EMPTY;
  return reported;
}

void biteDebugPrint(const SensorReadings &r) {
  Serial.printf("  [%s] net %.1f g | tilt %.0f deg | still %s | probe %s (%.0f mV) | temp settled %s",
                STATE_NAMES[state], netWeight(r), tiltDeg(),
                isStill(r) ? "yes" : "no",
                isWet(r) ? "IN" : (isDry(r) ? "out" : "--"), r.ecVoltageMv,
                tempSettled(millis()) ? "yes" : "no");
  if (loadedG > 0) Serial.printf(" | loaded %.1f g%s", loadedG, loadedStill ? "" : " (moving)");
  if (state == DIPPING) Serial.printf(" | dip %d reading(s)", dipWin.total);
  if (haveMeasurement) Serial.printf(" | measured %.2f mS/cm at %.1f C", measSalinity, measTemp);
  Serial.println();
}
