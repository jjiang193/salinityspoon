// Minimal Arduino stand-in so BiteDetector.cpp compiles on the Mac for simulation.
#pragma once
#include <cstdio>
#include <cstdint>
#include <cmath>

extern unsigned long g_now;
inline unsigned long millis() { return g_now; }
void delay(unsigned long ms);

#ifndef PI
#define PI 3.14159265358979f
#endif
template <class T, class L, class H> T constrain(T x, L lo, H hi) { return x < lo ? lo : (x > hi ? hi : x); }

struct SerialStub {
  bool verbose = false;
  template <class... A> void printf(const char *f, A... a) { if (verbose) ::printf(f, a...); }
  void println(const char *s = "") { if (verbose) ::printf("%s\n", s); }
};
extern SerialStub Serial;
