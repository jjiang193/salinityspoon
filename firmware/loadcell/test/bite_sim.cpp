// bite_sim.cpp - runs the real ../SalinityTest/BiteDetector.cpp against simulated eating.
//   ./bite_sim             scripted cases + 400 randomized eating sessions
//   SEEDBASE=90000 ./bite_sim   same, on sessions never used for tuning (hold-out)
//   ./bite_sim x N         step-by-step trace of random session N
//
// The world this models is the new one: the temperature/conductivity probe is a
// separate thing that gets dipped INTO the spoon, not a sensor riding in the
// bowl. Two consequences drive most of what is below - while the probe is in the
// spoon it leans on it and the load cell reads several grams that are not food,
// and the probe arrives from room air, so its temperature (which the EC reading
// is compensated with) is still climbing for the first seconds of every dip.
//
// Models: hand tremor, MPU per-axis errors, HX711 0.5 s averaging lag, DS18B20
// lag, soup buoyancy (submerged spoon reads ~0 g), probe load, EC residue.
// Simulated, not measured.
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
  float mass = 0;          // g of food in the spoon
  bool  sub = false;       // spoon bowl under the soup surface (scooping)
  bool  probeIn = false;   // the probe is down in the spoon's food
  bool  wetted = false;    // probe has touched food (residue afterwards)
  float soupMv25 = 1640;   // EC probe mV in this soup at 25 C (1640 = 10 mS/cm)
  float soupC = 45;        // soup temperature
  float probeG = 5;        // grams the probe leans on the spoon with while dipped
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
// The spoon goes under the soup and comes up with `massAfter` grams.
static void submerge(float d, float massAfter) {
  set([](W &w) { w.sub = true; });
  rest(d);
  set([=](W &w) { w.sub = false; w.mass = massAfter; });
}
// The probe is lowered into the spoon, held for `d` seconds, and lifted out.
// It presses on the spoon the whole time, by a hand-dependent amount.
static void dip(float d, float probeG = 5) {
  set([=](W &w) { w.probeIn = true; w.wetted = true; w.probeG = probeG; });
  rest(d);
  set([](W &w) { w.probeIn = false; });
  rest(0.2f);                                    // probe clear of the spoon
}

// ---------------- sensor model ----------------
static W worldAt(float t) {
  W w; float start = 0;
  for (auto &p : P) {
    if (t < start + p.dur) { p.f((t - start) / p.dur, w); break; }
    p.f(1, w); start += p.dur;
  }
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

// The probe is a small metal thing entering food from room air. TAU_IN is the
// number that decides whether a one-second dip can be believed: it cannot.
static const float TAU_IN = 3.0f, TAU_AIR = 40.0f, AMBIENT_C = 22.0f;

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

  // DS18B20 on the probe: only sees the food while the probe is down in it.
  bool inFood = w.probeIn && w.mass > 3;    // electrodes covered by >3 g of food
  probeC += ((inFood ? w.soupC : AMBIENT_C) - probeC) * dt / (inFood ? TAU_IN : TAU_AIR);
  if (g_now - lastT >= 750) { R.tempC = roundf(probeC * 16) / 16; lastT = g_now; }

  if (g_now - lastEc >= 100) {   // hot liquid conducts more; firmware compensates with probe temp
    float mv25 = inFood ? w.soupMv25 : (w.wetted ? 120 : 3);
    float mv = mv25 * (1 + 0.0185f * ((inFood ? w.soupC : 25) - 25));
    R.ecVoltageMv = mv + noise(1);
    R.ecMsCm = R.ecVoltageMv / 164.0f / (1 + 0.0185f * (R.tempC - 25));
    lastEc = g_now;
  }
  if (g_now - lastW >= 100) {    // HX711 10 Hz, 5-sample average; submerged: food floats, bowl -1.5 g
    float g = w.sub ? -1.5f
                    : w.mass * cosf(th) * (1 + aUp / 9.81f) + w.extra + (w.probeIn ? w.probeG : 0);
    wbuf[wi] = g + noise(0.3f); wi = (wi + 1) % 5; if (wn < 5) wn++;
    float s = 0; for (int i = 0; i < wn; i++) s += wbuf[i];
    R.weightG = s / wn; lastW = g_now;
  }
}
const SensorReadings &sensorsLatest() { return R; }
void delay(unsigned long ms) { g_now += ms; }

// ---------------- runner ----------------
struct Detected { float t, g, sal; bool still, settled, carried; };
static bool g_verbose = false;
static std::vector<Detected> runSession(float startC, std::string *trace = nullptr) {
  g_now = 0; sensorsResetSim(startC);
  for (int i = 0; i < 35; i++) { sensorsUpdate(); g_now += 20; }
  nextBiteId = 1; state = EMPTY; biteBegin();
  std::vector<Detected> out; int last = -1;
  unsigned long end = (unsigned long)(endTime() * 1000) + 500;
  while (g_now < end) {
    g_now += 20; sensorsUpdate();
    Bite b;
    if (biteUpdate(sensorsLatest(), g_now, b))
      out.push_back({g_now / 1000.0f, b.weightG, b.salinityMsCm, b.heldStill, b.tempSettled, b.salinityCarried});
    if (g_verbose && g_now % 100 == 0) {
      const SensorReadings &q = sensorsLatest(); W w = worldAt(g_now / 1000.0f);
      printf("t=%5.1f %-8s wTrue=%5.1f sub=%d probeIn=%d | w=%5.1f loaded=%5.1f tilt=%3.0f still=%d "
             "ec=%5.2f mv=%6.0f probeC=%4.1f dip=%d meas=%d\n",
             g_now / 1000.0f, STATE_NAMES[state], w.mass, w.sub, w.probeIn, netWeight(q), loadedG,
             tiltDeg(), isStill(q), q.ecMsCm, q.ecVoltageMv, q.tempC, dipWin.total, (int)haveMeasurement);
    }
    if (trace && state != last) { char s[32]; snprintf(s, 32, "%s@%.1f ", STATE_NAMES[state], g_now / 1000.0f); *trace += s; last = state; }
  }
  return out;
}

static void scripted(const char *name, const char *expect, float startC = AMBIENT_C) {
  rng.seed(42);
  std::string tr;
  auto d = runSession(startC, &tr);
  float tot = 0; for (auto &x : d) tot += x.g;
  printf("%-64s | expect %-16s | got %d bite(s) %5.1f g", name, expect, (int)d.size(), tot);
  for (auto &x : d)
    printf(" [%.1fg %.2fmS%s%s%s]", x.g, x.sal, x.still ? "" : " moving",
           x.settled ? "" : " temp-lag", x.carried ? " CARRIED" : "");
  printf("\n");
}

// Building blocks for scripted cases
static void simScoop(float m, float soupC = 30) { move(0.8f, -0.20f, -15); set([=](W &w) { w.soupC = soupC; }); submerge(1.0f, m); move(0.5f, 0.10f, 0); }
static void lift(float T = 0.8f, float dh = 0.30f, float tilt = 30) { move(T, dh, tilt); }
static void lower(float dh = 0.30f) { move(0.8f, -dh, 0); }

// ---------------- randomized sessions ----------------
// Every action ends in a bite except KNOCK - a falling weight is a bite now, so
// tipping food back into the bowl is one too. That is the design, not a bug: it
// is recorded here so a change that quietly brings back "where did the food go"
// shows up as a failure.
enum Act { NORMAL, LONG_DIP, NO_DIP, SHORT_DIP, REDIP, TOPUP, PUTBACK, PARTIAL, KNOCK, N_ACT };
static const char *ACT_NAMES[] = {
  "scoop, dip ~1 s, eat", "scoop, dip 6-12 s, eat", "scoop and eat, never dipped",
  "dip too briefly to count, eat", "dip, look again, dip, eat", "dip, add more food, dip again, eat",
  "dip, then tip it back in the bowl", "dip, eat half, lower, eat the rest",
  "knock the table with a dipped spoonful, then eat" };
struct Expect { Act a; float t0, t1, grams; int minB, maxB; };

static float cursor() { return endTime(); }
static void rScoop(float m) {
  float d = U(0.10f, 0.25f);
  move(U(0.5f, 1.2f), -d, -U(5, 25)); submerge(U(0.4f, 1.5f), m); move(U(0.3f, 0.8f), d * U(0.3f, 0.6f), U(-5, 5));
}
static void rPause() { if (U(0, 1) > 0.3f) rest(U(0.3f, 2.0f)); }            // 30%: no pause at all
static void rDip(float lo = 0.8f, float hi = 2.5f) { dip(U(lo, hi), U(2, 10)); }
static float rLift() { float h = U(0.15f, 0.40f); move(U(0.5f, 1.8f), h, U(10, 60)); return h; }
static void rLower(float h) { rest(U(0, 0.5f)); move(U(0.5f, 1.2f), -h, U(-5, 5)); }

static Expect addAction(Act a) {
  Expect e{a, cursor(), 0, 0, 1, 1};
  float m = U(5, 20), left = m * U(0, 0.1f);
  switch (a) {
    case NORMAL:    rScoop(m); rPause(); rDip(); { float h = rLift(); eat(U(0.6f, 1.5f), left); rLower(h); } e.grams = m - left; break;
    case LONG_DIP:  rScoop(m); rPause(); rDip(6, 12); { float h = rLift(); eat(U(0.6f, 1.5f), left); rLower(h); } e.grams = m - left; break;
    case NO_DIP:    rScoop(m); rPause(); { float h = rLift(); eat(U(0.6f, 1.5f), left); rLower(h); } e.grams = m - left;
                    e.minB = 0; break;   // 0 if nothing has been dipped yet this session
    case SHORT_DIP: rScoop(m); rPause(); dip(U(0.05f, 0.25f), U(2, 10));
                    { float h = rLift(); eat(U(0.6f, 1.5f), left); rLower(h); } e.grams = m - left;
                    e.minB = 0; break;   // falls back to the last dip, or nothing
    case REDIP:     rScoop(m); rPause(); rDip(); rest(U(0.3f, 1.5f)); rDip();
                    { float h = rLift(); eat(U(0.6f, 1.5f), left); rLower(h); } e.grams = m - left; break;
    case TOPUP: {   rScoop(m); rPause(); rDip(); float d = U(0.1f, 0.2f);
                    move(U(0.5f, 1.0f), -d, -U(5, 25)); float m2 = m + U(4, 12); left = m2 * U(0, 0.1f);
                    submerge(U(0.5f, 1.5f), m2); move(U(0.3f, 0.8f), d * 0.5f, U(-5, 5));
                    rPause(); rDip(); float h = rLift(); eat(U(0.6f, 1.5f), left); rLower(h);
                    // Dunking a measured spoonful back in the bowl IS a falling
                    // weight, so it closes a bite and the re-scoop opens another.
                    // The food is counted twice. This is the one place the new
                    // rule costs something real; `overcount` below prices it.
                    e.grams = m2 - left; e.maxB = 2; break; }
    case PUTBACK:   rScoop(m); rPause(); rDip(); pour(U(0.4f, 1.0f), U(80, 120));
                    move(U(0.4f, 0.8f), 0, U(-5, 5)); e.grams = m; break;
    case PARTIAL: { rScoop(m); rPause(); rDip(); float h = rLift(); eat(U(0.6f, 1.2f), m * U(0.4f, 0.6f)); rLower(h);
                    rest(U(0.5f, 2.0f)); h = rLift(); eat(U(0.6f, 1.2f), left); rLower(h);
                    e.grams = m - left; e.maxB = 2; break; }
    case KNOCK: {   rScoop(m); rPause(); rDip(); rest(U(0.3f, 1.0f)); knock(); rest(U(0.5f, 1.5f));
                    float h = rLift(); eat(U(0.6f, 1.5f), left); rLower(h); e.grams = m - left; break; }
    default: break;
  }
  rest(U(1.0f, 2.0f));
  e.t1 = cursor();
  return e;
}

static int g_traceSession = -1;
static void randomized(int sessions) {
  int ok[N_ACT] = {}, n[N_ACT] = {}, missed = 0, realBites = 0, moving = 0, total = 0;
  int carried = 0, tempLag = 0;
  float overcountG = 0, trueG = 0;
  std::vector<float> gErr, sErr, sErrSettled;
  std::discrete_distribution<int> pick({30, 10, 10, 10, 10, 10, 8, 10, 10});
  int shown = 0;
  for (int s = (g_traceSession >= 0 ? g_traceSession : 0); s < (g_traceSession >= 0 ? g_traceSession + 1 : sessions); s++) {
    rng.seed((getenv("SEEDBASE") ? atoi(getenv("SEEDBASE")) : 1000) + s);
    P.clear(); tremorA = U(0.00005f, 0.0002f); simGyroBias = U(-0.3f, 0.3f);
    sclY = U(0.97f, 1.03f); sclZ = U(0.97f, 1.03f); offX = U(-0.2f, 0.2f); offY = U(-0.2f, 0.2f); offZ = U(-0.2f, 0.2f);
    float soupMv = U(300, 3000), soupC = U(5, 38);   // in the probe's 0-40 C range
    set([=](W &w) { w.soupMv25 = soupMv; w.soupC = soupC; });
    rest(2.0f);
    std::vector<Expect> ex;
    int k = 4 + (int)U(0, 3);
    for (int i = 0; i < k; i++) ex.push_back(addAction((Act)pick(rng)));
    auto det = runSession(AMBIENT_C);
    for (auto &e : ex) {
      int c = 0; float g = 0;
      for (auto &d : det) if (d.t >= e.t0 && d.t < e.t1) {
        c++; g += d.g; total++;
        if (!d.still) moving++;
        if (d.carried) carried++;
        if (!d.settled) tempLag++;
        float err = fabsf(d.sal - soupMv / 164.0f) / (soupMv / 164.0f);
        sErr.push_back(err);
        if (d.settled && !d.carried) sErrSettled.push_back(err);
      }
      if (g > e.grams) overcountG += g - e.grams;
      trueG += e.grams;
      bool countOk = c >= e.minB && c <= e.maxB;
      bool gramsOk = e.maxB == 0 || c == 0 || e.a == TOPUP ||
                     fabsf(g - e.grams) <= fmaxf(1.5f, 0.2f * e.grams);
      n[e.a]++; if (countOk && gramsOk) ok[e.a]++;
      else if (shown < 25 || g_traceSession >= 0) { shown++; printf("  FAIL session %d t=%.1f-%.1f %-42s expect %d-%d bites %.1f g, got %d bites %.1f g\n", s, e.t0, e.t1, ACT_NAMES[e.a], e.minB, e.maxB, e.grams, c, g); }
      if (e.minB > 0) { realBites++; if (c == 0) missed++; else gErr.push_back(fabsf(g - e.grams) / e.grams); }
    }
  }
  auto pct = [](std::vector<float> v, float q) { if (v.empty()) return 0.0f; std::sort(v.begin(), v.end()); return v[(size_t)(q * (v.size() - 1))] * 100; };
  printf("\n%-46s  %s\n", "Action (random speeds/heights/tilts/pauses/dips)", "correct");
  for (int a = 0; a < N_ACT; a++) printf("  %-44s  %3d/%-3d (%3.0f%%)\n", ACT_NAMES[a], ok[a], n[a], n[a] ? 100.0f * ok[a] / n[a] : 0.0f);
  printf("  bites missed: %d/%d | weighed while moving: %d/%d | salinity carried from an earlier dip: %d/%d"
         " | temp still climbing at dip end: %d/%d\n",
         missed, realBites, moving, total, carried, total, tempLag, total);
  printf("  eaten-grams error: median %.0f%%, 95th pct %.0f%%\n", pct(gErr, 0.5f), pct(gErr, 0.95f));
  printf("  grams counted beyond what was eaten: %.0f of %.0f (%.1f%%)   <- the price of \"a falling weight is a bite\"\n",
         overcountG, trueG, trueG > 0 ? 100.0f * overcountG / trueG : 0.0f);
  printf("  salinity error, all bites:        median %5.1f%%, 95th pct %5.1f%%\n", pct(sErr, 0.5f), pct(sErr, 0.95f));
  printf("  salinity error, temp settled only: median %5.1f%%, 95th pct %5.1f%%   <- what a long enough dip buys\n",
         pct(sErrSettled, 0.5f), pct(sErrSettled, 0.95f));
}

// ---------------- the interlock ----------------
// Food outside the probe's 0-40 C range must never be recorded. The catch is
// that the probe arrives from room air, so for the first seconds of a dip it has
// not reached the food and honestly reads in-range: the interlock is only as
// good as the dip is long. This puts a number on that hole.
static void interlock(int sessions) {
  printf("\n---- interlock: soup at 45-70 C, which must never be recorded ----\n");
  for (int pass = 0; pass < 2; pass++) {
    float lo = pass ? 6.0f : 0.8f, hi = pass ? 12.0f : 1.5f;
    int spoonfuls = 0, recorded = 0;
    for (int i = 0; i < sessions; i++) {
      rng.seed(7000 + i);
      P.clear(); tremorA = U(0.00005f, 0.0002f); simGyroBias = U(-0.3f, 0.3f);
      float soupC = U(45, 70);
      set([=](W &w) { w.soupMv25 = 1640; w.soupC = soupC; });
      rest(2.0f);
      for (int a = 0; a < 4; a++, spoonfuls++) {
        float m = U(5, 20), left = m * U(0, 0.1f);
        rScoop(m); rPause(); dip(U(lo, hi), U(2, 10));
        float h = rLift(); eat(U(0.6f, 1.5f), left); rLower(h); rest(U(1.0f, 2.0f));
      }
      recorded += (int)runSession(AMBIENT_C).size();
    }
    printf("  dip %4.1f-%4.1f s: %3d of %3d dropped, %3d slipped through (%.0f%%)%s\n",
           lo, hi, spoonfuls - recorded, spoonfuls, recorded, 100.0f * recorded / spoonfuls,
           pass ? "" : "   <- the probe had not reached the food yet");
  }
}

int main(int argc, char **argv) {
  if (argc > 2) { g_verbose = true; g_traceSession = atoi(argv[2]); randomized(1); return 0; }
  printf("---- scripted cases ----\n");
  P.clear(); rest(2); simScoop(12); rest(1); dip(1.0f); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S1 scoop, hold 1 s, dip 1 s, eat", "1, ~11.5 g");
  P.clear(); rest(2); simScoop(12); rest(1); dip(10.0f); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S2 same, but a 10 s dip (temp settles)", "1, 10.00 mS");
  P.clear(); rest(2); simScoop(12); rest(1); dip(1.0f, 30); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S3 probe leaning hard (30 g) on the spoon", "1, ~11.5 g");
  P.clear(); rest(2); simScoop(12); rest(1); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S4 never dipped, nothing measured yet", "0");
  P.clear(); rest(2); simScoop(12); rest(1); dip(10.0f); lift(); eat(1, 0.5f); lower(); rest(2);
  simScoop(10); rest(1); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S5 dip once, then a second spoonful with no dip", "2, 2nd CARRIED");
  P.clear(); rest(2); simScoop(12); rest(1); dip(0.15f); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S6 dip too briefly to count, nothing earlier", "0");
  P.clear(); rest(2); simScoop(12); rest(1); dip(1.0f); rest(0.5f); dip(1.5f); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S7 dip, look again, dip again, eat", "1, ~11.5 g");
  P.clear(); rest(2); simScoop(12); rest(1); dip(1.0f); move(0.8f, -0.2f, -15); submerge(1.5f, 20);
  move(0.5f, 0.1f, 0); rest(1); dip(1.0f); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S8 dip, top up to 20 g, dip again, eat", "1, ~19.5 g");
  P.clear(); rest(2); simScoop(12); rest(1); dip(1.0f); pour(0.6f, 100); move(0.6f, 0, 0); rest(2);
  scripted("S9 tip it back into the bowl (now a bite, by design)", "1, ~12 g");
  P.clear(); rest(2); simScoop(12); rest(1); dip(1.0f); knock(); rest(3); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S10 knock the table, then eat", "1, ~11.5 g");
  P.clear(); rest(2); simScoop(12); rest(1); dip(1.0f); lift(); eat(1, 6); lower(); rest(2); lift(); eat(1, 0.3f); lower(); rest(2);
  scripted("S11 eat half, lower, eat the rest", "~11.7 g total");
  P.clear(); rest(2); simScoop(12); dip(1.0f); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S12 one smooth motion, no pause before the dip", "1, ~11.5 g");

  P.clear(); rest(2); simScoop(12, 60); rest(1); dip(12.0f); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S13 60 C soup, 12 s dip: interlock drops it", "0");
  P.clear(); rest(2); simScoop(12, 60); rest(1); dip(1.0f); lift(); eat(1, 0.5f); lower(); rest(2);
  scripted("S14 60 C soup, 1 s dip: probe still cold, slips through", "1 (the hole)");

  printf("\n---- randomized: 400 eating sessions (%s) ----", "4-6 actions each");
  randomized(400);
  interlock(100);
}
