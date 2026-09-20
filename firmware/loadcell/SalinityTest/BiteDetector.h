/*
 * BiteDetector.h - what counts as a bite, and every threshold that decides it.
 *
 * The flow, one state per physical step:
 *
 *   EMPTY -> FILLING -> LOADED -> DIPPING -> MEASURED -> EMPTY (bite logged)
 *
 * Three rules shape all of it:
 *
 *   1. Weight is latched once, after it has been there long enough to be real.
 *      Food goes in, three seconds pass, that weight is the scoop. Nothing the
 *      probe does afterwards can change it.
 *
 *   2. The measurement is latched too. Once a dip has ended, that salinity and
 *      temperature belong to this spoonful. Lifting the probes out does not
 *      change them; only a new dip does.
 *
 *   3. The bowl must stay empty for two seconds before a bite is logged, so
 *      food leaving in stages is one bite, not two or three.
 *
 * No false-bite logic: a weight that falls away and stays away is a bite, full
 * stop. Tipping a measured spoonful back into the bowl is recorded as eaten.
 * That is the accepted cost of a rule a person can predict.
 *
 * All thresholds are first guesses: tune them on the spoon with the debug line.
 */
#ifndef BITE_DETECTOR_H
#define BITE_DETECTOR_H

#include "Sensors.h"
#include "Salinity.h"

// ---- Loading: food in, then wait before believing the number ----
#define MIN_SCOOP_G          4.0f  // less than this counts as empty (above noise)
#define LOAD_SETTLE_MS     3000    // weight must stay up this long before it is latched
#define LATCH_SAMPLES       25     // the latched weight is the mean of the last 25 loops (0.5 s)
#define TOPUP_G              2.0f  // more food than this on top of a latched scoop...
#define TOPUP_HOLD_MS       500    // ...that stays = re-latch. A table knock is over in 60 ms

// ---- The dip: probes in the food ----
// Hysteresis, because a probe that has been in food keeps a conductive film and
// reads well above a never-used one for a while after it leaves.
#define WET_MV             120.0f  // EC above this = probes are in the food
#define DRY_MV              80.0f  // ...and below this = they are out again
#define DRY_HOLD_MS        300     // ...for this long (ignores a wobble at the surface)
#define DIP_SAMPLE_MS      EC_READ_MS   // one sample per fresh EC reading
#define MIN_DIP_SAMPLES      5     // shortest dip worth trusting: 0.5 s
#define DIP_TAIL_SAMPLES    20     // salinity is the median of the LAST 2 s of the dip

// The load cell is a rolling average, so for about half a second after the
// probes lift it is still reporting their weight. Weight decisions wait this
// long, or a lifting probe reads as food being taken out.
#define WEIGHT_TRUST_MS    700

// ---- THE interlock. Same numbers as firmware/spoon/config.h and
// backend/app/salinity.py, enforced here for the same reason: outside the
// probe's rated range the temperature compensation was never characterised, so
// a reading there is not less precise, it is unsupported. A dip outside it is
// dropped and the spoonful is not recorded. There is no log-it-anyway path.
#define PROBE_TEMP_MIN_C     0.0f
#define PROBE_TEMP_MAX_C    40.0f

// ---- Temperature settling (only widens the range) ----
// The DS18B20 enters the food from room air and takes seconds to catch up, and
// the EC reading is compensated with it (~2 %/degC). This is why the salinity
// is the tail of the dip and not its average: on a rising curve the average is
// a reading of a temperature the food never had.
#define TEMP_SETTLE_C        0.5f  // temp within this...
#define TEMP_SETTLE_MS    2000     // ...for this long = settled

// ---- Emptying: the bite ----
#define EMPTY_FRACTION       0.3f  // below 30% of the latched scoop = the food is going
#define EMPTY_HOLD_MS     2000     // ...and staying below it this long = it is gone.
                                   // Long on purpose: pouring a bowl out takes a
                                   // moment, and half a pour must not read as a bite.

// Weight leaving is not enough: the bowl must have been TIPPED for the food to
// have been poured out. Lifting a coin off a level bowl is weight leaving too,
// and it is not a bite. The peak tilt seen while the weight falls has to reach
// this, or the spoonful is discarded.
#define REQUIRE_POUR         1     // 0 = any weight drop is a bite (the old rule)
#define POUR_TILT_DEG       45.0f  // tipped at least this far = poured out

// ---- Motion (MPU-6050): quality only, it never blocks a bite ----
#define LEVEL_MAX_DEG       20.0f  // tilt from the boot position that still counts as level
#define STILL_GYRO_RAD_S     0.35f // rotation below this = still
#define STILL_ACCEL_DEV      1.0f  // |accel| within this of its at-rest value = still

// ---- Sodium estimate (placeholders until tested with known salt solutions) ----
// The EC -> g/L -> mg sodium curve lives in Salinity.h, shared with the backend.
#define SODIUM_RANGE_FRAC     0.30f   // +/-30%: EC reads all ions, plus weight error
#define SODIUM_RANGE_EXTRA    0.15f   // +15% for each quality flag that is false

struct Bite {
  uint32_t      biteId;                      // counter since boot
  unsigned long ms;                          // millis() when confirmed
  float salinityMsCm, tempC;                 // salinity already compensated to 25 C
  float salinityGPerL;                       // g/L NaCl-equivalent, from the quadratic curve
  float weightG, loadedG, leftoverG;         // eaten = loaded - leftover
  float sodiumMg, sodiumLowMg, sodiumHighMg;
  int   dipSamples;                          // EC readings behind the salinity (0 = never dipped)
  bool  salinityMeasured;                    // false = never dipped: salinity 0, sodium unknown
  bool  heldStill;                           // false = latched while moving
  float pourTiltDeg;                         // how far it was tipped while emptying
  bool  tempSettled;                         // false = temp probe still catching up at dip end
};

void biteBegin();                                                        // zero + learn "level" (bowl empty, still)
bool biteUpdate(const SensorReadings &r, unsigned long now, Bite &out);  // every loop, true = new bite
void biteDebugPrint(const SensorReadings &r);                            // one status line

#endif
