#pragma once
#include <Arduino.h>
#include "config.h"

// ---------------------------------------------------------------------------
// Eating-pace cue, and the wait signal when the liquid is out of range.
// Reuses bite timing - no extra sensor.
// ---------------------------------------------------------------------------

enum PaceColour { PACE_OFF, PACE_GREEN, PACE_YELLOW, PACE_RED };

class PaceLed {
 public:
  void begin() {
    pinMode(PIN_LED_GREEN, OUTPUT);
    pinMode(PIN_LED_YELLOW, OUTPUT);
    pinMode(PIN_LED_RED, OUTPUT);
    show(PACE_OFF);
  }

  void show(PaceColour c) {
    _current = c;
    write(PIN_LED_GREEN,  c == PACE_GREEN);
    write(PIN_LED_YELLOW, c == PACE_YELLOW);
    write(PIN_LED_RED,    c == PACE_RED);
  }

  // Out of the probe's range: blink yellow. The user is being told to wait for
  // the liquid to cool, not that they are eating too fast.
  void showOutOfRange() {
    bool on = (millis() / 400) % 2;
    write(PIN_LED_GREEN, false);
    write(PIN_LED_YELLOW, on);
    write(PIN_LED_RED, false);
    _current = PACE_YELLOW;
  }

  static PaceColour forGap(float seconds) {
    if (seconds < 0)             return PACE_OFF;    // no previous bite yet
    if (seconds > PACE_GREEN_S)  return PACE_GREEN;
    if (seconds >= PACE_YELLOW_S) return PACE_YELLOW;
    return PACE_RED;
  }

  static const char* name(PaceColour c) {
    switch (c) {
      case PACE_GREEN:  return "green";
      case PACE_YELLOW: return "yellow";
      case PACE_RED:    return "red";
      default:          return "unknown";
    }
  }

  PaceColour current() const { return _current; }

 private:
  void write(int pin, bool on) {
#if LED_COMMON_ANODE
    digitalWrite(pin, on ? LOW : HIGH);
#else
    digitalWrite(pin, on ? HIGH : LOW);
#endif
  }

  PaceColour _current = PACE_OFF;
};
