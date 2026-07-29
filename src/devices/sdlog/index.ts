/**
 * Shimmer3 / Shimmer3R binary SD-log file decoder — phase D3.
 *
 * Pure, transport-free port of the desktop Java parser
 * (com.shimmerresearch.binaryfile.ShimmerSDLog and friends) covering modern
 * Shimmer3 (256-byte header; SDLog >= 0.8.69 / LogAndStream >= 0.5.0) and
 * Shimmer3R (384-byte header) log files. Legacy 0.5.x logs and GQ/StroKare
 * firmware are rejected with typed {@link SdLogFormatError}s.
 */

export {
  SDLOG_HW_ID,
  SDLOG_FW_ID,
  SDLOG_HEADER_LENGTH,
  SDLOG_CLOCK_FREQ,
  SDLOG_SYNC_OFFSET_LENGTH,
  SDLOG_SYNC_BLOCK_LENGTH,
  SDLogHeaderBitmask,
  hasSensorBit,
} from './constants.js';
export { SdLogFormatError } from './types.js';
export type {
  SdLogChannel,
  SdLogHeader,
  SdLogRecord,
  SdLogFormatErrorCode,
  SdLogCalibrationBytes,
  SdLogExpansionBoard,
  SdLogImuRanges,
  SdLogChannelCalibrationInfo,
} from './types.js';
export { isNewImuSensors } from './header.js';
export { decodeSdLogValue, SDLOG_DATA_TYPE_BYTES } from './channels.js';
export type { SdLogDataType, SdLogChannelSpec } from './channels.js';
export { parseSdLogHeader } from './header.js';
export { decodeSdLogFile, decodeSdSession } from './decode.js';
export type { SdLogDecodeOptions, SdLogDecodeResult } from './decode.js';
export { parseSdSessionName, parseSdTrialFolderName } from './naming.js';
