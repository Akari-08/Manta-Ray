#pragma once
// Copy to local_config.h. Safe defaults. Replace calibration with measured endpoints.
#define MANTA_ENABLE_FIN_OUTPUTS 0
#define MANTA_FIN_CALIBRATION_CONFIRMED 0
#define MANTA_FIN_MIN_US 500
#define MANTA_FIN_MAX_US 2500
#define MANTA_STOP_ON_TIMEOUT 1
// Remains disabled until the model, boot-pin loading and all calibration are confirmed.
#define MANTA_SYRINGE_PIN -1
#define MANTA_SYRINGE_CALIBRATION_CONFIRMED 0
#define MANTA_SYRINGE_MIN_US 0
#define MANTA_SYRINGE_MAX_US 0
#define MANTA_SYRINGE_TRAVEL_DEG 0
#define MANTA_SYRINGE_MIN_DEG 0
#define MANTA_SYRINGE_MAX_DEG 0
