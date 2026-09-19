/*
 * BiteDetector.cpp - bite state machine. Rules and thresholds are in BiteDetector.h.
 */
#include "BiteDetector.h"
#include <math.h>

enum State { EMPTY, LOADED };
static const char *STATE_NAMES[] = { "EMPTY", "LOADED" };
static State    state = EMPTY;
static uint32_t nextBiteId = 1;

// ---------- Calibration (set by biteBegin) ----------
static float zeroG;                        // load cell zero, follows slow drift while empty
static float level[3];                     // "up" in sensor axes when level (unit vector)
static float gravityRef = 9.81f;           // |accel| at rest (this MPU reads ~10.9)
static float gyroBias[3];                  // gyro reading at rest
static bool  haveMpu;

// ---------- Tilt tracking ----------
static float up[3];                        // "up" now (unit vector)
static unsigned long lastMs;               // time of the last tilt update

// ---------- Temperature settling ----------
static float         tempRef;              // temp when the settle timer last restarted
static unsigned long tempRefAt;

// ---------- The scoop ----------
// Rolling window of the last SNAP_SAMPLES readings (EC, temp, weight).
struct Window {
  float ec[SNAP_SAMPLES], temp[SNAP_SAMPLES], w[SNAP_SAMPLES];
  int idx, count;
  void clear() { idx = count = 0; }
  void add(float e, float t, float g) {
    ec[idx] = e; temp[idx] = t; w[idx] = g;
    idx = (idx + 1) % SNAP_SAMPLES;
    if (count < SNAP_SAMPLES) count++;
  }
  float avgW() const { float s = 0; for (int i = 0; i < count; i++) s += w[i]; return s / count; }
  bool steady() const {                    // weight stayed within +/-5%
    float lo = w[0], hi = w[0];
    for (int i = 1; i < count; i++) { lo = fminf(lo, w[i]); hi = fmaxf(hi, w[i]); }
    return hi - lo <= 0.1f * avgW();
  }
  void fill(Bite &b) const {               // window averages -> salinity, temp, loaded weight
    float se = 0, st = 0;
    for (int i = 0; i < count; i++) { se += ec[i]; st += temp[i]; }
    b.salinityMsCm = se / count; b.tempC = st / count; b.loadedG = avgW();
  }
};
static Window stillWin;                    // held level + still (best measurement)
static Window moveWin;                     // any time level (fallback if never still)
static Bite   stillSnap;                   // best still measurement of this scoop
static bool   haveStillSnap;
static float  peakLoadedG;                 // heaviest still measurement of this scoop

// ---------- Food leaving the spoon ----------
static unsigned long emptySince;           // when the weight fell below EMPTY_FRACTION (0 = not)
static bool leaving, poured, immersed;

// ================= Helpers =================

static float mag(float x, float y, float z) { return sqrtf(x * x + y * y + z * z); }
static float accelMag(const SensorReadings &r) { return mag(r.ax, r.ay, r.az); }
static float gyroMag(const SensorReadings &r) {
  return mag(r.gx - gyroBias[0], r.gy - gyroBias[1], r.gz - gyroBias[2]);
}

static bool isStill(const SensorReadings &r) {
  return gyroMag(r) < STILL_GYRO_RAD_S && fabsf(accelMag(r) - gravityRef) < STILL_ACCEL_DEV;
}
static bool isWet(const SensorReadings &r) { return r.adsOk && r.ecVoltageMv > WET_MV; }
static bool tempSettled(unsigned long now) { return now - tempRefAt >= TEMP_SETTLE_MS; }

// Angle between "up" now and "up" when level.
static float tiltDeg() {
  float c = up[0] * level[0] + up[1] * level[1] + up[2] * level[2];
  return acosf(constrain(c, -1.0f, 1.0f)) * 180.0f / PI;
}

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

// Measure the scoop while nothing is leaving it.
static void trackLoad(const SensorReadings &r, float w, unsigned long now) {
  if (!isWet(r)) return;

  // Best: 0.5 s level, still and steady. Can refine or raise the measurement, never lower
  // it (lighter = some food already eaten, which still counts when the rest goes).
  if (isStill(r) && tiltDeg() <= LEVEL_MAX_DEG) {
    stillWin.add(r.ecMsCm, r.tempC, w);
    if (stillWin.count == SNAP_SAMPLES && stillWin.steady()) {
      Bite s;
      stillWin.fill(s);
      if (!haveStillSnap || s.loadedG >= peakLoadedG * 0.85f) {
        stillSnap = s;
        stillSnap.tempSettled = tempSettled(now);
        haveStillSnap = true;
        peakLoadedG = fmaxf(peakLoadedG, s.loadedG);
      }
    }
  } else {
    stillWin.clear();
  }

  // Fallback: any level reading, skipping ones far below average (inertia while moving)
  if (w >= MIN_SCOOP_G && tiltDeg() <= LEVEL_MAX_DEG &&
      (moveWin.count == 0 || w >= 0.6f * moveWin.avgW())) {
    moveWin.add(r.ecMsCm, r.tempC, w);
  }
}

static bool hasScoop() { return haveStillSnap || moveWin.count > 0; }

// Best measurement of the scoop so far.
static Bite scoop(unsigned long now) {
  Bite b = {};
  if (haveStillSnap) {
    b = stillSnap;
    b.heldStill = true;
  } else if (moveWin.count > 0) {
    moveWin.fill(b);
    b.heldStill = false;
    b.tempSettled = tempSettled(now);
  }
  return b;
}

// sodium mg = salinity x salt mg per g per mS/cm x grams x sodium share of salt
static void estimateSodium(Bite &b) {
  float range = SODIUM_RANGE_FRAC + (b.heldStill ? 0 : SODIUM_RANGE_EXTRA)
                                  + (b.tempSettled ? 0 : SODIUM_RANGE_EXTRA);
  b.sodiumMg     = fmaxf(b.salinityMsCm, 0.0f) * NACL_MG_PER_G_PER_MS * fmaxf(b.weightG, 0.0f) * SODIUM_PER_NACL;
  b.sodiumLowMg  = b.sodiumMg * (1.0f - range);
  b.sodiumHighMg = b.sodiumMg * (1.0f + range);
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
    Serial.println("[WARN] No MPU-6050, bites can't be confirmed.");
  }
  lastMs = tempRefAt = millis();
  tempRef = r.tempC;
  state = EMPTY;
}

bool biteUpdate(const SensorReadings &r, unsigned long now, Bite &out) {
  // Restart the temp settle timer whenever the temp moves (e.g. probe into hotter soup)
  if (fabsf(r.tempC - tempRef) > TEMP_SETTLE_C) {
    tempRef = r.tempC;
    tempRefAt = now;
  }

  if (!r.scaleOk || !r.adsOk || !r.mpuOk || !haveMpu) return false;   // need all three signals
  updateTilt(r, now);
  float w = netWeight(r);

  if (state == EMPTY) {
    if (isStill(r) && fabsf(w) < MIN_SCOOP_G) zeroG += (r.weightG - zeroG) * 0.005f;   // follow drift
    if (w >= MIN_SCOOP_G && isWet(r)) {                // food scooped: start a new scoop
      state = LOADED;
      stillWin.clear();
      moveWin.clear();
      haveStillSnap = false;
      peakLoadedG = 0;
      emptySince = 0;
      leaving = poured = false;
    }
    return false;
  }

  // ----- LOADED -----
  if (!leaving) trackLoad(r, w, now);                 // keep measuring while the spoon is full
  if (!hasScoop()) {                                   // not measured yet (e.g. probe not wet yet)
    if (w < MIN_SCOOP_G) state = EMPTY;
    return false;
  }
  Bite s = scoop(now);

  leaving = w < s.loadedG * DROP_START_FRACTION;
  poured  = leaving && (poured || tiltDeg() > POUR_TILT_DEG);

  if (w >= s.loadedG * EMPTY_FRACTION) {               // food still on the spoon
    emptySince = 0;
    return false;
  }

  // Food is (almost) gone. Watch the probe from the first low reading, so a quick dip
  // that's over before the hold ends still counts as immersed.
  if (!emptySince) { emptySince = now; immersed = false; }
  if (r.ecMsCm >= s.salinityMsCm * IMMERSED_FRACTION) immersed = true;
  if (now - emptySince < EMPTY_HOLD_MS) return false;

  state = EMPTY;
  if (immersed || poured) return false;               // back into the soup / poured out

  out = s;                                             // eaten: report the bite
  out.biteId    = nextBiteId++;
  out.ms        = now;
  out.leftoverG = fmaxf(w, 0.0f);
  out.weightG   = fmaxf(out.loadedG - out.leftoverG, 0.0f);
  estimateSodium(out);
  return true;
}

void biteDebugPrint(const SensorReadings &r) {
  Serial.printf("  [%s] net %.1f g | tilt %.0f deg | still %s | wet %s | temp settled %s",
                STATE_NAMES[state], netWeight(r), tiltDeg(),
                isStill(r) ? "yes" : "no", isWet(r) ? "yes" : "no",
                tempSettled(millis()) ? "yes" : "no");
  if (state == LOADED && hasScoop()) {
    Bite s = scoop(millis());
    Serial.printf(" | loaded %.1f g %.2f mS/cm%s | EC now %.0f%% of loaded",
                  s.loadedG, s.salinityMsCm, s.heldStill ? "" : " (moving)",
                  s.salinityMsCm > 0 ? 100.0f * r.ecMsCm / s.salinityMsCm : 0.0f);
  }
  Serial.println();
}
