/*
 * PaceLed.h - eating-pace warning. Two bites under TOO_FAST_MS apart turn the LED on
 * for WARN_ON_MS (another fast bite restarts it).
 * Wiring: GPIO25 -> 220-330 ohm -> LED long leg (+), short leg (-) -> GND.
 */
#ifndef PACE_LED_H
#define PACE_LED_H

#include <Arduino.h>

#define PACE_LED_PIN   25      // red LED
#define TOO_FAST_MS  6000      // bites closer than this = too fast
#define WARN_ON_MS   5000      // LED on time

void paceBegin();                                           // set up pin, blink once as a test
bool paceOnBite(unsigned long now, unsigned long &gapMs);   // per bite: true = too fast
void paceUpdate(unsigned long now);                         // every loop: turns the LED off

#endif
