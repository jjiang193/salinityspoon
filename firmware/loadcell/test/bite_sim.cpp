// bite_sim.cpp - runs the real ../SalinityTest/BiteDetector.cpp against simulated eating.
//   ./bite_sim             12 scripted cases + 400 randomized eating sessions
//   SEEDBASE=90000 ./bite_sim   same, on sessions never used for tuning (hold-out)
//   ./bite_sim x N         step-by-step trace of random session N
// Models: hand tremor, MPU per-axis errors, HX711 0.5 s averaging lag, DS18B20 lag,
// soup buoyancy (submerged spoon reads ~0 g), EC residue. Simulated, not measured.
#include "Arduino.h"
#include "Sensors.h"
#include "BiteDetector.cpp"   // same translation unit so we can read `state`
#include <functional>
#include <vector>
#include <string>
#include <random>
#include <algorithm>
#include <cstdlib>

unsigned long g_now = 0;
SerialStub Serial;
static std::mt19937 rng;
static float U(float a, float b) { return std::uniform_real_distribution<float>(a, b)(rng); }
static float noise(float sd) { return std::normal_distribution<float>(0, sd)(rng); }

// ---------------- world model ----------------
struct W {
  float tilt = 0;          // deg, + = tipped toward mouth, - = tipped forward to scoop
  float h = 0;             // m
  float mass = 0;          // g of food in the bowl
  bool  sub = false;       // bowl under the soup surface
  bool  wetted = false;    // probe has touched food (residue afterwards)
  float soupMv25 = 1640;   // EC probe mV in this soup at 25 C (1640 = 10 mS/cm)
  float soupC = 45;        // soup temperature
  float extra = 0;         // lip pressure / knock on the load cell (g)
  float bump = 0;          // knock acceleration (m/s^2), zero net velocity
};
struct Phase { float dur; std::function<void(float, W &)> f; };
static std::vector<Phase> P;
static float tremorA = 0.0001f;

static float smooth(float u) { return u - sinf(2 * PI * u) / (2 * PI); }
static void rest(float d) { P.push_back({d, [](float, W &) {}}); }
static void set(std::function<void(W &)> g) { P.push_back({0, [g](float, W &w) { g(w); }}); }
static void move(float d, float dh, float tiltTo) {
  P.push_back({d, [=](float u, W &w) { float h0 = w.h, t0 = w.tilt;
    w.h = h0 + dh * smooth(u); w.tilt = t0 + (tiltTo - t0) * smooth(u); }});
}
static void pour(float d, float tiltTo) {
  P.push_back({d, [=](float u, W &w) { float t0 = w.tilt, m0 = w.mass;
    w.tilt = t0 + (tiltTo - t0) * smooth(u); w.mass = u < 0.5f ? m0 : m0 * (1 - (u - 0.5f) * 2); }});
}
static void eat(float d, float leftover) {
  P.push_back({d, [=](float u, W &w) { float m0 = w.mass, s = u * d;
    w.mass = s < 0.3f ? m0 + (leftover - m0) * s / 0.3f : leftover;
    w.extra = (s > 0.05f && s < 0.35f) ? 3.0f : 0; }});
  set([](W &w) { w.extra = 0; });
}
static void knock() {
  P.push_back({0.06f, [](float u, W &w) { w.bump = u < 0.5f ? 6 : -6; w.extra = 4; }});
  set([](W &w) { w.bump = 0; w.extra = 0; });
}
static void submerge(float d, float massAfter) {
  set([](W &w) { w.sub = true; w.wetted = true; });
  rest(d);
  set([=](W &w) { w.sub = false; w.mass = massAfter; });
}

// ---------------- sensor model ----------------
static W worldAt(float t) {
  W w; float start = 0; bool done = false;
  for (auto &p : P) {
    if (t < start + p.dur) { p.f((t - start) / p.dur, w); done = true; break; }
    p.f(1, w); start += p.dur;
  }
  (void)done;
  w.h += tremorA * sinf(2 * PI * 8 * t) + 0.004f * sinf(2 * PI * 0.4f * t);
  w.tilt += 1.0f * sinf(2 * PI * 0.7f * t);
  return w;
}
static float endTime() { float s = 0; for (auto &p : P) s += p.dur; return s; }

static const float G_MPU = 10.88f;          // this MPU reads 10.88 at rest
static float simGyroBias = -0.25f;
static float sclX = 1.0f, sclY = 1.02f, sclZ = 0.99f, offX = 0.1f, offY = -0.1f, offZ = 0.05f;   // MPU per-axis errors
static SensorReadings R;
static float wbuf[5]; static int wi, wn; static unsigned long lastW, lastEc, lastT;
static float probeC;

static void sensorsResetSim(float startC) {
  R = {}; wi = wn = 0; lastW = lastEc = lastT = 0; probeC = startC;
  R.tempC = startC; R.tempOk = R.adsOk = R.mpuOk = R.scaleOk = true;
}
void sensorsUpdate() {
  float t = g_now / 1000.0f, dt = 0.02f;
  W w = worldAt(t), wa = worldAt(t - dt), wb = worldAt(t + dt);
  float aUp = (wb.h - 2 * w.h + wa.h) / (dt * dt) + w.bump;
  float th = w.tilt * PI / 180, dth = (wb.tilt - wa.tilt) / (2 * dt) * PI / 180;
  float f = G_MPU * (1 + aUp / 9.81f);
  R.ax = offX + noise(0.05f); R.ay = sclY * f * sinf(th) + offY + noise(0.05f); R.az = sclZ * f * cosf(th) + offZ + noise(0.05f);
  R.gx = simGyroBias + dth + noise(0.02f); R.gy = -0.01f + noise(0.02f); R.gz = noise(0.02f);

  // DS18B20 on the spoon: tracks food in ~6 s, cools in air over ~60 s, 750 ms updates
  bool inFood = w.sub || w.mass > 3;   // electrodes covered by >3 g of food (assumed probe height)
  probeC += ((inFood ? w.soupC : 22.0f) - probeC) * dt / (inFood ? 6.0f : 60.0f);
  if (g_now - lastT >= 750) { R.tempC = roundf(probeC * 16) / 16; lastT = g_now; }

  if (g_now - lastEc >= 100) {   // hot liquid conducts more; firmware compensates with probe temp
    float mv25 = inFood ? w.soupMv25 : (w.wetted ? 120 : 3);
    float mv = mv25 * (1 + 0.0185f * ((inFood ? w.soupC : 25) - 25));
    R.ecVoltageMv = mv + noise(1);
    R.ecMsCm = R.ecVoltageMv / 164.0f / (1 + 0.0185f * (R.tempC - 25));
    lastEc = g_now;
  }
  if (g_now - lastW >= 100) {    // HX711 10 Hz, 5-sample average; submerged: food floats, bowl -1.5 g
    float g = w.sub ? -1.5f : w.mass * cosf(th) * (1 + aUp / 9.81f) + w.extra;
    wbuf[wi] = g + noise(0.3f); wi = (wi + 1) % 5; if (wn < 5) wn++;
    float s = 0; for (int i = 0; i < wn; i++) s += wbuf[i];
    R.weightG = s / wn; lastW = g_now;
  }
}
const SensorReadings &sensorsLatest() { return R; }
void delay(unsigned long ms) { g_now += ms; }

// ---------------- runner ----------------
struct Detected { float t, g, sal; bool still; };
static bool g_verbose=false;
static std::vector<Detected> runSession(float startC, std::string *trace = nullptr) {
  g_now = 0; sensorsResetSim(startC);
  for (int i = 0; i < 35; i++) { sensorsUpdate(); g_now += 20; }
  nextBiteId = 1; state = EMPTY; biteBegin();
  std::vector<Detected> out; int last = -1;
  unsigned long end = (unsigned long)(endTime() * 1000) + 500;
  while (g_now < end) {
    g_now += 20; sensorsUpdate();
    Bite b;
    if (biteUpdate(sensorsLatest(), g_now, b)) {
      bool still = true;
#ifdef NEWDET
      still = b.heldStill;
#endif
      out.push_back({g_now / 1000.0f, b.weightG, b.salinityMsCm, still});
    }
#ifdef NEWDET
    if (g_verbose && g_now % 100 == 0) { const SensorReadings &q = sensorsLatest(); W w = worldAt(g_now/1000.0f);
      printf("t=%4.1f %-6s wTrue=%5.1f sub=%d tiltTrue=%4.0f | w=%5.1f tilt=%3.0f still=%d |a|-g=%+.2f gyro=%.2f ec=%5.2f leaving=%d\n",
        g_now/1000.0f, STATE_NAMES[state], w.mass, w.sub, w.tilt, netWeight(q), tiltDeg(), isStill(q), accelMag(q)-gravityRef, gyroMag(q), q.ecMsCm, (int)leaving); }
#endif
    if (trace && state != last) { char s[32]; snprintf(s, 32, "%s@%.1f ", STATE_NAMES[state], g_now / 1000.0f); *trace += s; last = state; }
  }
  return out;
}

static void scripted(const char *name, const char *expect, float startC = 45) {
  rng.seed(42);
  std::string tr;
  auto d = runSession(startC, &tr);
  float tot = 0; for (auto &x : d) tot += x.g;
  printf("%-62s | expect %-14s | got %d bite(s) %5.1f g", name, expect, (int)d.size(), tot);
  for (auto &x : d) printf(" [%.1fg %.2fmS%s]", x.g, x.sal, x.still ? "" : " moving");
  printf("\n");
}

// Building blocks for scripted cases
static void simScoop(float m, float soupC = 45) { move(0.8f, -0.20f, -15); set([=](W &w) { w.soupC = soupC; }); submerge(1.0f, m); move(0.5f, 0.10f, 0); }
static void lift(float T = 0.8f, float dh = 0.30f, float tilt = 30) { move(T, dh, tilt); }
static void lower(float dh = 0.30f) { move(0.8f, -dh, 0); }

// ---------------- randomized sessions ----------------
enum Act { NORMAL, DIP_LOADED, ABORT, POUR, HESITATE, PARTIAL, KNOCK, N_ACT };
static const char *ACT_NAMES[] = { "normal bite", "full spoon dipped back, re-scoop, eat",
  "lift, then put it back in the soup", "tip food back out", "hesitate (up, down a bit, up), eat",
  "eat half, lower, eat the rest", "knock the table, then eat" };
struct Expect { Act a; float t0, t1, grams; int minB, maxB; };

static float cursor() { return endTime(); }
static void rScoop(float m) {
  float d = U(0.10f, 0.25f);
  move(U(0.5f, 1.2f), -d, -U(5, 25)); submerge(U(0.4f, 1.5f), m); move(U(0.3f, 0.8f), d * U(0.3f, 0.6f), U(-5, 5));
}
static void rPause() { if (U(0, 1) > 0.3f) rest(U(0.3f, 2.0f)); }            // 30%: no pause at all
static float rLift() { float h = U(0.15f, 0.40f); move(U(0.5f, 1.8f), h, U(10, 60)); return h; }
static void rLower(float h) { rest(U(0, 0.5f)); move(U(0.5f, 1.2f), -h, U(-5, 5)); }

static Expect addAction(Act a) {
  Expect e{a, cursor(), 0, 0, 1, 1};
  float m = U(5, 20), left = m * U(0, 0.1f);
  switch (a) {
    case NORMAL:   rScoop(m); rPause(); { float h = rLift(); eat(U(0.6f, 1.5f), left); rLower(h); } e.grams = m - left; break;
    case DIP_LOADED: { rScoop(m); rest(U(0.3f, 1.5f)); float d = U(0.1f, 0.2f);
      move(U(0.5f, 1.0f), -d, -U(5, 25)); float m2 = U(5, 20); left = m2 * U(0, 0.1f);
      submerge(U(0.5f, 1.5f), m2); move(U(0.3f, 0.8f), d * 0.5f, U(-5, 5)); rPause();
      float h = rLift(); eat(U(0.6f, 1.5f), left); rLower(h); e.grams = m2 - left; break; }
    case ABORT: { rScoop(m); rPause(); float h = rLift(); rest(U(0.5f, 2.0f));
      move(U(0.5f, 1.2f), -(h + 0.05f), -U(5, 25)); submerge(U(0.5f, 1.5f), 0); move(0.5f, 0.05f, 0);
      e.minB = e.maxB = 0; break; }
    case POUR: rScoop(m); rPause(); pour(U(0.4f, 1.0f), U(80, 120)); move(U(0.4f, 0.8f), 0, U(-5, 5)); e.minB = e.maxB = 0; break;
    case HESITATE: { rScoop(m); rPause(); float h1 = U(0.08f, 0.2f); move(U(0.4f, 1.0f), h1, U(0, 15));
      rest(U(0.3f, 2.5f)); float d = U(0.03f, 0.08f); move(U(0.3f, 0.6f), -d, U(0, 10)); rest(U(0.2f, 1.0f));
      float h2 = U(0.1f, 0.25f); move(U(0.4f, 1.2f), h2, U(10, 60)); eat(U(0.6f, 1.5f), left);
      rLower(h1 - d + h2); e.grams = m - left; break; }
    case PARTIAL: { rScoop(m); rPause(); float h = rLift(); eat(U(0.6f, 1.2f), m * U(0.4f, 0.6f)); rLower(h);
      rest(U(0.5f, 2.0f)); h = rLift(); eat(U(0.6f, 1.2f), left); rLower(h); e.grams = m - left; e.maxB = 2; break; }
    case KNOCK: { rScoop(m); rest(U(0.5f, 1.5f)); knock(); rest(U(0.5f, 1.5f)); float h = rLift();
      eat(U(0.6f, 1.5f), left); rLower(h); e.grams = m - left; break; }
    default: break;
  }
  rest(U(1.0f, 2.0f));
  set([](W &w) { w.wetted = true; });
  e.t1 = cursor();
  return e;
}

static int g_traceSession = -1;
static void randomized(int sessions) {
  int ok[N_ACT] = {}, n[N_ACT] = {}, falseB = 0, missed = 0, realBites = 0, moving = 0, total = 0;
  std::vector<float> gErr, sErr;
  std::discrete_distribution<int> pick({30, 12, 12, 10, 12, 12, 12});
  int shown = 0;
  for (int s = (g_traceSession >= 0 ? g_traceSession : 0); s < (g_traceSession >= 0 ? g_traceSession + 1 : sessions); s++) {
    rng.seed((getenv("SEEDBASE") ? atoi(getenv("SEEDBASE")) : 1000) + s);
    P.clear(); tremorA = U(0.00005f, 0.0002f); simGyroBias = U(-0.3f, 0.3f);
    sclY = U(0.97f, 1.03f); sclZ = U(0.97f, 1.03f); offX = U(-0.2f, 0.2f); offY = U(-0.2f, 0.2f); offZ = U(-0.2f, 0.2f);
    float soupMv = U(300, 3000), soupC = U(30, 70);
    set([=](W &w) { w.soupMv25 = soupMv; w.soupC = soupC; });
    rest(2.0f);
    std::vector<Expect> ex;
    int k = 4 + (int)U(0, 3);
    for (int i = 0; i < k; i++) ex.push_back(addAction((Act)pick(rng)));
    auto det = runSession(U(22, soupC));
    for (auto &e : ex) {
      int c = 0; float g = 0;
      for (auto &d : det) if (d.t >= e.t0 && d.t < e.t1) {
        c++; g += d.g; total++; if (!d.still) moving++;
        sErr.push_back(fabsf(d.sal - soupMv / 164.0f) / (soupMv / 164.0f));
      }
      bool countOk = c >= e.minB && c <= e.maxB;
      bool gramsOk = e.maxB == 0 || fabsf(g - e.grams) <= fmaxf(1.5f, 0.2f * e.grams);
      n[e.a]++; if (countOk && gramsOk) ok[e.a]++;
      else if (shown < 25 || g_traceSession >= 0) { shown++; printf("  FAIL session %d t=%.1f-%.1f %-38s expect %d-%d bites %.1f g, got %d bites %.1f g\n", s, e.t0, e.t1, ACT_NAMES[e.a], e.minB, e.maxB, e.grams, c, g); }
      if (e.maxB > 0) { realBites++; if (c == 0) missed++; else gErr.push_back(fabsf(g - e.grams) / e.grams); }
      else falseB += c;
    }
  }
  auto pct = [](std::vector<float> v, float q) { if (v.empty()) return 0.0f; std::sort(v.begin(), v.end()); return v[(size_t)(q * (v.size() - 1))] * 100; };
  printf("\n%-42s  %s\n", "Action (random speeds/heights/tilts/pauses)", "correct");
  for (int a = 0; a < N_ACT; a++) printf("  %-40s  %3d/%-3d (%3.0f%%)\n", ACT_NAMES[a], ok[a], n[a], 100.0f * ok[a] / n[a]);
  printf("  real bites missed: %d/%d | false bites: %d | bites weighed while moving: %d/%d\n", missed, realBites, falseB, moving, total);
  printf("  eaten-grams error: median %.0f%%, 95th pct %.0f%% | salinity error: median %.1f%%, 95th pct %.1f%%\n",
         pct(gErr, 0.5f), pct(gErr, 0.95f), pct(sErr, 0.5f), pct(sErr, 0.95f));
}

int main(int argc, char **argv) {
  if (argc > 2) { g_verbose = true; g_traceSession = atoi(argv[2]); randomized(1); return 0; }
  if (argc > 1) { g_verbose = true; rng.seed(42); P.clear(); rest(2); simScoop(12); rest(1); move(0.8f, -0.2f, -15); submerge(1.5f, 14); move(0.5f, 0.1f, 0); rest(1); lift(); eat(1, 0.5f); lower(); rest(2); runSession(45); return 0; }
  printf("---- scripted cases ----\n");
  P.clear(); rest(2); simScoop(12); rest(1); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S1 normal: scoop, hold 1 s, lift, eat", "1, ~11.5 g");
  P.clear(); rest(2); simScoop(12); rest(1); move(0.8f, -0.2f, -15); submerge(1.5f, 14); move(0.5f, 0.1f, 0); rest(1); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S2 YOUR CASE: full spoon back in soup, re-scoop, eat", "1, ~13.5 g");
  P.clear(); rest(2); simScoop(12); rest(1); move(0.8f, -0.2f, -15); submerge(1.5f, 14); move(0.5f, 0.1f, 0); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S2b same, straight from re-scoop to mouth", "1, ~13.5 g");
  P.clear(); rest(2); simScoop(12); rest(1); lift(); rest(2); move(0.8f, -0.3f, -15); submerge(1.5f, 12); move(0.5f, 0.1f, 0); rest(2);
  scripted("S3 lift, change mind, back in the soup", "0");
  P.clear(); rest(2); simScoop(12); rest(1); pour(0.6f, 100); move(0.6f, 0, 0); rest(2);
  scripted("S4 tip the food back into the bowl", "0");
  P.clear(); rest(2); simScoop(12); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S5 one smooth motion, scoop straight to mouth", "1, ~11.5 g");
  P.clear(); rest(2); simScoop(12); rest(1); knock(); rest(3);
  scripted("S6 knock the table while holding a full spoon", "0");
  P.clear(); rest(2); simScoop(12); rest(1); lift(); eat(1, 6); lower(); rest(2); lift(); eat(1, 0.3f); lower(); rest(2);
  scripted("S7 eat half, lower, eat the rest", "~11.7 g total");
  P.clear(); rest(2); simScoop(12); rest(1); lift(1.6f, 0.2f, 15); eat(1, 0.5f); lower(0.2f); rest(2);
  scripted("S8 slow, gentle lift (15 deg)", "1, ~11.5 g");
  P.clear(); set([](W &w) { w.soupC = 40; }); rest(2); simScoop(12, 60); rest(3); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S9 temp probe from 40 C to 60 C soup, hold 3 s", "1, 10.00 mS", 40);
  P.clear(); set([](W &w) { w.soupC = 40; }); rest(2); simScoop(12, 60); rest(12); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S9b same, hold 12 s", "1, 10.00 mS", 40);
  P.clear(); rest(2); simScoop(12); rest(1); lift(); eat(1, 0.5f); lower(); rest(1); simScoop(10); rest(1); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S10 two normal bites in a row", "2, 11.5+9.5 g");

  printf("\n---- randomized: 400 eating sessions (%s) ----", "4-6 actions each");
  randomized(400);
}
