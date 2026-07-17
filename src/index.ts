/**
 * @shimmerresearch/shimmer-web-sdk
 *
 * Web Bluetooth SDK for Shimmer sensor devices.
 *
 * Exports:
 * - {@link Shimmer3RClient} — Shimmer3R BLE client
 * - {@link Shimmer3Client} — classic-Bluetooth (RFCOMM/SPP) Shimmer3 client
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

// Transport abstraction (pluggable byte pipes)
export {
  WebBluetoothTransport,
  WebSerialTransport,
  LoopbackTransport,
} from './core/transport/index.js';
export type {
  ShimmerTransport,
  ShimmerTransportKind,
  TransportCapabilities,
  TransportWriteOptions,
  Unsubscribe,
  DiscoveredDevice,
  DeviceKind,
  TransportScanner,
  WebBluetoothTransportOptions,
  WebSerialTransportOptions,
  LoopbackTransportOptions,
  LoopbackWrite,
} from './core/transport/index.js';
export { isUniformByteArray } from './core/arrayBuffer.js';
export type {
  IShimmerClient,
  ShimmerClientOptions,
  SensorField,
  FieldKind,
  InertialCalibration,
} from './core/types.js';
export { csvCell } from './core/csv.js';
export { RtcDriftMonitor } from './core/RtcDriftMonitor.js';
export type {
  RtcDriftSampleInput,
  RtcDriftSample,
  RtcDriftSampleEvent,
  RtcDriftMonitorOptions,
} from './core/RtcDriftMonitor.js';
export { StreamStatsTracker } from './core/StreamStats.js';
export type {
  StreamContribution,
  StreamLossStats,
  SensorStreamStats,
  StreamStatsSnapshot,
} from './core/StreamStats.js';

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

// Shimmer3 (classic Bluetooth / RFCOMM)
export { Shimmer3Client } from './devices/shimmer3/Shimmer3Client.js';
export type { Shimmer3ClientOptions } from './devices/shimmer3/Shimmer3Client.js';
export {
  SHIMMER3_DEFAULTS,
  SHIMMER3_SPP_UUID,
  SHIMMER3_SAMPLING_CLOCK_FREQ,
} from './devices/shimmer3/constants.js';
export {
  FW_ID,
  ACK as SHIMMER3_ACK,
  NACK as SHIMMER3_NACK,
  NEED_MORE as SHIMMER3_NEED_MORE,
  RESYNC as SHIMMER3_RESYNC,
  SHIMMER3_RESPONSE_PAYLOAD_LENGTHS,
  SHIMMER3_INQ_CONFIG_OFFSET,
  SHIMMER3_INQ_CONFIG_LENGTH,
  SHIMMER3_INQ_NUM_CHANNELS_OFFSET,
  SHIMMER3_INQ_CHANNELS_OFFSET,
  interpretShimmer3InquiryResponse,
  buildShimmer3Schema,
  parseShimmer3DeviceVersionResponse,
  parseShimmer3FwVersionResponse,
  shimmer3UsesThreeByteTimestamp,
  shimmer3ControlMessageLength,
} from './devices/shimmer3/protocol.js';
export type {
  Shimmer3InquiryResult,
  Shimmer3StreamSchema,
  Shimmer3ChannelField,
  Shimmer3DeviceVersion,
  Shimmer3FwVersion,
} from './devices/shimmer3/protocol.js';

// Wired / dock UART (Shimmer docked in a BasicDock/Base)
export { WiredShimmerClient } from './devices/dock/WiredShimmerClient.js';
export type {
  WiredShimmerClientOptions,
  WiredIdentity,
} from './devices/dock/WiredShimmerClient.js';
export {
  UART_PACKET_HEADER,
  UART_DOCK_BAUD_RATE,
  UART_PACKET_CMD,
  UART_COMPONENT,
  UART_PROP,
  UART_CONFIG_COMMANDS,
  PACKET_OVERHEAD_RESPONSE_DATA,
  PACKET_OVERHEAD_RESPONSE_OTHER,
  WIRED_DEFAULTS,
  CHARGING_STATUS_BYTE,
} from './devices/dock/constants.js';
export type {
  UartPacketCmd,
  UartComponent,
  UartPermission,
  UartComponentProperty,
  ChargingStatus,
} from './devices/dock/constants.js';
export {
  SHIMMER_UART_CRC_INIT,
  shimmerUartCrcByte,
  shimmerUartCrcCalc,
  shimmerUartCrcCheck,
} from './devices/dock/crc.js';
export {
  buildUartPacket,
  buildReadPacket,
  buildWritePacket,
  buildMemReadPayload,
  buildMemWritePayload,
  parseUartPacket,
  wiredPacketLength,
  isBadResponse,
  badResponseReason,
  parseMacId,
  parseVersionInfo,
  parseBatteryStatus,
  battAdcToVoltage,
  battVoltageToPercentage,
  parseExpansionBoard,
  NEED_MORE as WIRED_NEED_MORE,
  RESYNC as WIRED_RESYNC,
} from './devices/dock/protocol.js';
export type {
  UartRxPacket,
  WiredVersionInfo,
  WiredBatteryStatus,
  ExpansionBoardInfo,
} from './devices/dock/protocol.js';

// SmartDock multi-slot base (Base-6 / Base-15) — phase D2
export { SmartDockClient } from './devices/dock/SmartDockClient.js';
export type {
  SmartDockClientOptions,
  SmartDockInfo,
  SlotOccupancy,
} from './devices/dock/SmartDockClient.js';
export {
  SMARTDOCK_LINE_TERMINATOR,
  SMARTDOCK_CONNECTION_TYPE,
  SMARTDOCK_BASE_CMD,
  SMARTDOCK_DEFAULTS,
  BASE_HARDWARE_IDS,
  baseHardwareType,
  buildBaseCommand,
  buildSelectSlotCommand,
  extractBaseLine,
  classifyBaseResponse,
  parseSmartDockVersion,
  parseSlotOccupancy,
  parseActiveSlot,
} from './devices/dock/smartDockProtocol.js';
export type {
  SmartDockConnectionType,
  SmartDockHardwareType,
  SmartDockResponseKind,
  SmartDockVersionInfo,
  SmartDockActiveSlot,
} from './devices/dock/smartDockProtocol.js';

// Binary SD-log file decoder (Shimmer3 / Shimmer3R) — phase D3
export {
  SDLOG_HW_ID,
  SDLOG_FW_ID,
  SDLOG_HEADER_LENGTH,
  SDLOG_CLOCK_FREQ,
  SDLOG_SYNC_OFFSET_LENGTH,
  SDLOG_SYNC_BLOCK_LENGTH,
  SDLogHeaderBitmask,
  hasSensorBit,
  SdLogFormatError,
  decodeSdLogValue,
  SDLOG_DATA_TYPE_BYTES,
  parseSdLogHeader,
  decodeSdLogFile,
  decodeSdSession,
  parseSdSessionName,
  parseSdTrialFolderName,
} from './devices/sdlog/index.js';
export type {
  SdLogChannel,
  SdLogHeader,
  SdLogRecord,
  SdLogFormatErrorCode,
  SdLogCalibrationBytes,
  SdLogExpansionBoard,
  SdLogDataType,
  SdLogChannelSpec,
  SdLogDecodeOptions,
  SdLogDecodeResult,
} from './devices/sdlog/index.js';

// Verisense
export { VerisenseBleDevice } from './devices/verisense/VerisenseClient.js';
export type {
  BleLinkAutoOptimizeSample,
  BleLinkAutoOptimizeOptions,
  BleLinkAutoOptimizeResult,
  BleLinkAutoOptimizeStopReason,
  BleThroughputTestOptions,
  BleThroughputTestResult,
  VerisenseConnectWithRetryOptions,
  VerisenseConnectRetryInfo,
  VerisenseClientOptions,
  RunHardwareTestReportOptions,
  TransportKind,
  DeviceMode,
  SensorMap,
  StreamPacket,
  TransferLoggedDataOptions,
  TransferLoggedDataResult,
  VerisenseCommandResponse,
} from './devices/verisense/VerisenseClient.js';
export {
  NUS_SERVICE,
  NUS_TX,
  NUS_RX,
  NORDIC_DFU_SERVICE,
  NORDIC_DFU_BUTTONLESS_WITHOUT_BONDS,
  NORDIC_DFU_BUTTONLESS_WITH_BONDS,
  NORDIC_DFU_OP_ENTER_BOOTLOADER,
  OP_IDX,
  ASM_COMMAND,
  ASM_PROPERTY,
  STREAM_MODE,
  TEST_MODE_ID,
  DEBUG_COMMAND_ID,
  BLE_LINK_MIN_FW,
  VERISENSE_STREAM_SENSOR_LABELS,
} from './devices/verisense/constants.js';
export type {
  OpIdx,
  AsmCommand,
  AsmProperty,
  TestModeId,
  DebugCommandId,
} from './devices/verisense/constants.js';
export {
  buildHeader,
  parseHeader,
  buildMessage,
  parseMessage,
  parsePendingEvents,
  isAckCommand,
  isNackCommand,
  crc16_ccitt_false,
  computeVerisensePairingPin,
  unixSecondsToAsmRtcBytes,
  asmRtcBytesToUnixSeconds,
  asmRtcMinutesBytesToUnixSeconds,
  normalizeBytePayload,
  normalizeOperationalConfig,
  buildProductionConfigPayload,
  parseSchedulerDebugPayload,
  parsePayloadCrcErrorBankIndexes,
  parseEventLogPayload,
  parseRecordBufferDetailsPayload,
  parseBleLinkDebugPayload,
  parseLookupTablePayload,
  buildUploadBinaryFileName,
  buildParsedCsvFileName,
  applyDuplicateSuffix,
  nextAvailableDuplicateFileName,
  getFirstPayloadIndex,
  evaluateParsedFileSplit,
  parseProductionConfigPayload,
  parseProductionConfigPayloadFull,
  parseStatusPayload,
  VERISENSE_OPERATIONAL_FIELD_SCHEMA,
  VERISENSE_OP_CONFIG_BYTE_SIZE,
  createBlankVerisenseOperationalConfig,
  readVerisenseOperationalFieldValue,
  writeVerisenseOperationalFieldValue,
  setVerisenseOperationalBitRange,
  enforceVerisenseCommsChannelInterlock,
  VERISENSE_SENSOR_ENABLE_FIELDS,
  VERISENSE_OPERATIONAL_FIELD_GROUPS,
  VERISENSE_OPERATIONAL_FIELD_FALLBACK_GROUP_ID,
  VERISENSE_OPERATIONAL_FIELD_GROUP_SENSOR,
  getVerisenseSupportedOperationalFieldGroupIds,
  VERISENSE_HW_MAJOR_FRIENDLY_NAMES,
  getVerisenseHardwareFriendlyName,
  formatVerisenseHardwareRevision,
  isVerisenseSecondGenerationHardware,
  getVerisenseHardwareCapabilities,
  getVerisenseHardwareSensorSupport,
  getVerisenseHardwareRevision,
  supportsVerisenseMagnetometer,
  getVerisenseStreamingBatteryVoltageMultiplier,
  formatByteAsHex,
  formatByteArrayAsHex,
  parseHexByteString,
  formatPendingEventProperties,
  formatVerisenseUnixAndHuman,
  inferVerisenseChargerChipFamily,
  describeVerisenseChargerStatus,
  formatVerisenseChargerStatus,
  formatStatusPayloadForLog,
  formatSchedulerPayloadForLog,
  compareVerisenseFirmwareVersion,
  formatVerisenseFirmwareVersion,
  getVerisenseStreamSensorLabel,
  inferVerisenseLookupBankCount,
  isVerisenseLightDarkChannelEnabled,
  VERISENSE_MAX_PLAUSIBLE_UNIX_SECONDS,
  decodeVerisenseBleOptimizationResult,
  VERISENSE_DEFAULT_PASSKEY_BY_ID,
  defaultVerisensePasskeyForId,
  buildVerisenseAdvertisedName,
  parseVerisenseAdvertisedName,
  deriveVerisenseMacIdFromName,
  verisenseDeviceFileTag,
  padVerisenseOperationalConfig,
  VERISENSE_SENSOR_RATE_DEFAULT_GROUPS,
  resolveVerisenseSensorRateFieldKey,
  VERISENSE_BLE_SYNC_SCHEDULES,
  VERISENSE_BLE_SCHEDULE_RANGES,
  VERISENSE_BLE_SCHEDULE_DEFAULTS,
  minutesSinceMidnightToHHMM,
  hhmmToMinutesSinceMidnight,
  expectedVerisenseStreamSensorIds,
  expectedVerisenseStreamSensorIdsFromConfig,
} from './devices/verisense/protocol.js';
export type {
  VerisenseBleOptimizationResult,
  VerisenseAdvertisedNameParts,
  VerisenseImuGeneration,
  VerisenseSensorRateDefaultField,
  VerisenseSensorRateDefaultGroup,
  VerisenseBleSyncSchedule,
  VerisenseStreamSensorEnables,
} from './devices/verisense/protocol.js';

// Verisense Nordic Secure-DFU flow (DEV-845)
export {
  VERISENSE_DFU_TRANSIENT_ERROR_REGEX,
  VERISENSE_DFU_CONNECT_ATTEMPTS,
  VERISENSE_DFU_RETRY_DELAY_MS,
  VERISENSE_DFU_REBOOT_DELAY_MS,
  VERISENSE_DFU_SET_MODE_TIMEOUT_MS,
  VERISENSE_DFU_RELIABLE_PACKET_DELAY_MS,
  VERISENSE_DFU_FAST_PACKET_DELAY_MS,
  VERISENSE_DFU_BOOTLOADER_NAME_PREFIX,
  VERISENSE_DFU_ROUTINE_LOG_REGEX,
  isRoutineVerisenseDfuLogMessage,
  verisenseDfuAttemptLabel,
  patchSecureDfuSendOperation,
  classifyVerisenseDfuError,
  promiseWithTimeout,
  isSafeFirmwareArchiveName,
  buildVerisenseDfuRequestDeviceOptions,
  setVerisenseDfuModeWithRetry,
  updateVerisenseDfuImageWithRetry,
  runVerisenseDfuUpdate,
} from './devices/verisense/dfu.js';
export type {
  VerisenseDfuImage,
  VerisenseDfuPackage,
  SecureDfuLike,
  VerisenseDfuErrorCategory,
  VerisenseDfuErrorInfo,
  VerisenseDfuRetryInfo,
  VerisenseDfuFlowOptions,
} from './devices/verisense/dfu.js';
export {
  parseCalibrationBlob,
  serializeCalibrationBlob,
  calibrationBlobCrc,
  applyImuCalibration,
  CalibSensorId,
  CalibQuality,
  SC_CALIB_FORMAT_VERSION,
  SC_GLOBAL_HEADER_BYTES,
  SC_DATA_LEN_IMU,
  SC_CAL_RANGE_MASK,
  SC_CAL_QUALITY_SHIFT,
  SC_CAL_QUALITY_MASK,
} from './devices/verisense/calibration.js';
export type {
  CalibrationSet,
  CalibrationBlock,
  CalibrationSetInput,
  CalibrationBlockInput,
  ImuCalibration,
} from './devices/verisense/calibration.js';
export {
  VERISENSE_CALIBRATION_MIN_FW,
  supportsVerisenseCalibration,
  unixSecondsToCalibTsBytes,
  calibTsBytesToUnixSeconds,
  getVerisenseCalibrationSensors,
  buildDefaultVerisenseCalibrationSet,
  getVerisenseCalibrationSensorAvailability,
} from './devices/verisense/calibrationDefaults.js';
export type {
  VerisenseCalibrationRange,
  VerisenseCalibrationSensor,
  VerisenseCalibrationAvailability,
} from './devices/verisense/calibrationDefaults.js';
export type {
  ProductionConfig,
  ProductionConfigBuildOptions,
  ProductionConfigFull,
  VerisenseSchedulerDebugPayload,
  VerisenseBleLinkDebugPayload,
  VerisenseEventLogEntry,
  VerisenseRecordBufferDetails,
  VerisenseLookupTableEntry,
  VerisenseLookupTablePayload,
  ParsedSplitReason,
  EvaluateParsedSplitInput,
  VerisenseStatusPayload,
  VerisenseMessage,
  VerisenseOperationalFieldKind,
  VerisenseOperationalFieldOption,
  VerisenseOperationalFieldDefinition,
  VerisenseOperationalField,
  VerisenseOperationalSensorEnableField,
  VerisenseOperationalFieldGroupDefinition,
  PendingEventPropertyLabel,
  VerisenseUnixAndHumanTimestamp,
  VerisenseStatusPayloadForLog,
  VerisenseChargerChipFamily,
  VerisenseSchedulerDebugPayloadForLog,
  VerisenseHardwareCapabilities,
  VerisenseHardwareSensorSupport,
  VerisenseHardwareRevision,
  VerisenseHardwareRevisionSource,
  VerisenseFirmwareVersion,
} from './devices/verisense/protocol.js';

// Verisense sensors
export { SensorBase } from './devices/verisense/sensors/SensorBase.js';
export { SensorADC } from './devices/verisense/sensors/SensorADC.js';
export type {
  ADCGSRSample,
  ADCBatterySample,
  ADCPayloadSample,
} from './devices/verisense/sensors/SensorADC.js';
export { SensorLIS2DW12 } from './devices/verisense/sensors/SensorLIS2DW12.js';
export type { LIS2DW12Sample } from './devices/verisense/sensors/SensorLIS2DW12.js';
export { SensorLSM6DS3 } from './devices/verisense/sensors/SensorLSM6DS3.js';
export type { LSM6DS3Sample } from './devices/verisense/sensors/SensorLSM6DS3.js';
export { SensorLSM6DSV } from './devices/verisense/sensors/SensorLSM6DSV.js';
export type { LSM6DSVSample } from './devices/verisense/sensors/SensorLSM6DSV.js';
export { SensorPPG } from './devices/verisense/sensors/SensorPPG.js';
export type { PPGSample, PPGChannelSample } from './devices/verisense/sensors/SensorPPG.js';
export { SensorVD6283 } from './devices/verisense/sensors/SensorVD6283.js';
export type { VD6283Sample } from './devices/verisense/sensors/SensorVD6283.js';
export { SensorMAX32674 } from './devices/verisense/sensors/SensorMAX32674.js';
export type { MAX32674Sample } from './devices/verisense/sensors/SensorMAX32674.js';
export { SensorMLX90632 } from './devices/verisense/sensors/SensorMLX90632.js';
export type { MLX90632Sample } from './devices/verisense/sensors/SensorMLX90632.js';
