/*
 * LoadCellCalibrate.ino - finds LOADCELL_SCALE for SalinityTest/Sensors.h.
 * Follows "How to calibrate your load cell" in the HX711 README (github.com/bogde/HX711).
 *
 * Serial Monitor: 115200 baud, line ending "Newline".
 *   1. Boot with the bowl attached and empty (it zeros).
 *   2. Put a known weight in the bowl (under 100 g), type its grams, press Enter.
 *   3. Copy the printed LOADCELL_SCALE into Sensors.h. Live weight prints to check it.
 */
#include "HX711.h"

#define HX711_DT_PIN   16
#define HX711_SCK_PIN  17

HX711 scale;

void setup() {
  Serial.begin(115200);
  scale.begin(HX711_DT_PIN, HX711_SCK_PIN);
  if (!scale.wait_ready_timeout(1000)) {
    Serial.println("HX711 not found.");
    while (1) delay(10);
  }
  scale.set_scale();                   // no scale yet: readings are raw counts
  scale.tare();                        // zero with the bowl empty
  Serial.println("Place a known weight, then type its grams:");
}

void loop() {
  // Grams typed in: counts per gram = counts with the weight / grams
  if (Serial.available()) {
    float grams = Serial.readStringUntil('\n').toFloat();
    if (grams > 0) {
      float factor = scale.get_units(10) / grams;
      scale.set_scale(factor);
      Serial.printf("LOADCELL_SCALE = %.2f  (negative is fine, the cell is just mounted flipped)\n", factor);
    }
  }

  // Live weight to check the factor
  if (scale.wait_ready_timeout(200)) Serial.printf("weight: %.1f\n", scale.get_units(5));
  delay(500);
}
