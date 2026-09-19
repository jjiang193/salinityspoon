/*
 * Sensors.cpp - each sensor follows its library's example sketch:
 *   DS18B20 (DallasTemperature "WaitForConversion"), ADS1115 (Adafruit "singleended"),
 *   MPU-6050 (Adafruit "basic_readings"), HX711 (bogde "HX711_full_example").
 */
#include "Sensors.h"
#include "ECCalibration.h"

#include <Wire.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Adafruit_ADS1X15.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <HX711.h>

static OneWire           oneWire(TEMP_PIN);
static DallasTemperature tempSensor(&oneWire);
static Adafruit_ADS1115  ads;
static Adafruit_MPU6050  mpu;
static HX711             scale;

static SensorReadings latest;
static bool scaleFound;                               // HX711 answered at boot
static unsigned long tempRequestedAt, lastEcAt, lastWeightAt;
static float weightBuf[WEIGHT_AVG_SAMPLES];           // last few weights, for the average
static int   weightIdx, weightCount;

bool sensorsBegin() {
  ecBegin();                                          // load EC calibration (ECCalibrate.ino)

  // DS18B20: don't wait for conversions (750 ms), collect them in sensorsUpdate()
  tempSensor.begin();
  bool tempOk = tempSensor.getDeviceCount() > 0;
  if (!tempOk) Serial.println("[WARN] DS18B20 not found on GPIO4 (check 4.7k pull-up).");
  tempSensor.setWaitForConversion(false);
  tempSensor.requestTemperatures();
  tempRequestedAt = millis();
  latest.tempC = 25.0f;                               // EC compensation default until first reading

  Wire.begin(SDA_PIN, SCL_PIN);                       // I2C bus for ADS1115 + MPU-6050

  ads.setGain(GAIN_ONE);                              // +/-4.096 V covers the 0-3.4 V EC signal
  latest.adsOk = ads.begin();
  if (!latest.adsOk) Serial.println("[WARN] ADS1115 not found at 0x48.");

  latest.mpuOk = mpu.begin();
  if (latest.mpuOk) {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  } else {
    Serial.println("[WARN] MPU-6050 not found at 0x68.");
  }

  // HX711: timeout so a missing board can't hang tare()
  scale.begin(HX711_DT_PIN, HX711_SCK_PIN);
  scaleFound = latest.scaleOk = scale.wait_ready_timeout(1000);
  if (scaleFound) {
    scale.set_scale(LOADCELL_SCALE);
    delay(500);                                       // HX711 settles ~400 ms after begin()
    scale.tare();                                     // bowl must be empty at boot
    lastWeightAt = millis();
  } else {
    Serial.println("[WARN] HX711 not found on GPIO16/17.");
  }
  if (LOADCELL_SCALE == 1.0f) Serial.println("[WARN] LOADCELL_SCALE not set, weight is raw counts. Run LoadCellCalibrate.");

  return tempOk && latest.adsOk && latest.mpuOk && scaleFound;
}

void sensorsUpdate() {
  unsigned long now = millis();

  // Temp: collect the finished conversion, start the next (~every 750 ms)
  if (now - tempRequestedAt >= 750) {
    float t = tempSensor.getTempCByIndex(0);
    latest.tempOk = (t != DEVICE_DISCONNECTED_C);
    if (latest.tempOk) latest.tempC = t;
    tempSensor.requestTemperatures();
    tempRequestedAt = now;
  }

  // EC: ADS1115 volts -> mV -> mS/cm (temp compensated)
  if (latest.adsOk && now - lastEcAt >= EC_READ_MS) {
    latest.ecVoltageMv = ads.computeVolts(ads.readADC_SingleEnded(EC_ADS_CHANNEL)) * 1000.0f;
    latest.ecMsCm      = ecRead(latest.ecVoltageMv, latest.tempC);
    lastEcAt = now;
  }

  // Motion: every call
  if (latest.mpuOk) {
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    latest.ax = a.acceleration.x; latest.ay = a.acceleration.y; latest.az = a.acceleration.z;
    latest.gx = g.gyro.x;         latest.gy = g.gyro.y;         latest.gz = g.gyro.z;
  }

  // Weight: read only when a sample is waiting (never blocks), average the last few
  if (scaleFound && scale.is_ready()) {
    weightBuf[weightIdx] = scale.get_units(1);
    weightIdx = (weightIdx + 1) % WEIGHT_AVG_SAMPLES;
    if (weightCount < WEIGHT_AVG_SAMPLES) weightCount++;
    float sum = 0;
    for (int i = 0; i < weightCount; i++) sum += weightBuf[i];
    latest.weightG = sum / weightCount;
    lastWeightAt = now;
  }
  latest.scaleOk = scaleFound && (now - lastWeightAt < 500);   // no sample for 0.5 s = unplugged
}

const SensorReadings &sensorsLatest() { return latest; }

void sensorsPrint(const SensorReadings &r) {
  Serial.printf("Temp %.2f C%s | EC %.2f mS/cm (%.0f mV)%s | Weight %.1f g%s | "
                "Accel %.2f %.2f %.2f | Gyro %.2f %.2f %.2f%s\n",
                r.tempC, r.tempOk ? "" : " (--)",
                r.ecMsCm, r.ecVoltageMv, r.adsOk ? "" : " (--)",
                r.weightG, r.scaleOk ? "" : " (--)",
                r.ax, r.ay, r.az, r.gx, r.gy, r.gz, r.mpuOk ? "" : " (--)");
}
