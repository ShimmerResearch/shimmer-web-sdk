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
export { SDK_VERSION } from './version.js';
export { ObjectCluster } from './core/ObjectCluster.js';
export { BaseShimmerClient } from './core/BaseShimmerClient.js';

// Platform capability + guidance (gate on capability, message on platform)
export {
  describePlatformSupport,
  transportAvailability,
  transportAdvice,
} from './core/platformSupport.js';
export type {
  PlatformSupport,
  NavigatorLike,
  TransportNeed,
  Availability,
} from './core/platformSupport.js';

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
// CSV emission for decoded frames. Fix the column set once with
// `objectClusterColumns`, then project every frame with `objectClusterRow`: a
// per-frame column set shifts cells the moment a frame's field list differs.
export { csvCell, csvRow, objectClusterColumns, objectClusterRow } from './core/csv.js';
export type { ObjectClusterColumn, ObjectClusterColumnOptions } from './core/csv.js';
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
export { SensorBitmapShimmer3, channelIdToSensorBit } from './devices/shimmer3r/SensorBitmap.js';
export type { SensorBitmapShimmer3Key } from './devices/shimmer3r/SensorBitmap.js';
export {
  OPCODES,
  BT_FEATURE,
  SHIMMER3R_DEFAULTS,
  TIMESTAMP_FIELD,
  GSR_NAME,
} from './devices/shimmer3r/constants.js';
export type { TimestampFmt, Opcode } from './devices/shimmer3r/constants.js';
// Message framing for a Shimmer3R over an unframed byte stream (Web Serial, or
// the COM port a classic-Bluetooth pairing creates) — needed only when writing
// a custom transport; the clients apply it themselves.
//
// NEED_MORE / RESYNC are the canonical sentinels every framer returns. The
// SHIMMER3_* and WIRED_* aliases further down are the older per-device copies,
// kept for compatibility and identical in value.
export { NEED_MORE, RESYNC, drainByteStream } from './core/framing.js';
export type {
  MessageLengthFn,
  DrainVerdict,
  DropReason,
  DrainOptions,
  DrainResult,
} from './core/framing.js';
export {
  shimmer3rControlMessageLength,
  SHIMMER3R_RESPONSE_PAYLOAD_LENGTHS,
  SHIMMER3R_INQ_NUM_CHANNELS_OFFSET,
  SHIMMER3R_INQ_CHANNELS_OFFSET,
} from './devices/shimmer3r/streamFraming.js';
/** Per-platform length input the STATUS_RESPONSE span needs (Shimmer3R 2 bytes, Shimmer3 1). */
export type { Shimmer3RFramingOptions } from './devices/shimmer3r/streamFraming.js';
/**
 * Decode a STATUS_RESPONSE payload — what the sensor is doing right now
 * (docked / sensing / logging / streaming / SD present / RTC set). Shared by
 * both families: `Shimmer3RClient.getStatus` and the unsolicited pushes the
 * firmware sends when any of those change.
 */
export { parseShimmer3StatusBytes } from './devices/shimmer3r/protocol.js';
export type { Shimmer3DeviceStatus } from './devices/shimmer3r/protocol.js';
export {
  CHANNEL_FORMATS,
  CHANNEL_FORMAT_OVERRIDES,
  UNKNOWN_CHANNEL_ASSUMED_BYTES,
  isGenerationSensitiveChannel,
  channelLayoutDiffersByGeneration,
  channelFormatsFor,
  resolveChannelFormat,
  generationFromHardwareVersion,
} from './devices/shimmer3r/channelFormats.js';
export type { ChannelFormat, ShimmerGeneration } from './devices/shimmer3r/channelFormats.js';
/**
 * The generation-aware stream-schema builder both clients use. `trusted` on the
 * result says whether the byte offsets can be relied on — see
 * {@link StreamSchemaBase.trusted}.
 */
export { buildStreamSchema } from './devices/shimmer3r/streamSchema.js';
export type {
  StreamSchemaBase,
  StreamSchemaField,
  BuildStreamSchemaOptions,
} from './devices/shimmer3r/streamSchema.js';
export {
  calibrateU12AdcValue,
  calibrateShimmer3RAdcChannel,
  calibrateGsrDataToResistanceFromAmplifierEq,
  nudgeGsrResistance,
  getOversamplingRatioADS1292R,
} from './devices/shimmer3r/calibration.js';

// Factory self-test — the suite the firmware runs at the factory, driven over
// Bluetooth (`Shimmer3RClient.runFactoryTest`) or the dock UART
// (`WiredShimmerClient.runFactoryTest`). The type table and the LiteProtocol
// ACK classifier are pure; the runner state machine is inside the clients.
export {
  SHIMMER3_FACTORY_TEST_TYPE,
  SHIMMER3_FACTORY_TEST_TYPES,
  shimmer3FactoryTestTypeInfo,
  requireShimmer3FactoryTestType,
  buildSetFactoryTestCommand,
  classifyLiteProtocolAck,
} from './devices/shimmer3r/factoryTest.js';
export type {
  Shimmer3FactoryTestType,
  Shimmer3FactoryTestTypeInfo,
} from './devices/shimmer3r/factoryTest.js';
export {
  FactoryTestError,
  FACTORY_TEST_NACK_MESSAGE,
  FACTORY_TEST_ACK_TIMEOUT_MS,
  FACTORY_TEST_IDLE_FLOOR_MS,
  FACTORY_TEST_DRAIN_IDLE_MS,
} from './devices/factoryTest/capture.js';
export type {
  FactoryTestState,
  FactoryTestFailureReason,
  FactoryTestRunOptions,
  AckVerdict,
} from './devices/factoryTest/capture.js';

// EEPROM brand (advertising name) record — shared by Shimmer3/Shimmer3R over
// BLE/BT (readDaughterCardMem) and the dock UART / USB-C (CARD_MEM)
export {
  BRAND_RECORD_HOST_OFFSET,
  BRAND_RECORD_SIZE,
  BRAND_RECORD_MAGIC,
  BRAND_RECORD_LAYOUT_VER,
  BRAND_BT_CLASSIC_MAX_CHARS,
  BRAND_BLE_MAX_CHARS,
  BRAND_BLE_MAX_CHARS_SHIMMER3,
  BRAND_USB_PRODUCT_MAX_CHARS,
  BRAND_USB_MANUFACTURER_MAX_CHARS,
  BRAND_PLATFORM,
  brandNameProblem,
  parseBrandRecord,
  buildBrandRecord,
  buildBlankBrandRecord,
} from './devices/brandRecord.js';
export type { BrandRecord, BrandRecordFields } from './devices/brandRecord.js';
// Shimmer3R SD-card file transfer (FW >= v1.01.011)
export {
  SD_TRANSFER_OPCODES,
  SD_STATUS,
  SD_XFER,
  SD_ATTR_DIR,
  SD_ATTR_NAME_TRUNCATED,
  SD_MAX_PATH_LEN,
  SD_BLOCK_PAYLOAD_MIN,
  SD_BLOCK_PAYLOAD_MAX,
  SD_BLOCK_PAYLOAD_DEFAULT,
  SdTransferError,
  sdStatusToString,
  sdXferStatusToString,
  sdCrc16,
  fatDateTimeToDate,
  encodeSdPath,
  buildListDirCmd,
  buildStatCmd,
  buildDeleteCmd,
  buildFreeSpaceCmd,
  buildAbortCmd,
  buildReadCmd,
  parseListDirRsp,
  parseStatRsp,
  parseFreeSpaceRsp,
  parseDeleteRsp,
  tryExtractSdMessage,
  sdMessageSpan,
} from './devices/shimmer3r/sdTransfer/protocol.js';
export type {
  SdDirEntry,
  SdFileStat,
  SdCardSpace,
  SdDataFrame,
  SdStatusFrame,
  SdOneShotResponse,
  SdMessage,
  SdListDirPage,
  SdExtractResult,
} from './devices/shimmer3r/sdTransfer/protocol.js';
export {
  enumerateSdTree,
  downloadSdTree,
  deleteDownloadedFromCard,
  formatSdImportStamp,
  consensysBackupSegments,
  CONSENSYS_UNKNOWN_DEVICE,
} from './devices/shimmer3r/sdTransfer/Shimmer3RSdTransfer.js';
export type {
  SdDestinationLayout,
  SdRemoteFile,
  SdRemoteTree,
  SdTransferProgress,
  DownloadSdTreeOptions,
  SdTransferSummary,
} from './devices/shimmer3r/sdTransfer/Shimmer3RSdTransfer.js';

// Host-side directory-tree creation (File System Access API)
export { ensureDirectoryPath } from './devices/verisense/protocolDataFlow.js';

// Shimmer3 (classic Bluetooth / RFCOMM)
export { Shimmer3Client } from './devices/shimmer3/Shimmer3Client.js';
export type { Shimmer3ClientOptions } from './devices/shimmer3/Shimmer3Client.js';
export {
  SHIMMER3_DEFAULTS,
  SHIMMER3_SPP_UUID,
  SHIMMER3_SPP_SERIAL_OPTIONS,
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
  // The ShimmerVerObject firmware-capability ladder, and the ExG command gate
  // the Shimmer3 client applies with it.
  deriveShimmer3FirmwareVersionCode,
  shimmer3SupportsExg,
} from './devices/shimmer3/protocol.js';
export type {
  Shimmer3InquiryResult,
  Shimmer3StreamSchema,
  Shimmer3ChannelField,
  Shimmer3DeviceVersion,
  Shimmer3FwVersion,
} from './devices/shimmer3/protocol.js';

// Configuration option tables for both Shimmer3 families, ported verbatim from
// the Java driver (labels AND config values — several are register encodings
// that are neither contiguous nor monotonic). A table belongs to a chip, not a
// platform: pick the pair matching the hardware you are configuring.
export {
  SHIMMER3_LSM6DSV_ACCEL_RANGE_OPTIONS,
  SHIMMER3_LSM6DSV_GYRO_RANGE_OPTIONS,
  SHIMMER3_LSM6DSV_ACCEL_GYRO_RATE_OPTIONS,
  SHIMMER3_LIS2DW12_ACCEL_RANGE_OPTIONS,
  SHIMMER3_LIS2DW12_ACCEL_RATE_HPM_OPTIONS,
  SHIMMER3_LIS2DW12_ACCEL_RATE_LPM_OPTIONS,
  SHIMMER3_ADXL371_ACCEL_RATE_OPTIONS,
  SHIMMER3_ADXL371_ACCEL_RANGE_OPTIONS,
  SHIMMER3_LIS2MDL_MAG_RATE_OPTIONS,
  SHIMMER3_LIS2MDL_MAG_RANGE_OPTIONS,
  SHIMMER3_LIS3MDL_ALT_MAG_RATE_OPTIONS,
  SHIMMER3_LIS3MDL_ALT_MAG_RANGE_OPTIONS,
  SHIMMER3_BMP390_PRESSURE_OVERSAMPLING_OPTIONS,
  SHIMMER3_BMP390_PRESSURE_RATE_OPTIONS,
  SHIMMER3_BMP581_PRESSURE_OVERSAMPLING_OPTIONS,
  SHIMMER3_BMP581_PRESSURE_RATE_OPTIONS,
  SHIMMER3_BMP180_PRESSURE_RESOLUTION_OPTIONS,
  SHIMMER3_BMP280_PRESSURE_RESOLUTION_OPTIONS,
  SHIMMER3_GSR_RANGE_RESISTANCE_OPTIONS,
  SHIMMER3_GSR_RANGE_CONDUCTANCE_OPTIONS,
  SHIMMER3_LSM303DLHC_ACCEL_RANGE_OPTIONS,
  SHIMMER3_LSM303DLHC_ACCEL_RATE_HR_OPTIONS,
  SHIMMER3_LSM303DLHC_ACCEL_RATE_LPM_OPTIONS,
  SHIMMER3_LSM303DLHC_MAG_RANGE_OPTIONS,
  SHIMMER3_LSM303DLHC_MAG_RATE_OPTIONS,
  SHIMMER3_LSM303AH_ACCEL_RANGE_OPTIONS,
  SHIMMER3_LSM303AH_ACCEL_RATE_HR_OPTIONS,
  SHIMMER3_LSM303AH_ACCEL_RATE_LPM_OPTIONS,
  SHIMMER3_LSM303AH_MAG_RATE_OPTIONS,
  SHIMMER3_LSM303AH_MAG_RANGE_OPTIONS,
  SHIMMER3_MPU9X50_GYRO_RANGE_OPTIONS,
  SHIMMER3_MPU9X50_ACCEL_RANGE_OPTIONS,
  SHIMMER3_MPU9X50_MAG_RATE_OPTIONS,
  SHIMMER3_BT_BAUD_RATE_OPTIONS,
  SHIMMER3_SAMPLING_RATES_HZ,
  samplingRateToDivisor,
  divisorToSamplingRate,
  SHIMMER3_SENSOR_LABELS,
  shimmer3SensorLabel,
} from './devices/shimmer3/sensorOptions.js';
export type {
  Shimmer3SensorOption,
  Shimmer3SensorLabel,
} from './devices/shimmer3/sensorOptions.js';

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
  msToRtcBytesLE,
  isSupportedRtcConfigViaUart,
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

// InfoMem configuration-memory codec (Shimmer3 / Shimmer3R) — configure-while-docked (phase P2)
export {
  parseInfoMem,
  generateInfoMem,
  deviceWriteDivergentRanges,
  compareInfoMemExcluding,
  resolveInfoMemLayout,
  checkConfigBytesValid,
  fwCompare,
  isSupportedMpl,
  isSupportedEightByteDerivedSensors,
  isSupportedSdLogSync,
  isSdLoggingFirmware,
  INFOMEM_SIZE,
  INFOMEM_PAGE_SIZE,
  INFOMEM_VALIDITY_BYTES,
  INFOMEM_SAMPLING_CLOCK_FREQ,
  INFOMEM_ADDR_LEGACY,
  INFOMEM_ADDR_FLAT,
  HW_ID as INFOMEM_HW_ID,
  FW_ID as INFOMEM_FW_ID,
  ANY_VERSION as INFOMEM_ANY_VERSION,
} from './devices/infomem/index.js';
export type {
  InfoMemContext,
  InfoMemDeviceConfig,
  InfoMemLayout,
  GenerateInfoMemOptions,
  DeviceWriteDivergentRanges,
} from './devices/infomem/index.js';
export {
  GENERAL_CALIBRATION_LENGTH as INFOMEM_GENERAL_CALIBRATION_LENGTH,
  MAX_SYNC_NODES as INFOMEM_MAX_SYNC_NODES,
  BIT_SHIFT as INFOMEM_BIT_SHIFT,
  MASK as INFOMEM_MASK,
} from './devices/infomem/index.js';
export type {
  InfoMemImuConfig,
  InfoMemSdConfig,
  InfoMemCalibrationBlocks,
} from './devices/infomem/index.js';
export {
  SHIMMER3_INFOMEM_FIELD_SCHEMA,
  SHIMMER3_INFOMEM_FIELD_GROUPS,
  NEW_IMU_EXP_REV,
  resolveFieldIndex,
  readInfoMemFieldValue,
  writeInfoMemFieldValue,
  infoMemFieldsFor,
  inferShimmer3Generation,
} from './devices/infomem/index.js';
export type {
  Shimmer3Generation,
  InfoMemFieldKind,
  InfoMemFieldOption,
  InfoMemFieldDefinition,
  InfoMemFieldGroup,
  InfoMemFieldSubgroup,
} from './devices/infomem/index.js';

// ADS1292R ExG register codec (Shimmer3 / Shimmer3R) — the ECG/EMG/respiration
// expansion board. The two 10-byte per-chip register banks appear in three
// places — InfoMem (`exg1`/`exg2`), an SD-log header, and the live GET/SET
// commands — and this is the one codec for all three: `decodeExgRegisters` /
// `encodeExgRegisters` for a single bank, `detectExgPreset` to name what a pair
// of banks is, `applyExgPreset` to build the banks AND the sensor bitmap for a
// chosen preset, and `updateExgSetting` to change one named knob in place. Ported
// from the Java driver's SensorEXG / ExGConfigBytesDetails / ShimmerObject ExG
// accessors, with the driver file:line for every byte value in the source.
//
// Resolution (16- vs 24-bit) is NOT a register field: it lives in the enabled-
// sensors bitmap. Use `exgResolutionFromSensors` to read it back.
//
// The clients apply this themselves — `Shimmer3RClient` / `Shimmer3Client`
// expose `readExgConfig`, `writeExgConfig` and `applyExgPresetLive`; the framing
// exports below are needed only when driving the radio by hand.
export {
  EXG_BANK_LENGTH,
  decodeExgRegisters,
  encodeExgRegisters,
  applyExgMustBeBits,
  readExgField,
  setExgFieldPreserving,
  // Option label lists, verbatim from the Java GUI value lists.
  CONVERSION_MODE_LABELS,
  DATA_RATE_LABELS,
  VOLTAGE_REFERENCE_LABELS,
  TEST_SIGNAL_FREQUENCY_LABELS,
  COMPARATOR_THRESHOLD_LABELS,
  LEAD_OFF_CURRENT_LABELS,
  LEAD_OFF_FREQUENCY_LABELS,
  LEAD_OFF_DETECTION_LABELS,
  GAIN_LABELS,
  GAIN_VALUES,
  POWER_DOWN_LABELS,
  INPUT_SELECTION_LABELS,
  CHOP_FREQUENCY_LABELS,
  RESPIRATION_PHASE_32KHZ_LABELS,
  RESPIRATION_PHASE_64KHZ_LABELS,
  RESPIRATION_FREQUENCY_LABELS,
  RESPIRATION_CONTROL_LABELS,
  RLD_REFERENCE_SIGNAL_LABELS,
  REFERENCE_ELECTRODE_OPTIONS,
  // Presets: the driver's reference register arrays, detection, and the apply
  // side (resolution flags, rate coupling, conflicting-sensor clearing).
  EXG_PRESET_ARRAYS,
  exgResolutionFromSensors,
  detectExgPreset,
  exgPresetLabel,
  applyExgPreset,
  clearExgResolutionFlags,
  exgConflictingSensors,
  exgRateSettingFromFreq,
  EXG_CONFLICTING_SENSORS,
  // Live GET/SET_EXG_REGS framing and read-back comparison.
  SET_EXG_REGS_COMMAND,
  EXG_REGS_RESPONSE,
  GET_EXG_REGS_COMMAND,
  EXG_REGS_RESPONSE_PAYLOAD_LENGTH,
  EXG_CHIP1,
  EXG_CHIP2,
  EXG_REG8_STATUS_INDEX,
  buildGetExgRegsCommand,
  buildSetExgRegsCommand,
  decodeExgRegsResponse,
  exgBanksEqualIgnoringStatus,
  // Per-knob editing: one named setting at a time, with typed errors.
  EXG_KNOBS,
  GAIN_OPTIONS,
  DATA_RATE_OPTIONS,
  LEAD_OFF_CURRENT_OPTIONS,
  LEAD_OFF_COMPARATOR_OPTIONS,
  LEAD_OFF_DETECTION_OPTIONS,
  RESPIRATION_FREQUENCY_OPTIONS,
  respirationPhaseOptions,
  exgKnobOptions,
  isExgRespirationEnabled,
  updateExgSetting,
  applyExgKnobEdits,
  readExgKnobs,
  ExgKnobError,
  UnknownExgKnobError,
  ExgKnobValueError,
  ExgRespirationLockedError,
} from './devices/exg/index.js';
export type {
  ExgFieldValue,
  ExgGainValue,
  ExgChannelSettings,
  ExgLeadOffSettings,
  ExgRespirationSettings,
  ExgRldSettings,
  ExgTestSignalSettings,
  ExgStatusBits,
  DecodedExgRegisters,
  ExgFieldName,
  ExgPreset,
  ExgResolution,
  ExgApplyInput,
  ExgApplyResult,
  ApplicableExgPreset,
  ExgChipIndex,
  ExgBanks,
  ExgKnobOption,
  ExgKnobField,
  ExgKnobEdit,
} from './devices/exg/index.js';

// Inertial (accel/gyro/mag) calibration — phase P3
export {
  matrixInverse3x3,
  matrixMultiply3x3,
  makeKinematicCalibration,
  calibrateVector3,
  parseKinematicCalibBlock,
  generateKinematicCalibBlock,
  INERTIAL_UNITS,
  getGroupDefaults,
  getDefaultCalibration,
  parseCalibDump,
  generateCalibDump,
  MAX_CALIB_DUMP_BYTES,
  CALIB_READ_SOURCE,
  shouldOverrideCalibration,
} from './devices/calibration/index.js';
export type {
  KinematicCalibration,
  ParseKinematicOptions,
  ImuFamily,
  InertialGroup,
  GroupDefaults,
  CalibDump,
  CalibDumpRecord,
  CalibDumpVersion,
  CalibReadSource,
} from './devices/calibration/index.js';

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
  isNewImuSensors,
} from './devices/sdlog/index.js';
export type {
  SdLogChannel,
  SdLogHeader,
  SdLogRecord,
  SdLogFormatErrorCode,
  SdLogCalibrationBytes,
  SdLogExpansionBoard,
  SdLogImuRanges,
  SdLogChannelCalibrationInfo,
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
  isVerisenseGsrSupportedHardware,
  isVerisenseLipoBatteryHardware,
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
  utcToLocalCivilMillis,
  localCivilUnixSecondsNow,
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
  VERISENSE_DFU_BOOTLOADER_NAME_PREFIXES,
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

// Verisense Nordic Secure-DFU over USB CDC serial (bootloader v3)
export {
  slipEncode,
  SlipDecoder,
  crc32,
  SERIAL_DFU_OP,
  SERIAL_DFU_OBJECT_TYPE,
  SERIAL_DFU_RESULT_NAMES,
  SERIAL_DFU_EXTENDED_ERROR_NAMES,
  VERISENSE_USB_DFU_VID,
  VERISENSE_USB_DFU_PID,
  VERISENSE_USB_DFU_PORT_FILTERS,
  VERISENSE_USB_DFU_REENUMERATION_DELAY_MS,
  VERISENSE_SERIAL_DFU_REQUEST_TIMEOUT_MS,
  VERISENSE_SERIAL_DFU_OBJECT_ATTEMPTS,
  isUsbDfuUnsupportedError,
  VerisenseSerialDfu,
} from './devices/verisense/dfuSerial.js';
export type {
  SerialDfuTransportLike,
  VerisenseSerialDfuProgress,
  VerisenseSerialDfuOptions,
} from './devices/verisense/dfuSerial.js';
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
export {
  parseVerisenseFactoryTestReport,
  verisenseFactoryTestReportToCsvRows,
} from './devices/verisense/factoryTestReport.js';
export type {
  VerisenseFactoryTestVerdict,
  VerisenseFactoryTestMetricValue,
  VerisenseFactoryTestResult,
  VerisenseFactoryTestMcuInfo,
  VerisenseFactoryTestModelInfo,
  VerisenseFactoryTestOverall,
  VerisenseFactoryTestReportParsed,
} from './devices/verisense/factoryTestReport.js';
