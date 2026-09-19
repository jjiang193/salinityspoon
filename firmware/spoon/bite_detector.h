#pragma once
#include <Arduino.h>
#include <math.h>
#include "config.h"
#include "salinity.h"

// ---------------------------------------------------------------------------
// Bite detection.
//
// A real scoop is ~0.5 s in the liquid. Sampling EC at 100 Hz gives ~50 samples
// in that window - more statistical evidence than a slow 2-second settle ever
// had, in a tenth of the time. Faster sampling buys both speed and confidence.
//
//   IDLE -> WETTING -> CAPTURE -> CONFIRM -> LOG -> IDLE
//                          |
//                          +-> ABORT -> IDLE
// ---------------------------------------------------------------------------

enum BiteState { BS_IDLE, BS_WETTING, BS_CAPTURE, BS_CONFIRM, BS_LOG, BS_ABORT };

struct BiteResult {
  bool  valid = false;
  float ec25 = 0.0f;
  float tempC = 0.0f;
  float quality = 0.0f;
  int   sampleCount = 0;
  const char* abortReason = nullptr;
};

class BiteDetector {
 public:
  void reset() { enter(BS_IDLE); _count = 0; }

  BiteState state() const { return _state; }

  const char* stateName() const {
    switch (_state) {
      case BS_WETTING: return "WETTING";
      case BS_CAPTURE: return "CAPTURE";
      case BS_CONFIRM: return "CONFIRM";
      case BS_LOG:     return "LOG";
      case BS_ABORT:   return "ABORT";
      default:         return "IDLE";
    }
  }

  // Call at the EC sample rate. Returns a valid BiteResult on the tick a bite
  // completes.
  BiteResult update(float ec25, float tempC, float gyroMag) {
    BiteResult out;
    bool submerged = ec25 > EC_SUBMERGED_FLOOR_MS;
    uint32_t inState = millis() - _stateSince;

    switch (_state) {
      case BS_IDLE:
        if (submerged) enter(BS_WETTING);
        break;

      case BS_WETTING:
        // The first samples after immersion lie - the electrode surface is
        // still forming its film. Throw them away rather than average them in.
        if (!submerged)            enter(BS_IDLE);
        else if (inState >= WETTING_MS) { _count = 0; enter(BS_CAPTURE); }
        break;

      case BS_CAPTURE:
        if (!submerged) {
          if (inState >= CAPTURE_MIN_MS) enter(BS_CONFIRM);
          else                           out = abort("left liquid too early");
        } else if (inState > CAPTURE_MAX_MS) {
          // A long immersion is a soak, not a scoop - and the datasheet says
          // not to soak this probe.
          out = abort("soak, not a scoop");
        } else if (_count < MAX_EC_SAMPLES) {
          _buf[_count++] = ec25;
        }
        break;

      case BS_CONFIRM:
        // Require BOTH the EC drop and an IMU lift. EC alone could be the probe
        // breaking the surface mid-stir; a lift alone could be repositioning.
        if (gyroMag > GYRO_LIFT_THRESHOLD)      out = finish(tempC);
        else if (inState > CONFIRM_TIMEOUT_MS)  out = abort("no lift confirmed");
        else if (submerged)                     enter(BS_CAPTURE);  // dipped again
        break;

      default:
        enter(BS_IDLE);
        break;
    }
    return out;
  }

 private:
  void enter(BiteState s) { _state = s; _stateSince = millis(); }

  BiteResult abort(const char* why) {
    BiteResult r;
    r.abortReason = why;
    _count = 0;
    enter(BS_IDLE);
    return r;
  }

  BiteResult finish(float tempC) {
    BiteResult r;
    r.tempC = tempC;
    r.sampleCount = _count;

    // The interlock, enforced before anything else. Out of range means no bite,
    // not a flagged bite.
    if (!salinity::tempInRange(tempC)) return abort("temperature out of probe range");
    if (_count < MIN_EC_SAMPLES)       return abort("too few EC samples");

    float med    = median();
    float spread = robustSpread();
    if (spread > EC_STABILITY_MAX_SPREAD) return abort("EC unstable");

    // 0..1 trust score. Stability is the only live term by this point -
    // submersion and settling are already guaranteed by reaching CONFIRM.
    float stability = 1.0f - constrain((spread - 0.05f) / 0.45f, 0.0f, 1.0f);
    float q = 0.5f + 0.5f * stability;
    if (ECOverRange(med)) q *= 0.3f;
    if (q < QUALITY_THRESHOLD) return abort("quality below threshold");

    r.valid = true;
    r.ec25 = med;
    r.quality = q;
    _count = 0;
    enter(BS_IDLE);
    return r;
  }

  static bool ECOverRange(float ec) { return ec >= PROBE_EC_MAX_MS_CM * 0.95f; }

  // Insertion sort in place - N is small and bounded, so nothing fancier pays.
  static void sortInPlace(float* a, int n) {
    for (int i = 1; i < n; i++) {
      float key = a[i];
      int j = i - 1;
      while (j >= 0 && a[j] > key) { a[j + 1] = a[j]; j--; }
      a[j + 1] = key;
    }
  }

  // Median, not mean: one bubble against the electrode must not move a sodium
  // figure.
  float median() {
    if (!_count) return 0.0f;
    memcpy(_scratch, _buf, sizeof(float) * _count);
    sortInPlace(_scratch, _count);
    return _scratch[_count / 2];
  }

  // Median absolute deviation, scaled to be comparable with a standard
  // deviation on normally distributed data.
  //
  // A standard deviation would defeat the median sitting right above it: one
  // bubble among fifty good samples pushes it from ~0 to ~1.5 mS/cm, aborting
  // a bite whose median was exactly right. MAD ignores that outlier and still
  // catches a genuinely unstable signal.
  float robustSpread() {
    if (_count < 3) return INFINITY;
    float med = median();
    for (int i = 0; i < _count; i++) _scratch[i] = fabsf(_buf[i] - med);
    sortInPlace(_scratch, _count);
    return _scratch[_count / 2] * 1.4826f;
  }

  BiteState _state = BS_IDLE;
  uint32_t  _stateSince = 0;
  float     _buf[MAX_EC_SAMPLES];
  float     _scratch[MAX_EC_SAMPLES];
  int       _count = 0;
};
