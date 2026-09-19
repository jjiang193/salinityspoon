// Minimal Arduino.h replacement so the firmware's logic headers compile and run
// on a host machine.
//
// The ESP32 toolchain is not needed to test the parts that can actually be
// wrong: the bite state machine and the salinity maths. Those are plain C++.
// This shim supplies what they use from the Arduino core, plus a controllable
// clock so tests can step through timing without sleeping.

#pragma once
#include <math.h>    // C header: puts isnan/sqrtf in the global namespace,
                     // which is where the Arduino core has them
#include <stdint.h>
#include <string.h>
#include <string>

// --- Controllable clock ------------------------------------------------------
extern uint32_t g_fake_millis;
inline uint32_t millis() { return g_fake_millis; }
inline void advance_ms(uint32_t ms) { g_fake_millis += ms; }
inline void reset_clock() { g_fake_millis = 0; }

// --- Arduino macros ----------------------------------------------------------
#ifndef constrain
#define constrain(amt, low, high) \
  ((amt) < (low) ? (low) : ((amt) > (high) ? (high) : (amt)))
#endif
// Arduino's min/max macros are deliberately NOT defined here - they collide
// with libstdc++ on a host build. The headers under test do not use them.

// <math.h> already provides isnan, sqrtf, INFINITY and NAN at global scope,
// matching how the Arduino core exposes them. Nothing further needed.
