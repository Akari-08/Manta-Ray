#pragma once
#include <Arduino.h>
#if __has_include("local_config.h")
#include "local_config.h"
#endif
// All pins, calibration and operating policy live here (or local_config.h overrides).
// Freenove WROVER camera, NOT the AI Thinker ESP32-CAM pin map.
namespace Config {
constexpr int CAM_PWDN=-1, CAM_RESET=-1, CAM_XCLK=21, CAM_SDA=26, CAM_SCL=27;
constexpr int CAM_D0=4, CAM_D1=5, CAM_D2=18, CAM_D3=19, CAM_D4=36, CAM_D5=39, CAM_D6=34, CAM_D7=35;
constexpr int CAM_VSYNC=25, CAM_HREF=23, CAM_PCLK=22;
constexpr int FIN_LEFT_PIN=13, FIN_RIGHT_PIN=14, IMU_SDA=32, IMU_SCL=33;
constexpr uint8_t IMU_ADDRESS=0x68;
#if CONFIG_SCCB_HARDWARE_I2C_PORT1
constexpr int IMU_I2C_PORT=0;
#else
constexpr int IMU_I2C_PORT=1;
#endif
// No LEDC servo library: camera owns LEDC timer 0/channel 0. Servos use MCPWM group 0.
#ifndef MANTA_ENABLE_FIN_OUTPUTS
#define MANTA_ENABLE_FIN_OUTPUTS 0
#endif
#ifndef MANTA_FIN_CALIBRATION_CONFIRMED
#define MANTA_FIN_CALIBRATION_CONFIRMED 0
#endif
#ifndef MANTA_FIN_MIN_US
#define MANTA_FIN_MIN_US 500
#endif
#ifndef MANTA_FIN_MAX_US
#define MANTA_FIN_MAX_US 2500
#endif
// Provisional 270-degree mapping; do not enable until verified with unloaded horns.
constexpr bool FIN_OUTPUTS=MANTA_ENABLE_FIN_OUTPUTS && MANTA_FIN_CALIBRATION_CONFIRMED;
constexpr int FIN_MIN_US=MANTA_FIN_MIN_US, FIN_MAX_US=MANTA_FIN_MAX_US;
constexpr float FIN_TRAVEL_DEG=270, FIN_MIN_DEG=45, FIN_MAX_DEG=225;
constexpr float AMP_MAX=45, HZ_MIN=0.1f, HZ_MAX=2, CENTRE_MIN=90, CENTRE_MAX=180;
constexpr float LEFT_DIRECTION=1, RIGHT_DIRECTION=-1;
constexpr float LEFT_TRIM_DEG=0, RIGHT_TRIM_DEG=0;
#ifndef MANTA_STOP_ON_TIMEOUT
#define MANTA_STOP_ON_TIMEOUT 1
#endif
constexpr bool STOP_ON_TIMEOUT=MANTA_STOP_ON_TIMEOUT;
constexpr uint32_t HEARTBEAT_TIMEOUT_MS=3000, TELEMETRY_MS=100, SENSOR_MS=10, WATER_MS=1000;
// Unconfirmed servo: disabled, no PWM until a deliberate target command.
// GPIO15 is only an OPTIONAL candidate after checking boot strapping/load and board revision.
#ifndef MANTA_SYRINGE_PIN
#define MANTA_SYRINGE_PIN -1
#endif
#ifndef MANTA_SYRINGE_CALIBRATION_CONFIRMED
#define MANTA_SYRINGE_CALIBRATION_CONFIRMED 0
#endif
#ifndef MANTA_SYRINGE_MIN_US
#define MANTA_SYRINGE_MIN_US 0
#endif
#ifndef MANTA_SYRINGE_MAX_US
#define MANTA_SYRINGE_MAX_US 0
#endif
#ifndef MANTA_SYRINGE_TRAVEL_DEG
#define MANTA_SYRINGE_TRAVEL_DEG 0
#endif
#ifndef MANTA_SYRINGE_MIN_DEG
#define MANTA_SYRINGE_MIN_DEG 0
#endif
#ifndef MANTA_SYRINGE_MAX_DEG
#define MANTA_SYRINGE_MAX_DEG 0
#endif
constexpr int SYRINGE_PIN=MANTA_SYRINGE_PIN, SYRINGE_MIN_US=MANTA_SYRINGE_MIN_US, SYRINGE_MAX_US=MANTA_SYRINGE_MAX_US;
constexpr float SYRINGE_TRAVEL=MANTA_SYRINGE_TRAVEL_DEG, SYRINGE_MIN=MANTA_SYRINGE_MIN_DEG, SYRINGE_MAX=MANTA_SYRINGE_MAX_DEG;
constexpr bool SYRINGE_ENABLED=MANTA_SYRINGE_CALIBRATION_CONFIRMED && SYRINGE_PIN==15;
// Biases in sensor axes, m/s^2 and deg/s. Zero means uncalibrated, not factory accuracy.
constexpr float ACCEL_BIAS[3]={0,0,0}, GYRO_BIAS[3]={0,0,0};
constexpr bool IMU_CALIBRATED=false;
constexpr const char* CAMERA_CALIBRATION_ID=nullptr;
constexpr int CAMERA_JPEG_QUALITY=14, CAMERA_STREAM_INTERVAL_MS=150;
static_assert(!MANTA_ENABLE_FIN_OUTPUTS || MANTA_FIN_CALIBRATION_CONFIRMED, "Confirm fin calibration before enabling outputs");
static_assert(FIN_MIN_US>=400 && FIN_MAX_US<=2600 && FIN_MIN_US<FIN_MAX_US, "Invalid fin pulse bounds");
static_assert(!SYRINGE_ENABLED || (SYRINGE_MIN_US>=400 && SYRINGE_MAX_US<=2600 && SYRINGE_MAX_US>SYRINGE_MIN_US && SYRINGE_TRAVEL>0 && SYRINGE_MIN>=0 && SYRINGE_MAX<=180 && SYRINGE_MAX<=SYRINGE_TRAVEL && SYRINGE_MAX>SYRINGE_MIN), "Configure confirmed syringe limits");
static_assert(SYRINGE_PIN==-1 || SYRINGE_PIN==15, "Re-audit all camera, PSRAM and strapping pins before selecting another syringe pin");
}
