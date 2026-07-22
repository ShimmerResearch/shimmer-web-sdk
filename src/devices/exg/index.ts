/**
 * ADS1292R (EXG / ECG-EMG-respiration) register codec.
 *
 * Pure, transport-free port of the desktop Java EXG configuration
 * (com.shimmerresearch.sensors.SensorEXG,
 * com.shimmerresearch.exgConfig.ExGConfigBytesDetails, and the EXG accessors
 * in com.shimmerresearch.driver.ShimmerObject). Decodes/encodes the 10-byte
 * per-chip register bank, detects the whole-device preset, and derives the
 * 16/24-bit resolution from the sensor bitmap.
 *
 * @packageDocumentation
 */

export {
  EXG_BANK_LENGTH,
  decodeExgRegisters,
  encodeExgRegisters,
  applyExgMustBeBits,
  // option label lists (verbatim from SensorEXG.java:116-149)
  CONVERSION_MODE_LABELS,
  DATA_RATE_LABELS,
  VOLTAGE_REFERENCE_LABELS,
  TEST_SIGNAL_FREQUENCY_LABELS,
  COMPARATOR_THRESHOLD_LABELS,
  LEAD_OFF_CURRENT_LABELS,
  LEAD_OFF_FREQUENCY_LABELS,
  GAIN_LABELS,
  GAIN_VALUES,
  POWER_DOWN_LABELS,
  INPUT_SELECTION_LABELS,
  CHOP_FREQUENCY_LABELS,
  RESPIRATION_PHASE_32KHZ_LABELS,
  RESPIRATION_PHASE_64KHZ_LABELS,
  RESPIRATION_FREQUENCY_LABELS,
  RLD_REFERENCE_SIGNAL_LABELS,
  RESPIRATION_CONTROL_LABELS,
} from './registers.js';

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
} from './registers.js';

export {
  EXG_PRESET_ARRAYS,
  exgResolutionFromSensors,
  detectExgPreset,
  exgPresetLabel,
} from './presets.js';

export type { ExgPreset, ExgResolution } from './presets.js';

export {
  applyExgPreset,
  clearExgResolutionFlags,
  exgConflictingSensors,
  exgRateSettingFromFreq,
  EXG_CONFLICTING_SENSORS,
} from './apply.js';

export type { ExgApplyInput, ExgApplyResult, ApplicableExgPreset } from './apply.js';

export {
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
} from './live.js';

export type { ExgChipIndex } from './live.js';
