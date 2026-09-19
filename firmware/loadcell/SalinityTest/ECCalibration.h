/*
 * ECCalibration.h - loads the EC probe calibration (saved by ECCalibrate.ino)
 * and converts probe voltage to conductivity.
 */
#ifndef EC_CALIBRATION_H
#define EC_CALIBRATION_H

void  ecBegin();                               // load saved K values from flash
float ecRead(float voltageMv, float tempC);    // mV + temp -> mS/cm at 25 C

#endif
