/*
 * BiteDetector.h - decides when a bite happened and estimates its sodium.
 *
 * The measurement flow this is built around. Each step is a state:
 *
 *   EMPTY    nothing on the spoon. The load cell zero follows its own slow drift.
 *
 *   LOADED   food has been scooped. The probe is OUT of the spoon, so the load
 *            cell reads food and nothing else: this is the only moment the
 *            scoop weight can be trusted, so it is measured and latched here.
 *
 *   DIPPING  the temperature + conductivity probe has been lowered into the
 *            spoon. It leans on the spoon, so the load cell is now reading the
 *            probe as well as the food - the weight is FROZEN for the whole dip
 *            and nothing that happens to it means anything. Salinity and
 *            temperature come from the tail of the dip, once the probe has had
 *            time to reach the food's temperature.
 *
 *   MEASURED the probe is out, the weight can be trusted again, and the spoon is
 *            on its way to the mouth. When the weight falls away, that is the
 *            bite: eaten = loaded - leftover.
 *
 * A falling weight ends the bite. Full stop. There is no attempt to work out
 * where the food went - no pour detection, no "was the probe still in liquid",
 * no abort. Tipping a measured spoonful back into the bowl is recorded as a
 * bite, and that is the accepted cost of a rule a user can predict.
 *
 * The motion sensor is no longer a judge, only an instrument: it corrects the
 * load cell for tilt and marks readings taken while the spoon was moving. A
 * missing MPU-6050 degrades quality, it does not block bites.
 *
 * All thresholds are first guesses: tune on the spoon with the debug line.
 */
#ifndef BITE_DETECTOR_H
#define BITE_DETECTOR_H

#include "Sensors.h"

// ---- Scoop: probe out of the spoon, so the load cell can be believed ----
#define MIN_SCOOP_G          4.0f  // less than this counts as empty (above noise)
#define SCOOP_SPREAD_FRAC    0.10f // window within +/-5% of its mean = a steady weight
#define SNAP_SAMPLES        25     // weight window: 25 loops = 0.5 s at 50 Hz
#define TOPUP_G              2.0f  // weight rising this far above a measured scoop...
#define TOPUP_HOLD_MS      500     // ...and staying there = more food went in, measure
                                   // it again. A knock on the table is over in 60 ms.

// ---- The dip: probe in the spoon, so the load cell CANNOT be believed ----
// Hysteresis, because a probe that has been in food keeps a conductive film on
// it and reads well above a never-used one (~3 mV) for a while after it leaves.
#define WET_MV             250.0f  // EC above this = probe is in the food
#define DRY_MV             150.0f  // ...and below this = probe is out again
#define DRY_HOLD_MS        300     // ...for this long (ignores a wobble at the surface)
#define DIP_SAMPLE_MS      EC_READ_MS   // one measurement per fresh EC reading
#define MIN_DIP_SAMPLES      5     // shortest dip worth trusting: 0.5 s
#define DIP_TAIL_SAMPLES    20     // salinity is the median of the LAST 2 s of the dip
// The load cell is a rolling average (WEIGHT_AVG_SAMPLES at ~10 Hz), so for half
// a second after the probe lifts it is still reporting the probe's weight. Every
// weight decision waits this long, or a lifting probe reads as food being added.
#define WEIGHT_TRUST_MS    700

// ---- THE interlock. Same numbers as firmware/spoon/config.h and
// backend/app/salinity.py, enforced here for the same reason: outside the
// probe's rated range the temperature compensation was never characterised, so
// a reading there is not less precise, it is unsupported. A dip outside it is
// dropped and the spoonful is not recorded. There is no log-it-anyway path.
// See docs/measurement-protocol.md.
#define PROBE_TEMP_MIN_C     0.0f
#define PROBE_TEMP_MAX_C    40.0f

// ---- Temperature settling (only widens the range) ----
// The DS18B20 enters the food from room air and takes seconds to catch up, and
// the EC reading is compensated with it (~2 %/degC). This is why the salinity
// comes from the tail of the dip and not its average: on a rising curve the
// average is a reading of a temperature the food never had.
#define TEMP_SETTLE_C        0.5f  // temp within this...
#define TEMP_SETTLE_MS    2000     // ...for this long = settled

// ---- Food leaving ----
#define EMPTY_FRACTION       0.3f  // below 30% of the scoop...
#define EMPTY_HOLD_MS      300     // ...for this long = food gone (ignores lip/motion spikes)

// ---- Motion (MPU-6050): quality and tilt correction only ----
#define LEVEL_MAX_DEG       20.0f  // tilt from the boot position that still counts as level
#define STILL_GYRO_RAD_S     0.35f // rotation below this = still
#define STILL_ACCEL_DEV      1.0f  // |accel| within this of its at-rest value = still

// ---- Sodium estimate (placeholders until tested with known salt solutions) ----
#define NACL_MG_PER_G_PER_MS  0.55f   // mg salt per g food, per mS/cm (salt water ~0.5-0.57)
#define SODIUM_PER_NACL       0.393f  // sodium is 39.3% of salt by weight
#define SODIUM_RANGE_FRAC     0.30f   // +/-30%: EC reads all ions, plus weight error
#define SODIUM_RANGE_EXTRA    0.15f   // +15% for each quality flag that's false

// A spoonful eaten without a dip is still sodium. Rather than drop it, reuse the
// salinity of the last dip - same bowl, same soup - and say so on the bite.
// Set to 0 to report only what was actually measured.
#define CARRY_SALINITY        1
#define SODIUM_RANGE_CARRIED  0.25f   // +25% more on top, for a salinity nobody measured

struct Bite {
  uint32_t      biteId;                      // counter since boot
  unsigned long ms;                          // millis() when confirmed
  float salinityMsCm, tempC;                 // salinity already compensated to 25 C
  float weightG, loadedG, leftoverG;         // eaten = loaded - leftover
  float sodiumMg, sodiumLowMg, sodiumHighMg;
  int   dipSamples;                          // EC readings behind the salinity (0 = carried)
  bool  heldStill;                           // false = scoop weighed while moving
  bool  tempSettled;                         // false = temp probe still catching up at dip end
  bool  salinityCarried;                     // true = salinity is the previous dip's, not this bite's
};

void biteBegin();                                                        // zero + learn "level" (spoon empty, still)
bool biteUpdate(const SensorReadings &r, unsigned long now, Bite &out);  // every loop, true = new bite
void biteDebugPrint(const SensorReadings &r);                            // one status line

#endif
