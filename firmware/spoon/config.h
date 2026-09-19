#pragma once

// ---------------------------------------------------------------------------
// Salinity Spoon - build configuration
// ---------------------------------------------------------------------------

#define FW_VERSION  "0.2.0"
#define DEVICE_ID   "spoon-01"

// --- Network -----------------------------------------------------------------
// Conference WiFi is hostile. If it fails, run the laptop as a hotspot.
// Put real credentials in secrets.h (gitignored), not here.
#define WIFI_SSID      "CHANGE_ME"
#define WIFI_PASSWORD  "CHANGE_ME"

#define BACKEND_HOST   "192.168.1.100"   // laptop running the backend
#define BACKEND_PORT   8000
#define BACKEND_PATH   "/ws/ingest"

// --- Pins --------------------------------------------------------------------
#define PIN_ONEWIRE    4     // DS18B20 data, 4.7k pull-up to 3.3V
#define PIN_LED_GREEN  25
#define PIN_LED_YELLOW 26
#define PIN_LED_RED    27
// ADS1115 and MPU-6050 share I2C: SDA=21, SCL=22

// Set to 1 for a common-anode RGB LED (inverts every write).
#define LED_COMMON_ANODE 0

// --- ADS1115 -----------------------------------------------------------------
// The EC probe goes into A0 of the ADS1115, never into an ESP32 ADC pin.
// Bite detection needs ~100 Hz EC sampling; the internal ADC cannot deliver it
// cleanly, and ADC2 is unusable while WiFi is active.
#define ADS1115_ADDR   0x48
#define ADS1115_CHAN   0

// --- Probe limits (DFR0300, K=1) ---------------------------------------------
// From the datasheet. These are not tuning knobs.
#define PROBE_TEMP_MIN_C        0.0f
#define PROBE_TEMP_MAX_C       40.0f    // THE interlock. See docs/measurement-protocol.md
#define PROBE_EC_MAX_MS_CM     20.0f    // hard detection ceiling
#define PROBE_EC_RECOMMENDED_MAX 15.0f  // accuracy holds below this

// --- Sampling ----------------------------------------------------------------
#define EC_SAMPLE_HZ          100       // ~50 samples in a 0.5s scoop
#define TEMP_INTERVAL_MS     1000       // DS18B20 conversion is ~750ms; never block on it
#define IMU_SAMPLE_HZ          50
#define SAMPLE_PUBLISH_HZ      10       // telemetry rate to the dashboard

// --- Bite detection ----------------------------------------------------------
#define WETTING_MS            150       // discard: probe film formation is a transient
#define CAPTURE_MIN_MS        250
#define CAPTURE_MAX_MS       5000       // longer than this is a soak, not a scoop
#define CONFIRM_TIMEOUT_MS   1500
#define MIN_EC_SAMPLES         20
#define MAX_EC_SAMPLES        256

#define EC_SUBMERGED_FLOOR_MS   0.30f   // mS/cm; a probe in air reads ~0
#define EC_STABILITY_MAX_SD     0.50f   // abort above this
#define GYRO_LIFT_THRESHOLD     1.20f   // rad/s, the raise that confirms a bite
#define GYRO_STILL_THRESHOLD    0.15f

#define QUALITY_THRESHOLD       0.60f

// --- Pace cue ----------------------------------------------------------------
// INVENTED DEFAULTS pending a clinical source. Say so in the pitch.
#define PACE_GREEN_S   30.0f
#define PACE_YELLOW_S  15.0f

// --- Salinity model ----------------------------------------------------------
// g/L NaCl = A*ec25 + B*ec25^2
// Defaults are fitted to reference NaCl conductivity tables. REPLACE with your
// own fit - see docs/calibration.md. Do not demo on the defaults.
#define SALINITY_COEFF_A   0.49078f
#define SALINITY_COEFF_B   0.004608f
#define SODIUM_FRACTION_OF_NACL  0.3934f

// --- Scoop volume ------------------------------------------------------------
// Replaces a load cell. Per-user, not per-device: random scoop variation
// averages out over a meal, systematic bias does not.
#define VOLUME_ML_MEAN   10.0f
#define VOLUME_ML_SD      2.5f
#define VOLUME_SOURCE    "default"      // "user_calibrated" once measured

// Applied AFTER converting EC to concentration, never before.
#define DILUTION_FACTOR   1.0f
