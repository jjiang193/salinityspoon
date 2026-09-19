/*
 * Sensors.h - reads every sensor on the spoon (pin map: salinity-system-reference.html).
 * Nothing blocks for long, so the main loop can run at 50 Hz.
 */
#ifndef SENSORS_H
#define SENSORS_H

#include <Arduino.h>

// ---- Pins ----
#define TEMP_PIN        4    // DS18B20 data (4.7k pull-up to 3.3V)
#define SDA_PIN        21    // I2C: ADS1115 (0x48) + MPU-6050 (0x68)
#define SCL_PIN        22
#define HX711_DT_PIN   16    // load cell amp data  (RX2)
#define HX711_SCK_PIN  17    // load cell amp clock (TX2)
#define EC_ADS_CHANNEL  0    // EC signal on ADS1115 A0

// Load cell counts per gram, from LoadCellCalibrate.ino. At 1.0 weight is raw counts.
#define LOADCELL_SCALE  1.0f

#define WEIGHT_AVG_SAMPLES  5     // HX711 ~10 Hz, so weight = average of the last ~0.5 s
#define EC_READ_MS        100     // read EC at 10 Hz (one ADS1115 read takes ~9 ms)

// Latest value of every sensor
struct SensorReadings {
  float tempC;                 // liquid temp (C), last good reading
  float ecVoltageMv;           // EC probe voltage (mV)
  float ecMsCm;                // salinity: conductivity (mS/cm), compensated to 25 C
  float weightG;               // weight (g), zeroed at boot
  float ax, ay, az;            // acceleration (m/s^2)
  float gx, gy, gz;            // rotation (rad/s)
  bool  tempOk, adsOk, mpuOk, scaleOk;   // false = sensor missing / not responding
};

bool sensorsBegin();                          // start all sensors, false if any missing
void sensorsUpdate();                         // every loop: refresh whatever is ready
const SensorReadings &sensorsLatest();
void sensorsPrint(const SensorReadings &r);   // one line to Serial

#endif
