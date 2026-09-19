/*
 * PaceLed.cpp - see PaceLed.h. Plain digitalWrite, never blocks the loop.
 */
#include "PaceLed.h"

static unsigned long lastBiteMs, ledOnSince;
static bool haveLastBite, ledOn;

void paceBegin() {
  pinMode(PACE_LED_PIN, OUTPUT);
  digitalWrite(PACE_LED_PIN, HIGH);                   // test blink: shows the wiring works
  delay(300);
  digitalWrite(PACE_LED_PIN, LOW);
}

bool paceOnBite(unsigned long now, unsigned long &gapMs) {
  gapMs = haveLastBite ? now - lastBiteMs : 0;        // 0 for the first bite
  bool tooFast = haveLastBite && gapMs < TOO_FAST_MS;
  lastBiteMs = now;
  haveLastBite = true;

  if (tooFast) {                                      // on (or restart the timer)
    digitalWrite(PACE_LED_PIN, HIGH);
    ledOn = true;
    ledOnSince = now;
  }
  return tooFast;
}

void paceUpdate(unsigned long now) {
  if (ledOn && now - ledOnSince >= WARN_ON_MS) {
    digitalWrite(PACE_LED_PIN, LOW);
    ledOn = false;
  }
}
