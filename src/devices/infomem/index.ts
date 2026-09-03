/**
 * Shimmer3-family InfoMem (configuration-memory) codec — layout resolution,
 * parse, and generate. Enables configure-while-docked over the dock UART.
 *
 * @packageDocumentation
 */

export type {
  InfoMemContext,
  InfoMemDeviceConfig,
  InfoMemImuConfig,
  InfoMemSdConfig,
  InfoMemCalibrationBlocks,
} from './types.js';

export {
  // constants
  HW_ID,
  FW_ID,
  ANY_VERSION,
  INFOMEM_SIZE,
  INFOMEM_PAGE_SIZE,
  INFOMEM_VALIDITY_BYTES,
  INFOMEM_ADDR_LEGACY,
  INFOMEM_ADDR_FLAT,
  GENERAL_CALIBRATION_LENGTH,
  MAX_SYNC_NODES,
  BIT_SHIFT,
  MASK,
  // predicates / resolution
  fwCompare,
  isSupportedMpl,
  isSupportedEightByteDerivedSensors,
  isSupportedSdLogSync,
  isSdLoggingFirmware,
  resolveInfoMemLayout,
  checkConfigBytesValid,
} from './layout.js';
export type { InfoMemLayout } from './layout.js';

export { parseInfoMem, INFOMEM_SAMPLING_CLOCK_FREQ } from './parse.js';

export {
  generateInfoMem,
  deviceWriteDivergentRanges,
  compareInfoMemExcluding,
} from './generate.js';
export type { GenerateInfoMemOptions, DeviceWriteDivergentRanges } from './generate.js';

export {
  SHIMMER3_INFOMEM_FIELD_SCHEMA,
  SHIMMER3_INFOMEM_FIELD_GROUPS,
  NEW_IMU_EXP_REV,
  resolveFieldIndex,
  readInfoMemFieldValue,
  writeInfoMemFieldValue,
  infoMemFieldsFor,
  inferShimmer3Generation,
} from './schema.js';
export type {
  Shimmer3Generation,
  InfoMemFieldKind,
  InfoMemFieldOption,
  InfoMemFieldDefinition,
  InfoMemFieldGroup,
  InfoMemFieldSubgroup,
} from './schema.js';
