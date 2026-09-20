/*
 * SalinityTest.ino - sodium spoon main program.
 * Reads every sensor at 50 Hz, detects bites, prints sodium per bite, lights the LED
 * when bites come too fast.
 *
 * How to use it: scoop -> dip the probe into the spoon for about a second -> lift
 * the probe out -> eat. The weight is taken before the dip (the probe leans on the
 * spoon, so the load cell is only honest while it is out) and the bite is closed
 * when the weight falls away. See BiteDetector.h.
 *
 * Before running: calibrate EC (ECCalibrate.ino) and the load cell (LoadCellCalibrate.ino).
 * Boot with the spoon empty, level and still. Type z + Enter to re-zero later.
 * Serial Monitor: 115200 baud.
 */
#include "Sensors.h"
#include "BiteDetector.h"
#include "PaceLed.h"

#define LOOP_MS   20     // 50 Hz
#define DEBUG_MS  1000   // status line every second (0 = only print bites)

void setup() {
  Serial.begin(115200);
  delay(1000);                                        // let USB serial connect
  Serial.println("=== Sodium spoon: bite detection ===");

  paceBegin();
  if (!sensorsBegin()) Serial.println("[!] Some sensors missing, see warnings above.");

  // Fill the weight average, then zero and learn "level"
  unsigned long start = millis();
  while (millis() - start < 700) { sensorsUpdate(); delay(LOOP_MS); }
  biteBegin();
  Serial.println("Ready. Scoop, hold level for ~0.5 s, dip the probe in for ~1 s, lift it out, eat.");
}

void loop() {
  static unsigned long lastTick, lastDebug;
  unsigned long now = millis();
  if (now - lastTick < LOOP_MS) return;               // run every LOOP_MS
  lastTick = now;

  sensorsUpdate();
  const SensorReadings &r = sensorsLatest();

  // z = re-zero (spoon empty, level, still)
  if (Serial.available() && Serial.read() == 'z') {
    biteBegin();
    Serial.println("Re-zeroed.");
  }

  // New bite: print it, check the pace
  Bite b;
  if (biteUpdate(r, now, b)) {
    Serial.printf(">>> BITE #%lu: ate %.1f g (%.1f loaded - %.1f left), %.2f mS/cm at %.1f C"
                  " from %d reading(s) -> sodium ~%.0f mg (%.0f-%.0f mg)%s%s%s\n",
                  (unsigned long)b.biteId, b.weightG, b.loadedG, b.leftoverG,
                  b.salinityMsCm, b.tempC, b.dipSamples, b.sodiumMg, b.sodiumLowMg, b.sodiumHighMg,
                  b.heldStill ? "" : " [weighed moving]", b.tempSettled ? "" : " [temp settling]",
                  b.salinityCarried ? " [NOT DIPPED: salinity reused from the last dip]" : "");

    unsigned long gapMs;
    if (paceOnBite(now, gapMs)) {
      Serial.printf("!!! EATING TOO FAST: %.1f s since the last bite (LED on %d s)\n",
                    gapMs / 1000.0f, WARN_ON_MS / 1000);
    }
  }
  paceUpdate(now);                                    // turns the LED off after WARN_ON_MS

  if (DEBUG_MS && now - lastDebug >= DEBUG_MS) {
    lastDebug = now;
    sensorsPrint(r);
    biteDebugPrint(r);
  }
}
