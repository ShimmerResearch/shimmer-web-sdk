/**
 * @shimmerresearch/shimmer-web-sdk
 *
 * Web Bluetooth SDK for Shimmer sensor devices.
 *
 * Exports:
 * - {@link Shimmer3RClient} — Shimmer3R BLE client
 * - {@link VerisenseBleDevice} — Verisense BLE + Web Serial client
 * - {@link ObjectCluster} — shared sensor data frame container
 * - {@link SensorBitmapShimmer3} — Shimmer3R sensor enable bitmasks
 * - {@link BaseShimmerClient} — abstract base class for custom device clients
 *
 * @packageDocumentation
 */

// Core
export { ObjectCluster } from './core/ObjectCluster.js';
export { BaseShimmerClient } from './core/BaseShimmerClient.js';
export type {
  IShimmerClient,
  ShimmerClientOptions,
  SensorField,
  FieldKind,
  InertialCalibration,
} from './core/types.js';

// Shimmer3R
export { Shimmer3RClient } from './devices/shimmer3r/Shimmer3RClient.js';
export type { Shimmer3RClientOptions } from './devices/shimmer3r/Shimmer3RClient.js';
export { SensorBitmapShimmer3 } from './devices/shimmer3r/SensorBitmap.js';
export type { SensorBitmapShimmer3Key } from './devices/shimmer3r/SensorBitmap.js';
export {
  OPCODES,
  SHIMMER3R_DEFAULTS,
  TIMESTAMP_FIELD,
  GSR_NAME,
} from './devices/shimmer3r/constants.js';
export type { TimestampFmt, Opcode } from './devices/shimmer3r/constants.js';
export { CHANNEL_FORMATS } from './devices/shimmer3r/channelFormats.js';
export type { ChannelFormat } from './devices/shimmer3r/channelFormats.js';
export {
  calibrateU12AdcValue,
  calibrateShimmer3RAdcChannel,
  calibrateGsrDataToResistanceFromAmplifierEq,
  nudgeGsrResistance,
  getOversamplingRatioADS1292R,
} from './devices/shimmer3r/calibration.js';

// Verisense
export { VerisenseBleDevice } from './devices/verisense/VerisenseClient.js';
export type {
  VerisenseClientOptions,
  TransportKind,
  DeviceMode,
  SensorMap,
  StreamPacket,
  TransferLoggedDataOptions,
  TransferLoggedDataResult,
} from './devices/verisense/VerisenseClient.js';
export { NUS_SERVICE, NUS_TX, NUS_RX, OP_IDX } from './devices/verisense/constants.js';
export type { OpIdx } from './devices/verisense/constants.js';
export {
  crc16_ccitt_false,
  normalizeOperationalConfig,
  parseProductionConfigPayload,
} from './devices/verisense/protocol.js';
export type { ProductionConfig } from './devices/verisense/protocol.js';

// Verisense sensors
export { SensorBase } from './devices/verisense/sensors/SensorBase.js';
export { SensorGSR } from './devices/verisense/sensors/SensorGSR.js';
export type {
  GSRSample,
  GSRBatterySample,
  GSRPayloadSample,
} from './devices/verisense/sensors/SensorGSR.js';
export { SensorLIS2DW12 } from './devices/verisense/sensors/SensorLIS2DW12.js';
export type { LIS2DW12Sample } from './devices/verisense/sensors/SensorLIS2DW12.js';
export { SensorLSM6DS3 } from './devices/verisense/sensors/SensorLSM6DS3.js';
export type { LSM6DS3Sample } from './devices/verisense/sensors/SensorLSM6DS3.js';
export { SensorPPG } from './devices/verisense/sensors/SensorPPG.js';
export type { PPGSample, PPGChannelSample } from './devices/verisense/sensors/SensorPPG.js';
