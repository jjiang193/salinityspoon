/*
 * ECCalibrate.ino - two-point calibration of the DFR0300 EC probe (saves K to flash).
 * Based on the DFRobot sample: https://wiki.dfrobot.com/dfr0300/docs/20349
 * Differences: voltage from the ADS1115 (A0), temp from the DS18B20, EEPROM.commit()
 * for the ESP32, and commands read here (the library's own reader overruns memory).
 *
 * Serial Monitor: 115200 baud, line ending "Newline". For EACH solution
 * (1413 uS/cm first, then 12.88 mS/cm):
 *   rinse + dry probe -> probe and DS18B20 in solution -> wait ~1 min until stable
 *   enterec -> calec (">>>Successful,K:...") -> exitec (">>>Calibration Successful")
 * Check: ~1.41 in the low solution, ~12.88 in the high one. SalinityTest loads these values.
 */
#include <Wire.h>
#include <EEPROM.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Adafruit_ADS1X15.h>
#include "DFRobot_EC.h"

#define TEMP_PIN  4    // DS18B20 data
#define SDA_PIN  21    // ADS1115 I2C
#define SCL_PIN  22

float voltage, ecValue, temperature = 25;
DFRobot_EC ec;
Adafruit_ADS1115 ads;
OneWire oneWire(TEMP_PIN);
DallasTemperature tempSensor(&oneWire);

void setup() {
  Serial.begin(115200);
  EEPROM.begin(32);                    // open flash EEPROM before ec.begin() reads K
  ec.begin();
  tempSensor.begin();

  Wire.begin(SDA_PIN, SCL_PIN);
  ads.setGain(GAIN_ONE);               // +/-4.096 V covers the 0-3.4 V EC signal
  if (!ads.begin()) {
    Serial.println("Failed to initialize ADS1115.");
    while (1) delay(10);
  }
  Serial.println("EC calibration ready: enterec / calec / exitec");
}

void loop() {
  // Read and print once a second (same as the DFRobot sample)
  static unsigned long timepoint = millis();
  if (millis() - timepoint > 1000U) {
    timepoint = millis();
    voltage     = ads.computeVolts(ads.readADC_SingleEnded(0)) * 1000;   // mV
    temperature = readTemperature();
    ecValue     = ec.readEC(voltage, temperature);
    Serial.printf("temperature:%.1f^C  voltage:%.0fmV  EC:%.2fms/cm\n", temperature, voltage, ecValue);
  }
  handleCommand();
}

// Read one command line and pass it to the library with a trailing space.
// (The library's strupr() stops at a space, not at the end, so without it it overruns.)
void handleCommand() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd.length() == 0) return;
  cmd += ' ';
  ec.calibration(voltage, temperature, (char *)cmd.c_str());
  EEPROM.commit();                     // saves K after exitec (no-op otherwise)
}

float readTemperature() {
  tempSensor.requestTemperatures();
  float t = tempSensor.getTempCByIndex(0);
  return (t == DEVICE_DISCONNECTED_C) ? 25.0 : t;   // 25 C if the probe is missing
}
