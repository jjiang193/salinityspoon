/*
 * Uplink.cpp - see Uplink.h. Field names and units are docs/telemetry-schema.md.
 */
#include "Uplink.h"
#include "Config.h"
#include "Salinity.h"

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <time.h>

static WebSocketsClient ws;
static bool     wsConnected = false;
static bool     haveClock   = false;
static uint32_t nSent = 0, nDropped = 0;

// ---------------------------------------------------------------------------
static void onWsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      wsConnected = true;
      Serial.printf("[ws] connected to %s:%d%s\n", BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
      break;
    case WStype_DISCONNECTED:
      wsConnected = false;
      Serial.println("[ws] disconnected");
      break;
    case WStype_TEXT:
      // The backend answers with {"type":"error",...} when it refuses a bite -
      // the temperature interlock, a bad schema. Worth seeing on the bench.
      Serial.printf("[ws] rx: %.*s\n", (int)length, payload);
      break;
    default:
      break;
  }
}

// ISO-8601 UTC with milliseconds. Not epoch seconds - see the schema doc.
static String isoTimestamp() {
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

// ---------------------------------------------------------------------------
void uplinkBegin() {
  if (strcmp(WIFI_SSID, "CHANGE_ME") == 0) {
    Serial.println("[wifi] no credentials (create secrets.h) - staying offline, Serial only");
    return;
  }

  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    // Keep going: Serial is still useful and nothing else depends on the network.
    Serial.println("[wifi] FAILED - continuing offline");
    return;
  }
  Serial.printf("[wifi] ok, ip=%s\n", WiFi.localIP().toString().c_str());

  // Real clock time, or every bite is stamped 1970 and the dashboard puts the
  // whole meal in the wrong day.
  configTime(0, 0, "pool.ntp.org");
  start = millis();
  while (time(nullptr) < 1700000000 && millis() - start < 8000) delay(100);
  haveClock = time(nullptr) >= 1700000000;
  if (haveClock) Serial.printf("[ntp] clock set: %s\n", isoTimestamp().c_str());
  else           Serial.println("[ntp] FAILED - bites will carry a wrong timestamp");

  ws.begin(BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(3000);
}

void uplinkLoop() { ws.loop(); }
bool uplinkConnected() { return wsConnected; }
void uplinkStats(uint32_t &sent, uint32_t &dropped) { sent = nSent; dropped = nDropped; }

// ---------------------------------------------------------------------------
// One bite/v2 message. Every field below is in docs/telemetry-schema.md; the
// casing says whose field it is (NaTrack's camelCase, ours snake_case) and must
// not be normalised.
void uplinkPublish(const Bite &b, float biteIntervalSec, bool tooFast) {
  if (!wsConnected) { nDropped++; return; }

  StaticJsonDocument<768> doc;
  doc["schema"]          = "bite/v2";
  doc["deviceId"]        = DEVICE_ID;
  doc["bite_id"]         = b.biteId;
  doc["timestamp"]       = isoTimestamp();

  doc["salinityIndex"]   = b.salinityMsCm;   // mS/cm at 25 C, not g/L
  doc["tempC"]           = b.tempC;
  doc["salinity_g_l"]    = b.salinityGL;
  // A carried salinity is exactly what the contract calls bowl_reference:
  // inherited from an earlier in-range measurement of the same vessel. The bite
  // is real, the salinity is not freshly measured, and the dashboard says so.
  doc["salinity_source"] = b.salinityCarried ? "bowl_reference" : "measured";
  doc["dilution_factor"] = DILUTION_FACTOR;

  // The whole point of this spoon: a weighed bite, not an assumed scoop volume.
  doc["weightGrams"]     = b.weightG;
  doc["volume_source"]   = "load_cell";

  doc["sodiumEstimate"]  = b.sodiumMg;
  doc["sodium_mg_low"]   = b.sodiumLowMg;
  doc["sodium_mg_high"]  = b.sodiumHighMg;

  // quality fuses this bite's independent doubts into one number, the way the
  // volume spoon fuses submersion/settledness/stability. Ours are different
  // doubts, so they are listed rather than borrowed.
  float quality = 1.0f;
  if (!b.heldStill)      quality *= 0.8f;   // weighed while moving
  if (!b.tempSettled)    quality *= 0.8f;   // EC compensated with a lagging temp
  if (b.salinityCarried) quality *= 0.5f;   // salinity not measured on this bite
  doc["quality"]         = quality;
  doc["ec_sample_count"] = b.dipSamples;

  if (biteIntervalSec >= 0) doc["biteIntervalSec"] = biteIntervalSec;
  doc["pace"]            = tooFast ? "red" : "green";

  JsonArray flags = doc.createNestedArray("flags");
  if (tooFast)        flags.add("fast");
  if (!b.heldStill)   flags.add("moving");
  if (!b.tempSettled) flags.add("tempUnsettled");

  doc["fw_version"]      = FW_VERSION;

  char buf[768];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  ws.sendTXT(buf, n);
  nSent++;
}
