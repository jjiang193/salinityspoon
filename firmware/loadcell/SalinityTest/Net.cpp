/*
 * Net.cpp - Wi-Fi, NTP, and bite/v2 to AWS IoT Core. See Net.h.
 *
 * State, in order: Wi-Fi associates -> NTP gives a real clock -> MQTT connects
 * with the device certificate -> queued bites drain. Any step can fail and be
 * retried without blocking the main loop.
 */
#include "Net.h"
#include "Salinity.h"
#include "secrets.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>

static WiFiClientSecure tls;
static PubSubClient     mqtt(tls);

// ---------- The offline queue ----------
struct Queued {
  Bite          bite;
  unsigned long gapMs;
  bool          haveGap;
  bool          tooFast;
};
static Queued queue[QUEUE_LEN];
static int    qHead, qCount;           // ring buffer
static uint32_t dropped;               // bites lost to a full queue, for the status line

// ---------- Clock ----------
// millis() is time since boot; the contract wants ISO-8601 UTC with
// milliseconds. NTP gives the offset between the two, once, and every bite is
// stamped through it - including bites that were queued before the clock was
// right, which is the point of storing millis() rather than a string.
static bool     clockValid;
static uint64_t bootEpochMs;           // epoch ms at millis() == 0

static unsigned long lastWifiTry, lastMqttTry;
static int  wifiTries;
static bool scanned;

// ================= Helpers =================

// The status code in words. WL_NO_SSID_AVAIL means the name was never seen on
// the air (wrong name, or a 5 GHz-only hotspot); WL_CONNECT_FAILED is the
// password.
static const char *wifiStatus() {
  switch (WiFi.status()) {
    case WL_IDLE_STATUS:     return "idle";
    case WL_NO_SSID_AVAIL:   return "that network name is not on the air (wrong name, or 5 GHz only)";
    case WL_SCAN_COMPLETED:  return "scan done";
    case WL_CONNECTED:       return "connected";
    case WL_CONNECT_FAILED:  return "rejected - check the password";
    case WL_CONNECTION_LOST: return "connection lost";
    case WL_DISCONNECTED:    return "disconnected / still trying";
    default:                 return "unknown";
  }
}

static bool syncClock() {
  if (clockValid) return true;
  time_t nowSec = time(nullptr);
  if (nowSec < 1700000000) return false;            // still 1970: NTP has not answered
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  uint64_t epochMs = (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000ULL;
  bootEpochMs = epochMs - millis();
  clockValid = true;
  Serial.println("[net] clock synced (NTP)");
  return true;
}

// ISO-8601 UTC with milliseconds: 2026-09-20T06:28:52.609Z. Not epoch - the
// contract is explicit, and the milliseconds are what make the dedupe key safe.
static void isoTimestamp(unsigned long ms, char *out, size_t len) {
  uint64_t epochMs = bootEpochMs + ms;
  time_t   secs    = epochMs / 1000ULL;
  int      millisPart = epochMs % 1000ULL;
  struct tm t;
  gmtime_r(&secs, &t);
  snprintf(out, len, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
           t.tm_year + 1900, t.tm_mon + 1, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec, millisPart);
}

// 1.0 is a bite with nothing to doubt. Each flag the detector could not set
// takes a bite of it. Same spirit as the local backend's quality score.
static float quality(const Bite &b) {
  float q = 1.0f;
  if (!b.heldStill)   q -= 0.2f;
  if (!b.tempSettled) q -= 0.2f;
  if (b.dipSamples < 10) q -= 0.1f;
  return q < 0 ? 0 : q;
}

static void buildJson(const Queued &item, char *out, size_t len) {
  const Bite &b = item.bite;
  JsonDocument doc;

  doc["schema"]   = "bite/v2";
  doc["deviceId"] = AWS_IOT_CLIENT_ID;     // the IoT rule overwrites this from the topic anyway
  doc["bite_id"]  = b.biteId;

  char ts[32];
  isoTimestamp(b.ms, ts, sizeof(ts));
  doc["timestamp"] = ts;

  doc["salinityIndex"]   = round(b.salinityMsCm * 100) / 100.0;
  doc["tempC"]           = round(b.tempC * 10) / 10.0;
  doc["salinity_g_l"]    = round(b.salinityGPerL * 100) / 100.0;
  doc["salinity_source"] = "measured";     // un-dipped bites are never published
  doc["dilution_factor"] = 1.0;

  doc["weightGrams"]   = round(b.weightG * 10) / 10.0;
  doc["volume_source"] = "load_cell";

  doc["sodiumEstimate"] = round(b.sodiumMg * 10) / 10.0;
  doc["sodium_mg_low"]  = round(b.sodiumLowMg * 10) / 10.0;
  doc["sodium_mg_high"] = round(b.sodiumHighMg * 10) / 10.0;

  doc["quality"]         = round(quality(b) * 100) / 100.0;
  doc["ec_sample_count"] = b.dipSamples;
  // How far the bowl was tipped while it emptied: the evidence that the food
  // was poured out rather than lifted off. An extension - snake_case, because
  // NaTrack does not name it. Add it to docs/telemetry-schema.md before anyone
  // downstream relies on it.
  doc["pour_tilt_deg"]   = round(b.pourTiltDeg);

  if (item.haveGap) doc["biteIntervalSec"] = round(item.gapMs / 100.0) / 10.0;
  else              doc["biteIntervalSec"] = nullptr;   // first bite after boot

  doc["pace"] = item.tooFast ? "red" : "green";

  JsonArray flags = doc["flags"].to<JsonArray>();
  if (item.tooFast)    flags.add("fast");
  if (!b.heldStill)    flags.add("moving");
  if (!b.tempSettled)  flags.add("tempUnsettled");

  doc["fw_version"] = FW_VERSION;

  serializeJson(doc, out, len);
}

static bool publish(const Queued &item) {
  char json[JSON_CAPACITY];
  buildJson(item, json, sizeof(json));
  // QoS 1 is what the handoff doc specifies; PubSubClient only does QoS 0, so
  // the queue below plus the idempotent write in the ingest Lambda carry the
  // duty instead: a resend cannot duplicate a bite.
  return mqtt.publish(AWS_IOT_TOPIC, json);
}

static void drainQueue() {
  while (qCount > 0 && mqtt.connected()) {
    if (!publish(queue[qHead])) break;                // try again next loop
    Serial.printf("[net] sent bite #%lu%s\n",
                  (unsigned long)queue[qHead].bite.biteId,
                  qCount > 1 ? " (from the queue)" : "");
    qHead = (qHead + 1) % QUEUE_LEN;
    qCount--;
  }
}

// ================= Public =================

void netBegin() {
  if (strlen(WIFI_SSID) == 0) {
    Serial.println("[net] WIFI_SSID is empty in secrets.h - staying offline, bites print only.");
    return;
  }
  tls.setCACert(AWS_ROOT_CA);
  tls.setCertificate(DEVICE_CERT);
  tls.setPrivateKey(DEVICE_KEY);

  mqtt.setServer(AWS_IOT_ENDPOINT, MQTT_PORT);
  mqtt.setBufferSize(JSON_CAPACITY + 256);            // default 256 is smaller than one bite
  mqtt.setKeepAlive(60);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");  // UTC, no DST: the contract is UTC
  Serial.printf("[net] connecting to Wi-Fi \"%s\" ...\n", WIFI_SSID);
}

void netLoop(unsigned long now) {
  if (strlen(WIFI_SSID) == 0) return;

  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiTry >= WIFI_RETRY_MS) {
      lastWifiTry = now;
      wifiTries++;
      // Say which failure this is. WiFi.reconnect() while a join is already in
      // flight just logs "sta is connecting, return error", so start clean.
      Serial.printf("[net] wifi not up (attempt %d): %s\n", wifiTries, wifiStatus());
      WiFi.disconnect(true);
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

      // After a few tries, show what the radio can actually see. This is the
      // one check that separates "wrong password" from "the hotspot is 5 GHz
      // and this radio cannot see it at all". It blocks for ~2 s, once.
      if (wifiTries == 3 && !scanned) {
        scanned = true;
        Serial.println("[net] scanning for 2.4 GHz networks (the ESP32 cannot see 5 GHz)...");
        int n = WiFi.scanNetworks();
        for (int i = 0; i < n; i++)
          Serial.printf("      \"%s\"  %d dBm  ch%d%s\n", WiFi.SSID(i).c_str(), WiFi.RSSI(i),
                        WiFi.channel(i), WiFi.SSID(i) == WIFI_SSID ? "   <-- yours" : "");
        if (n == 0) Serial.println("      nothing found: no 2.4 GHz network in range.");
        WiFi.scanDelete();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      }
    }
    return;
  }
  if (wifiTries) {                                    // first success after failures
    Serial.printf("[net] wifi up: %s\n", WiFi.localIP().toString().c_str());
    wifiTries = 0;
  }
  syncClock();

  if (!mqtt.connected()) {
    if (now - lastMqttTry < MQTT_RETRY_MS) return;
    lastMqttTry = now;
    if (mqtt.connect(AWS_IOT_CLIENT_ID)) {
      Serial.printf("[net] connected to AWS IoT as %s\n", AWS_IOT_CLIENT_ID);
    } else {
      // rc -2 is a TLS failure: wrong certificate, wrong endpoint, or the
      // policy does not allow this client id.
      Serial.printf("[net] MQTT connect failed (rc=%d), retrying\n", mqtt.state());
      return;
    }
  }
  mqtt.loop();
  if (clockValid) drainQueue();                       // a bite with no clock has no timestamp
}

void netSendBite(const Bite &b, unsigned long gapMs, bool haveGap, bool tooFast) {
  // An un-dipped bite has no salinity, and bite/v2 has no way to say so: every
  // field in it is a measurement. It stays on the serial line only.
  if (!b.salinityMeasured) {
    Serial.println("[net] bite not sent: no dip, so there is no salinity to report.");
    return;
  }
  if (strlen(WIFI_SSID) == 0) return;

  if (qCount == QUEUE_LEN) {                          // oldest goes, newest stays
    qHead = (qHead + 1) % QUEUE_LEN;
    qCount--;
    dropped++;
    Serial.printf("[net] queue full, dropped the oldest bite (%lu lost so far)\n",
                  (unsigned long)dropped);
  }
  int tail = (qHead + qCount) % QUEUE_LEN;
  queue[tail] = Queued{ b, gapMs, haveGap, tooFast };
  qCount++;

  if (mqtt.connected() && clockValid) drainQueue();
  else Serial.printf("[net] offline, bite #%lu queued (%d waiting)\n",
                     (unsigned long)b.biteId, qCount);
}

bool netOnline() { return mqtt.connected(); }
int  netQueued() { return qCount; }

void netStatusLine() {
  if (strlen(WIFI_SSID) == 0) { Serial.println("[net] offline (no Wi-Fi configured)"); return; }
  Serial.printf("[net] wifi %s | clock %s | mqtt %s | queued %d\n",
                WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "down",
                clockValid ? "ok" : "waiting",
                mqtt.connected() ? "connected" : "down",
                qCount);
}
