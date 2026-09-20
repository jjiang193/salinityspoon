/*
 * Uplink.h - WiFi + WebSocket to the backend, speaking bite/v2.
 *
 * Ported from firmware/spoon/spoon.ino, which had the transport but no load
 * cell. The wire format is docs/telemetry-schema.md and it is binding: this
 * file translates the load-cell Bite into it and invents nothing.
 *
 * Offline is a supported state, not an error. With no WiFi (or no secrets.h)
 * the sketch keeps detecting and printing bites over Serial, which is how you
 * bench it; the WebSocket client reconnects by itself when the network returns.
 * Bites taken while offline are NOT queued - see uplinkStats().
 */
#ifndef UPLINK_H
#define UPLINK_H

#include "BiteDetector.h"

void uplinkBegin();                    // connect WiFi, start NTP and the socket
void uplinkLoop();                     // every loop: services the WebSocket
bool uplinkConnected();                // socket is up right now
void uplinkPublish(const Bite &b, float biteIntervalSec, bool tooFast);
void uplinkStats(uint32_t &sent, uint32_t &dropped);   // dropped = taken offline

#endif
