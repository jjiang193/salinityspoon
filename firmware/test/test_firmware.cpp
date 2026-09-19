// Host-side tests for the firmware's logic headers.
//
//   make -C firmware/test
//
// Covers the salinity model and the bite-detection state machine. Does not
// cover WiFi, I2C or the sketch itself - those need real hardware.

#include "arduino_shim.h"

uint32_t g_fake_millis = 0;

#include "../spoon/config.h"
#include "../spoon/salinity.h"
#include "../spoon/bite_detector.h"

#include <cstdio>
#include <cmath>
#include <string>

static int g_failures = 0;
static int g_checks = 0;

static void check(bool ok, const std::string& what) {
  g_checks++;
  if (!ok) { g_failures++; printf("  FAIL  %s\n", what.c_str()); }
}

static void check_near(float got, float want, float tol, const std::string& what) {
  g_checks++;
  if (std::fabs(got - want) > tol) {
    g_failures++;
    printf("  FAIL  %s: got %.4f, want %.4f (+/-%.4f)\n",
           what.c_str(), got, want, tol);
  }
}

// --- Salinity ----------------------------------------------------------------
static void test_salinity() {
  printf("salinity\n");

  check_near(salinity::ecToGramsPerLitre(0.0f), 0.0f, 1e-6, "zero EC -> zero");
  check(salinity::ecToGramsPerLitre(-5.0f) == 0.0f, "negative EC clamps to zero");

  // The two reference points the default coefficients were fitted to.
  check_near(salinity::ecToGramsPerLitre(2.0f), 1.0f, 0.02f, "2 mS/cm -> 1 g/L");
  check_near(salinity::ecToGramsPerLitre(17.5f), 10.0f, 0.05f, "17.5 mS/cm -> 10 g/L");

  // Monotonic across the working range.
  float prev = -1.0f;
  for (float ec = 0.0f; ec <= 20.0f; ec += 0.25f) {
    float g = salinity::ecToGramsPerLitre(ec);
    check(g >= prev, "curve is monotonic");
    prev = g;
  }

  // Dilution must be applied AFTER conversion. Converting a 1:1 diluted 10 g/L
  // sample and then doubling must recover 10 g/L; doubling the EC first does
  // not, because the curve is quadratic.
  float true_g = 10.0f;
  float diluted_g = true_g / 2.0f;
  // Invert the quadratic to find the EC that a 5 g/L solution would read.
  float a = SALINITY_COEFF_B, b = SALINITY_COEFF_A, c = -diluted_g;
  float ec_diluted = (-b + sqrtf(b * b - 4 * a * c)) / (2 * a);

  float right = salinity::applyDilution(salinity::ecToGramsPerLitre(ec_diluted), 2.0f);
  float wrong = salinity::ecToGramsPerLitre(ec_diluted * 2.0f);
  check_near(right, true_g, 0.05f, "convert-then-scale recovers the true value");
  check(wrong > true_g * 1.05f, "scale-then-convert overshoots, as documented");

  // Sodium: 1 g NaCl is 393.4 mg sodium.
  check_near(salinity::sodiumMg(10.0f, 10.0f), 39.34f, 0.01f, "10 g/L x 10 mL");
  check_near(salinity::sodiumMg(0.0f, 10.0f), 0.0f, 1e-6, "no salt, no sodium");

  // The interlock, at its boundaries.
  check(salinity::tempInRange(0.0f),   "0 C is in range");
  check(salinity::tempInRange(40.0f),  "40 C is in range");
  check(salinity::tempInRange(22.5f),  "22.5 C is in range");
  check(!salinity::tempInRange(40.1f), "40.1 C is out of range");
  check(!salinity::tempInRange(-0.1f), "-0.1 C is out of range");
  check(!salinity::tempInRange(55.0f), "55 C is out of range");
  check(!salinity::tempInRange(NAN),   "NaN is out of range");
}

// --- Bite detection ----------------------------------------------------------
namespace {

// EC that a nominal 0.6% liquid reads.
constexpr float EC_IN_LIQUID = 11.4f;
constexpr float EC_IN_AIR = 0.02f;
constexpr float GYRO_STILL = 0.02f;
constexpr float GYRO_LIFT = 2.5f;

// Drive one full scoop. Returns the bite, valid or aborted.
BiteResult run_scoop(BiteDetector& d, float tempC, float captureMs,
                     float ecNoise = 0.0f, bool confirmLift = true) {
  BiteResult last;

  // Submerge, then hold through wetting.
  for (uint32_t t = 0; t < WETTING_MS + 20; t += 10) {
    d.update(EC_IN_LIQUID, tempC, GYRO_STILL);
    advance_ms(10);
  }

  // Capture at the firmware's EC rate.
  const uint32_t step = 1000 / EC_SAMPLE_HZ;
  int i = 0;
  for (uint32_t t = 0; t < captureMs; t += step) {
    float ec = EC_IN_LIQUID + (i++ % 2 ? ecNoise : -ecNoise);
    d.update(ec, tempC, GYRO_STILL);
    advance_ms(step);
  }

  // Leave the liquid, then the lift that confirms it.
  last = d.update(EC_IN_AIR, tempC, GYRO_STILL);
  advance_ms(step);
  if (last.valid || last.abortReason) return last;

  for (int n = 0; n < 40; n++) {
    last = d.update(EC_IN_AIR, tempC, confirmLift ? GYRO_LIFT : GYRO_STILL);
    advance_ms(step);
    if (last.valid || last.abortReason) return last;
  }
  return last;
}

}  // namespace

static void test_bite_detection() {
  printf("bite detection\n");

  {
    BiteDetector d;
    reset_clock();
    d.reset();
    check(d.state() == BS_IDLE, "starts idle");

    BiteResult r = run_scoop(d, 24.0f, 500);
    check(r.valid, "a normal 500 ms scoop produces a bite");
    check_near(r.ec25, EC_IN_LIQUID, 0.01f, "reports the captured EC");
    check(r.sampleCount >= MIN_EC_SAMPLES, "captured enough samples");
    check(r.quality >= QUALITY_THRESHOLD, "quality clears the threshold");
    check(d.state() == BS_IDLE, "returns to idle after logging");
  }

  {
    // The interlock: too hot means no bite, not a flagged bite.
    BiteDetector d;
    reset_clock();
    d.reset();
    BiteResult r = run_scoop(d, 55.0f, 500);
    check(!r.valid, "55 C produces no bite");
    check(r.abortReason != nullptr, "and says why");
  }

  {
    BiteDetector d;
    reset_clock();
    d.reset();
    BiteResult r = run_scoop(d, -3.0f, 500);
    check(!r.valid, "-3 C produces no bite");
  }

  {
    // Too brief to gather evidence.
    BiteDetector d;
    reset_clock();
    d.reset();
    BiteResult r = run_scoop(d, 24.0f, 60);
    check(!r.valid, "a 60 ms dip produces no bite");
  }

  {
    // Unstable EC must abort rather than average through the noise.
    BiteDetector d;
    reset_clock();
    d.reset();
    BiteResult r = run_scoop(d, 24.0f, 500, 3.0f);
    check(!r.valid, "wildly unstable EC produces no bite");
  }

  {
    // No lift means no confirmation.
    BiteDetector d;
    reset_clock();
    d.reset();
    BiteResult r = run_scoop(d, 24.0f, 500, 0.0f, false);
    check(!r.valid, "no IMU lift means no bite");
  }

  {
    // A soak is not a scoop - the datasheet says not to soak this probe, and
    // stale samples must never become a measurement. What matters is that the
    // capture aborts and that no bite appears while the probe is still down.
    BiteDetector d;
    reset_clock();
    d.reset();
    for (uint32_t t = 0; t < WETTING_MS + 20; t += 10) {
      d.update(EC_IN_LIQUID, 24.0f, GYRO_STILL);
      advance_ms(10);
    }
    const uint32_t step = 1000 / EC_SAMPLE_HZ;
    bool aborted = false, phantom = false;
    for (uint32_t t = 0; t < CAPTURE_MAX_MS + 2000; t += step) {
      BiteResult r = d.update(EC_IN_LIQUID, 24.0f, GYRO_STILL);
      if (r.abortReason) aborted = true;
      if (r.valid) phantom = true;
      advance_ms(step);
    }
    check(aborted, "a long soak aborts the stale capture");
    check(!phantom, "a soak never produces a bite while still submerged");
  }

  {
    // Median must reject an outlier, which is the whole reason it is a median.
    BiteDetector d;
    reset_clock();
    d.reset();
    for (uint32_t t = 0; t < WETTING_MS + 20; t += 10) {
      d.update(EC_IN_LIQUID, 24.0f, GYRO_STILL);
      advance_ms(10);
    }
    const uint32_t step = 1000 / EC_SAMPLE_HZ;
    for (int i = 0; i < 50; i++) {
      // One bubble: a single wild sample among fifty good ones.
      float ec = (i == 25) ? 0.4f : EC_IN_LIQUID;
      d.update(ec, 24.0f, GYRO_STILL);
      advance_ms(step);
    }
    BiteResult r = d.update(EC_IN_AIR, 24.0f, GYRO_STILL);
    advance_ms(step);
    for (int n = 0; n < 40 && !r.valid && !r.abortReason; n++) {
      r = d.update(EC_IN_AIR, 24.0f, GYRO_LIFT);
      advance_ms(step);
    }
    check(r.valid, "one outlier among fifty still yields a bite");
    if (r.valid) {
      check_near(r.ec25, EC_IN_LIQUID, 0.01f, "the outlier does not move the median");
    }
  }

  {
    // Two scoops in a row must both register.
    BiteDetector d;
    reset_clock();
    d.reset();
    BiteResult a = run_scoop(d, 24.0f, 500);
    advance_ms(3000);
    BiteResult b = run_scoop(d, 24.0f, 500);
    check(a.valid && b.valid, "consecutive scoops both produce bites");
  }
}

int main() {
  printf("firmware logic tests\n\n");
  test_salinity();
  test_bite_detection();
  printf("\n%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
