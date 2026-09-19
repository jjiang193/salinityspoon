// ---------------------------------------------------------------------------
// Salinity Spoon - ESP32 firmware
//
// Measures salt in liquids between 0 and 40 C. Fuses conductivity, temperature
// and motion into per-bite sodium estimates; streams them over a WebSocket.
//
// Required libraries (Arduino Library Manager unless noted):
//   OneWire                  Paul Stoffregen
//   DallasTemperature        Miles Burton
//   Adafruit MPU6050         (pulls in Adafruit BusIO + Unified Sensor)
//   Adafruit ADS1X15
//   ArduinoJson              Benoit Blanchon
//   WebSockets               Markus Sattler ("arduinoWebSockets")
//   DFRobot_ESP_EC           https://github.com/GreenPonik/DFRobot_ESP_EC_BY_GREENPONIK
//                            (install as ZIP - not in the Library Manager)
//
// Board: "ESP32 Dev Module". No COM port? Install the Silicon Labs CP210x VCP
// driver - the HiLetgo board uses a CP2102.
//
// Read docs/wiring.md before powering anything on, and
// docs/measurement-protocol.md before trusting a number.
// ---------------------------------------------------------------------------

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>
#include <time.h>

#include "config.h"
#include "salinity.h"
#include "ec_sensor.h"
#include "bite_detector.h"
#include "pace_led.h"

WebSocketsClient  ws;
OneWire           oneWire(PIN_ONEWIRE);
DallasTemperature tempSensors(&oneWire);
Adafruit_MPU6050  mpu;

ECSensor     ecSensor;
BiteDetector detector;
PaceLed      led;

uint32_t seq = 0, biteId = 0;
uint32_t lastEcMs = 0, lastTempMs = 0, lastPublishMs = 0;
float    lastTempC = NAN;
float    lastGyroMag = 0.0f;
float    lastEc25 = 0.0f;
uint32_t lastBiteMs = 0;
bool     wsConnected = false, mpuPresent = false, tempPresent = false;

// --- WebSocket ---------------------------------------------------------------
void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:    wsConnected = true;  Serial.println("[ws] connected"); break;
    case WStype_DISCONNECTED: wsConnected = false; Serial.println("[ws] disconnected"); break;
    case WStype_TEXT:         Serial.printf("[ws] rx: %.*s\n", (int)length, payload); break;
    default: break;
  }
}

void connectWiFi() {
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] ok, ip=%s\n", WiFi.localIP().toString().c_str());
    // Real clock time, or every bite is stamped 1970.
    configTime(0, 0, "pool.ntp.org");
  } else {
    // Keep sampling anyway - serial is still useful and the client reconnects.
    Serial.println("[wifi] FAILED - continuing offline");
  }
}

// ISO-8601 UTC with milliseconds. Not epoch seconds - see the schema doc.
String isoTimestamp() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  struct tm t;
  gmtime_r(&tv.tv_sec, &t);
  char buf[32];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03ldZ",
           t.tm_year + 1900, t.tm_mon + 1, t.tm_mday,
           t.tm_hour, t.tm_min, t.tm_sec, tv.tv_usec / 1000);
  return String(buf);
}

// --- Sensors -----------------------------------------------------------------
void initSensors() {
  Wire.begin();
  Wire.setClock(400000);   // 400 kHz: needed to sustain 100 Hz EC sampling

  tempSensors.begin();
  tempPresent = tempSensors.getDeviceCount() > 0;
  if (tempPresent) {
    tempSensors.setResolution(12);
    tempSensors.setWaitForConversion(false);  // request now, collect ~750ms later
    tempSensors.requestTemperatures();
    Serial.println("[temp] DS18B20 found");
  } else {
    Serial.println("[temp] DS18B20 NOT found - check the 4.7k pull-up to 3.3V");
    Serial.println("[temp] without temperature there is no interlock, so no bites");
  }

  mpuPresent = mpu.begin();  // 0x68, or 0x69 with AD0 high
  if (mpuPresent) {
    mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    Serial.println("[imu] MPU-6050 found");
  } else {
    Serial.println("[imu] MPU-6050 NOT found - bites cannot be confirmed");
  }

  ecSensor.begin();
  led.begin();
}

void updateTemperature() {
  if (!tempPresent || millis() - lastTempMs < TEMP_INTERVAL_MS) return;
  lastTempMs = millis();

  float t = tempSensors.getTempCByIndex(0);
  tempSensors.requestTemperatures();   // kick off the next conversion
  if (t != DEVICE_DISCONNECTED_C) lastTempC = t;
}

void updateIMU(sensors_event_t& a, sensors_event_t& g) {
  if (!mpuPresent) return;
  sensors_event_t t;
  mpu.getEvent(&a, &g, &t);
  lastGyroMag = sqrtf(g.gyro.x * g.gyro.x + g.gyro.y * g.gyro.y + g.gyro.z * g.gyro.z);
}

// --- Emit --------------------------------------------------------------------
void publishBite(const BiteResult& r) {
  float gPerL = salinity::applyDilution(
      salinity::ecToGramsPerLitre(r.ec25), DILUTION_FACTOR);

  float gap = lastBiteMs ? (millis() - lastBiteMs) / 1000.0f : -1.0f;
  lastBiteMs = millis();
  biteId++;

  PaceColour pace = PaceLed::forGap(gap);
  led.show(pace);

  StaticJsonDocument<640> doc;
  doc["schema"]            = "bite/v1";
  doc["device_id"]         = DEVICE_ID;
  doc["bite_id"]           = biteId;
  doc["ts_utc"]            = isoTimestamp();
  doc["ec25_ms_cm"]        = r.ec25;
  doc["temp_c"]            = r.tempC;
  doc["salinity_g_l"]      = gPerL;
  doc["salinity_source"]   = "measured";
  doc["dilution_factor"]   = DILUTION_FACTOR;
  doc["volume_ml"]         = VOLUME_ML_MEAN;
  doc["volume_source"]     = VOLUME_SOURCE;
  doc["sodium_mg"]         = salinity::sodiumMg(gPerL, VOLUME_ML_MEAN);
  doc["sodium_mg_low"]     = salinity::sodiumMg(gPerL, max(0.0f, VOLUME_ML_MEAN - VOLUME_ML_SD));
  doc["sodium_mg_high"]    = salinity::sodiumMg(gPerL, VOLUME_ML_MEAN + VOLUME_ML_SD);
  doc["quality"]           = r.quality;
  doc["ec_sample_count"]   = r.sampleCount;
  if (gap >= 0) doc["seconds_since_prev_bite"] = gap;
  doc["pace"]              = PaceLed::name(pace);
  doc["fw_version"]        = FW_VERSION;

  char buf[640];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (wsConnected) ws.sendTXT(buf, n);
  Serial.println(buf);
}

void publishSample(const sensors_event_t& a, const sensors_event_t& g) {
  StaticJsonDocument<512> doc;
  doc["schema"]        = "sample/v1";
  doc["device_id"]     = DEVICE_ID;
  doc["seq"]           = seq++;
  doc["uptime_ms"]     = millis();

  if (isnan(lastTempC)) doc["temp_c"] = nullptr;
  else                  doc["temp_c"] = lastTempC;
  doc["temp_in_range"] = salinity::tempInRange(lastTempC);

  doc["ec25_ms_cm"]    = lastEc25;
  doc["salinity_g_l"]  = salinity::ecToGramsPerLitre(lastEc25);

  JsonObject imu = doc.createNestedObject("imu");
  imu["ax"] = mpuPresent ? a.acceleration.x : 0.0f;
  imu["ay"] = mpuPresent ? a.acceleration.y : 0.0f;
  imu["az"] = mpuPresent ? a.acceleration.z : 0.0f;
  imu["gx"] = mpuPresent ? g.gyro.x : 0.0f;
  imu["gy"] = mpuPresent ? g.gyro.y : 0.0f;
  imu["gz"] = mpuPresent ? g.gyro.z : 0.0f;

  doc["motion"]    = lastGyroMag > GYRO_LIFT_THRESHOLD  ? "moving"
                   : lastGyroMag > GYRO_STILL_THRESHOLD ? "stirring" : "still";
  doc["submerged"] = lastEc25 > EC_SUBMERGED_FLOOR_MS;
  doc["state"]     = detector.stateName();
  doc["quality"]   = detector.state() == BS_CAPTURE ? 0.9f : 0.0f;

  char buf[512];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (wsConnected) ws.sendTXT(buf, n);
}

// --- Main --------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== Salinity Spoon " FW_VERSION " ===");
  Serial.println("Operating range: 0-40 C. Readings outside it are refused.");

  initSensors();
  connectWiFi();

  ws.begin(BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(3000);

  Serial.println("Calibration: type enterec, then calec, then exitec");
}

void loop() {
  ws.loop();
  updateTemperature();

  sensors_event_t a, g;
  updateIMU(a, g);

  // EC at ~100 Hz - the rate that makes a 0.5 s scoop measurable.
  if (millis() - lastEcMs >= (1000 / EC_SAMPLE_HZ)) {
    lastEcMs = millis();

    float tempC = isnan(lastTempC) ? 25.0f : lastTempC;  // fallback so EC resolves
    float mv    = ecSensor.readVoltageMv();
    lastEc25    = ecSensor.readEC25(mv, tempC);
    ecSensor.serviceCalibration(mv, tempC);

    BiteResult r = detector.update(lastEc25, lastTempC, lastGyroMag);
    if (r.valid) {
      publishBite(r);
    } else if (r.abortReason) {
      Serial.printf("[bite] aborted: %s\n", r.abortReason);
    }
  }

  // The LED tells the user to wait whenever the liquid is out of range, which
  // matters more than the pace cue - there is nothing to measure until it cools.
  if (!salinity::tempInRange(lastTempC) && lastEc25 > EC_SUBMERGED_FLOOR_MS) {
    led.showOutOfRange();
  }

  if (millis() - lastPublishMs >= (1000 / SAMPLE_PUBLISH_HZ)) {
    lastPublishMs = millis();
    publishSample(a, g);
  }
}
