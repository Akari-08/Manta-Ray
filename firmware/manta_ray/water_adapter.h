#pragma once
#include <math.h>
// Integration contract, not a sensor-model assumption. Called by sensor task at 1 Hz.
// Keep calls bounded (<50 ms), configure I2C timeouts, never use ADC2 while Wi-Fi runs.
// Camera + MPU use all broken-out ADC1 inputs. A verified external ADC or pin redesign
// is required for analog TDS. Do not wire an unknown analog voltage into an ESP32 pin.
struct WaterSample {
  float temperature=NAN, tdsRaw=NAN, tdsPpm=NAN;
  const char* temperatureReason="Temperature sensor model unconfirmed";
  const char* rawReason="TDS voltage range and ADC interface unconfirmed";
  const char* ppmReason="TDS calibration unavailable";
  const char* calibrationId=nullptr;
};
inline WaterSample readWaterAdapter() {
  // Replace only after confirming model, supply/output voltages, bus/pins, units and
  // calibration standards. Return NAN plus a reason on failure; no generic ppm formula.
  return WaterSample{};
}
