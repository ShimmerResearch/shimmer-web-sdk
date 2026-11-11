/**
 * The Shimmer3R sound-level channel (DEV-1413): channel id 0x38, two bytes,
 * a signed 16-bit little-endian count of 0.01 dB(A).
 *
 * **What it measures.** The A-weighted sound level, LAeq, over the most recent
 * completed 128 ms block from the microphone, in dB(A) SPL. The firmware adds
 * the microphone's datasheet sensitivity (the board carries an MP23DB01HP or an
 * IM68D121, and each has its own), and nothing more: no unit has been checked
 * against a calibrated sound level meter. So the level is **nominal**, and a
 * host should say so wherever it shows one.
 *
 * **No level.** `0x8000` (-32768) says there is no level to report: while
 * capture settles, for about the first 256 ms; when it is stopped; or when it
 * failed. {@link soundLevelDbA} turns it into `NaN`, never -327.68 dB.
 *
 * **When.** A value describes the block that ended 0-128 ms before the
 * packet's timestamp, plus the main loop's latency, which can add up to about
 * 0.2 s more while an SD card is slow. Nothing here corrects for it.
 *
 * **Where.** The firmware places the channel just before the ADS7028 block
 * (GSR, the ADCs and battery), so battery stays last. Hosts take the order from
 * the channel list, the inquiry response or the SD header, as for any channel.
 * It is sampled while streaming, logging, or both, whenever configuration
 * byte 233 bit 4 is set ({@link soundLevelEnabled}). A Shimmer3 never sends it.
 *
 * HARDWARE-VERIFY: written from the firmware specification; no packet or file
 * from a unit with the channel has been decoded yet.
 */

import { CHANNEL_UNITS } from '../../core/units.js';

/** The channel id in the inquiry response and the SD header's channel list. */
export const SOUND_LEVEL_CHANNEL_ID = 0x38;

/** The name the stream and SD decoders give the channel. */
export const SOUND_LEVEL_NAME = 'SOUND_LEVEL';

/** The raw value that means no level: 0x8000 as a signed 16-bit count. */
export const SOUND_LEVEL_NO_LEVEL = -32768;

/** Counts per dB(A). */
export const SOUND_LEVEL_COUNTS_PER_DB = 100;

/** The calibrated value's unit: nominal dB(A) SPL. */
export const SOUND_LEVEL_UNIT = CHANNEL_UNITS.DECIBELS_A;

/**
 * A raw sound-level count in nominal dB(A) SPL, or `NaN` for the no-level value
 * (and for anything that is not a 16-bit count).
 */
export function soundLevelDbA(raw: number): number {
  if (!Number.isInteger(raw) || raw <= SOUND_LEVEL_NO_LEVEL || raw > 32767) return NaN;
  return raw / SOUND_LEVEL_COUNTS_PER_DB;
}
