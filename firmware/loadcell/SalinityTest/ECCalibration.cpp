/*
 * ECCalibration.cpp - thin wrapper around DFRobot_EC (wiki.dfrobot.com/dfr0300/docs/20349).
 */
#include "ECCalibration.h"
#include <EEPROM.h>
#include <DFRobot_EC.h>

static DFRobot_EC ec;

void ecBegin() {
  EEPROM.begin(32);   // ESP32 EEPROM lives in flash: open it before ec.begin() reads K
  ec.begin();
}

float ecRead(float voltageMv, float tempC) {
  return ec.readEC(voltageMv, tempC);          // includes temperature compensation
}
