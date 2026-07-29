/**
 * Shimmer3-family InfoMem (configuration-memory) codec — layout resolution,
 * parse, and generate. Enables configure-while-docked over the dock UART.
 *
 * @packageDocumentation
 */

export type { InfoMemContext, InfoMemDeviceConfig } from './types.js';

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

export { generateInfoMem, deviceWriteDivergentRanges } from './generate.js';
export type { GenerateInfoMemOptions, DeviceWriteDivergentRanges } from './generate.js';
