#pragma once
#include <Arduino.h>
#include <Adafruit_ADS1X15.h>
#include <EEPROM.h>
#include "DFRobot_ESP_EC.h"
#include "config.h"

// ---------------------------------------------------------------------------
// EC front-end, via the ADS1115.
//
// The probe never touches an ESP32 ADC pin. Two reasons: the internal ADC is
// noisy and nonlinear, and bite detection needs ~100 Hz sampling that it cannot
// deliver cleanly. Routing through the ADS1115 also sidesteps the ADC2/WiFi
// conflict entirely.
//
// Uses GreenPonik's ESP32 port of the DFRobot library, which keeps the familiar
// enterec / calec / exitec serial calibration and stores the result in EEPROM.
// ---------------------------------------------------------------------------

class ECSensor {
 public:
  bool begin() {
    EEPROM.begin(32);
    _ec.begin();

    if (!_ads.begin(ADS1115_ADDR)) {
      Serial.println("[ec] ADS1115 NOT found - check I2C wiring");
      _ok = false;
      return false;
    }
    // +/-4.096V range comfortably covers the 0-3.4V sensor output.
    _ads.setGain(GAIN_ONE);
    // 860 SPS: the whole point of using this part.
    _ads.setDataRate(RATE_ADS1115_860SPS);
    _ok = true;
    Serial.println("[ec] ADS1115 ready at 860 SPS");
    return true;
  }

  float readVoltageMv() {
    int16_t raw = _ads.readADC_SingleEnded(ADS1115_CHAN);
    return _ads.computeVolts(raw) * 1000.0f;
  }

  // Returns EC compensated to 25 C, in mS/cm. The library does the temperature
  // compensation, which is exactly why the DS18B20 is not optional.
  float readEC25(float voltageMv, float tempC) {
    float ec = _ec.readEC(voltageMv, tempC);
    return ec < 0.0f ? 0.0f : ec;
  }

  // Serial commands enterec / calec / exitec drive the library's two-point
  // calibration; it recognises the 1413 uS/cm and 12.88 mS/cm standards itself.
  void serviceCalibration(float voltageMv, float tempC) {
    _ec.calibration(voltageMv, tempC);
  }

  bool ok() const { return _ok; }
  static bool overRange(float ec25) { return ec25 >= PROBE_EC_MAX_MS_CM * 0.95f; }
  static bool aboveRecommended(float ec25) { return ec25 > PROBE_EC_RECOMMENDED_MAX; }

 private:
  Adafruit_ADS1115 _ads;
  DFRobot_ESP_EC   _ec;
  bool _ok = false;
};
