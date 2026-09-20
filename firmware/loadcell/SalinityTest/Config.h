/*
 * Config.h - identity, network and the salinity curve for the load-cell spoon.
 *
 * Pins live in Sensors.h and bite thresholds in BiteDetector.h; this is what the
 * device calls itself and who it talks to.
 *
 * Put real WiFi credentials in secrets.h (gitignored), never here:
 *
 *     // secrets.h
 *     #define WIFI_SSID      "my-network"
 *     #define WIFI_PASSWORD  "..."
 *     #define BACKEND_HOST   "192.168.1.100"
 *
 * Without secrets.h the sketch still builds and runs - it just stays offline and
 * prints bites to Serial, which is how you bench it.
 */
#ifndef CONFIG_H
#define CONFIG_H

#if __has_include("secrets.h")
#include "secrets.h"
#endif

#define FW_VERSION  "0.3.0-loadcell"
#define DEVICE_ID   "spoon-01"

// --- Network -----------------------------------------------------------------
// Conference WiFi is hostile. If it fails, run the laptop as a hotspot.
#ifndef WIFI_SSID
#define WIFI_SSID      "CHANGE_ME"
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD  "CHANGE_ME"
#endif
#ifndef BACKEND_HOST
#define BACKEND_HOST   "192.168.1.100"   // laptop running the backend
#endif
#ifndef BACKEND_PORT
#define BACKEND_PORT   8000
#endif
#ifndef BACKEND_PATH
#define BACKEND_PATH   "/ws/ingest"
#endif
// The backend must be started with --host 0.0.0.0. Bound to localhost it is
// invisible to the spoon, which connects from another machine on the network.

// --- Salinity curve ----------------------------------------------------------
// Mirrors firmware/spoon/config.h and backend/app/salinity.py. Change the curve
// in one, change it in all three.
//
// NaCl is slightly sublinear in conductivity over our range, so a quadratic
// beats a single multiplier. docs/telemetry-schema.md is explicit that
// salinity_g_l comes from "the calibrated quadratic curve, not a linear
// factor". Reference points the defaults hit:
//   2.0 mS/cm -> 1.0 g/L      17.5 mS/cm -> 10.0 g/L
#define SALINITY_COEFF_A   0.49078f
#define SALINITY_COEFF_B   0.004608f
#define SODIUM_FRACTION_OF_NACL  0.3934f   // 1 g NaCl = 393.4 mg sodium

#define DILUTION_FACTOR    1.0f            // applied AFTER the conversion to g/L

#endif
