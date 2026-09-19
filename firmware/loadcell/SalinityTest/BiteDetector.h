/*
 * BiteDetector.h - decides when a real bite happened and estimates its sodium.
 *
 * EMPTY  -> LOADED : weight on the spoon AND the EC probe is wet (food scooped)
 * LOADED           : measure the scoop (salinity, temp, weight)
 * LOADED -> EMPTY  : weight falls below 30% of the scoop. Where did the food go?
 *                      probe out of the food (EC fell) -> eaten, BITE
 *                      probe still in liquid (EC high) -> dipped back in the soup, no bite
 *                      tipped past POUR_TILT_DEG       -> poured out, no bite
 *
 * Scoop = average of ~0.5 s held level and still (best), else the average while moving
 * (flagged, wider range). An unsettled temp probe only widens the range, never blocks a bite.
 * Assumes the EC probe sits in the bowl, so it leaves the food once the food is eaten.
 * All thresholds are first guesses: tune on the spoon with the debug line.
 */
#ifndef BITE_DETECTOR_H
#define BITE_DETECTOR_H

#include "Sensors.h"

// ---- Scoop / food leaving ----
#define WET_MV              50.0f  // EC above this = probe in food (dry reads ~3 mV)
#define MIN_SCOOP_G          4.0f  // less than this counts as empty (above noise)
#define DROP_START_FRACTION  0.7f  // below 70% of the scoop = food leaving, stop measuring
#define EMPTY_FRACTION       0.3f  // below 30% of the scoop...
#define EMPTY_HOLD_MS      300     // ...for this long = food gone (ignores lip/motion spikes)
#define IMMERSED_FRACTION    0.5f  // EC above 50% of the scoop's EC = probe still in liquid
#define POUR_TILT_DEG       70.0f  // weight dropping while tipped past this = poured out

// ---- Motion (MPU-6050) ----
#define LEVEL_MAX_DEG       20.0f  // tilt from the boot position that still counts as level
#define STILL_GYRO_RAD_S     0.35f // rotation below this = still
#define STILL_ACCEL_DEV      1.0f  // |accel| within this of its at-rest value = still
#define SNAP_SAMPLES        25     // measurement window: 25 loops = 0.5 s at 50 Hz

// ---- Temperature (only widens the range) ----
#define TEMP_SETTLE_C        0.5f  // temp within this...
#define TEMP_SETTLE_MS    2000     // ...for this long = settled

// ---- Sodium estimate (placeholders until tested with known salt solutions) ----
#define NACL_MG_PER_G_PER_MS  0.55f   // mg salt per g food, per mS/cm (salt water ~0.5-0.57)
#define SODIUM_PER_NACL       0.393f  // sodium is 39.3% of salt by weight
#define SODIUM_RANGE_FRAC     0.30f   // +/-30%: EC reads all ions, plus weight error
#define SODIUM_RANGE_EXTRA    0.15f   // +15% for each quality flag that's false

struct Bite {
  uint32_t      biteId;                      // counter since boot
  unsigned long ms;                          // millis() when confirmed
  float salinityMsCm, tempC;                 // salinity already compensated to 25 C
  float weightG, loadedG, leftoverG;         // eaten = loaded - leftover
  float sodiumMg, sodiumLowMg, sodiumHighMg;
  bool  heldStill;                           // false = weighed while moving
  bool  tempSettled;                         // false = temp probe still catching up
};

void biteBegin();                                                          // zero + learn "level" (spoon empty, still)
bool biteUpdate(const SensorReadings &r, unsigned long now, Bite &out);   // every loop, true = new bite
void biteDebugPrint(const SensorReadings &r);                             // one status line

#endif
