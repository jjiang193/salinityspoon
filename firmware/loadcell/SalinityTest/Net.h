/*
 * Net.h - Wi-Fi, clock, and bites to AWS IoT Core over MQTT/TLS.
 *
 * The spoon publishes one `bite/v2` message per bite to devices/<id>/bites.
 * That contract is docs/telemetry-schema.md in the team repo; the AWS side of
 * it is docs/loadcell/aws-handoff.md. Nothing else ever leaves the device: no
 * raw samples, no motion data, no patient identity. The cloud adds the patient
 * from the device's pairing.
 *
 * Everything here is non-blocking. The loop must keep running at 50 Hz whether
 * the network is up, down or half way through a TLS handshake, because the LED
 * and the bite detector do not care that the Wi-Fi dropped.
 *
 * Bites survive a drop: they queue in RAM (QUEUE_LEN of them) and go out when
 * the link returns. The queue is lost on reboot - a flash-backed store is the
 * next step if that matters.
 *
 * Credentials live in secrets.h, which is never committed.
 */
#ifndef NET_H
#define NET_H

#include "BiteDetector.h"

#define QUEUE_LEN        24     // bites held while offline (~25 minutes of eating)
#define FW_VERSION       "0.3.0"
#define MQTT_PORT        8883
#define MQTT_RETRY_MS    5000   // between connection attempts
#define WIFI_RETRY_MS   10000
#define JSON_CAPACITY    768    // one bite is ~450 bytes; the handoff doc says give it 768

void netBegin();                        // start Wi-Fi + NTP. Returns immediately
void netLoop(unsigned long now);        // every loop: connect, keep alive, drain the queue
void netSendBite(const Bite &b, unsigned long gapMs, bool haveGap, bool tooFast);
bool netOnline();                       // MQTT connected right now
int  netQueued();                       // bites waiting to go out
void netStatusLine();                   // one line for the debug print

#endif
