/**
 * The TCXO setting, ExperimentConfig1 bit 4 (InfoMem byte 218, FW `tcxo`).
 *
 * It asked the firmware to clock sampling from a temperature-compensated
 * crystal oscillator. No LogAndStream build supports one: the firmware clears
 * the bit when it takes a configuration (log-and-stream-common
 * `Configuration/shimmer_config.c`, `ShimConfig_checkAndCorrectConfig`, under
 * `#if !IS_SUPPORTED_TCXO`, which holds on Shimmer3, where `main.c` defines it
 * as 0, and on Shimmer3R, which does not define it). So the field schema does
 * not offer it, and a host clears it before a write, which writes what the
 * sensor will read back.
 *
 * HARDWARE-VERIFY: from the firmware source; no unit with the bit set has been
 * configured through this SDK.
 */

import { BIT_SHIFT, type InfoMemLayout } from './layout.js';

/**
 * Clear the TCXO bit in `image`, as the firmware does when it takes the
 * configuration. Only on LogAndStream and SDLog layouts, where byte 218 holds
 * the experiment configuration. Returns the indices of the bytes it changed:
 * empty, or the one byte.
 */
export function applyTcxoRule(image: Uint8Array, layout: InfoMemLayout): number[] {
  if (!layout.isSdLoggingFirmware) return [];
  const at = layout.idxSDExperimentConfig1;
  const bit = 1 << BIT_SHIFT.TCXO;
  if (!(image[at] & bit)) return [];
  image[at] = image[at] & ~bit & 0xff;
  return [at];
}
