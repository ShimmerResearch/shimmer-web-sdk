/**
 * Configuration byte 233 (`NV_AUDIO_MODE`) on a Shimmer3R: whether it records
 * from its microphone while it logs to SD, and what it keeps (DEV-99), and
 * whether it samples the sound level into the data (DEV-1413).
 *
 *    bits 0-1  mode          {@link AUDIO_MODE}
 *    bits 2-3  gain preset   0, the calibrated default; 1-3 reserved
 *    bit 4     sound level   the 0x38 channel, in the stream and the data file
 *    bits 5-6  unused, cleared
 *    bit 7     must be 0
 *
 * Anything the firmware cannot act on reads as 0, off: bit 7 set (erased
 * flash, and firmware before the byte, is 0xFF), a reserved gain preset, or a
 * mode it does not build. So a host that writes a mode and reads the byte back
 * learns whether the unit records it. Shimmer3 has no microphone, and its
 * firmware holds the byte at 0.
 *
 * **The sound level is independent of the mode.** Bits 0-1 govern only what
 * goes to the SD card beside the data file; bit 4 adds a channel to the data
 * itself, streamed and logged, with any mode or none. Firmware without the
 * channel clears bit 4 when it corrects the byte, so the readback says whether
 * a unit has it ({@link soundLevelSupportedByReadback}).
 *
 * A port of log-and-stream-common `Configuration/shimmer_audio_mode.c`, kept
 * rule for rule. `docs/SHIMMER3_CONFIGURATION_INFOMEM.md` §8.5 has the table
 * and `docs/SHIMMER3R_AUDIO.md` the recording itself.
 *
 * **Raw audio records speech.** Ask the user to confirm before setting mode 2
 * or 3 ({@link audioModeRecordsSpeech}); everyone near the device needs to know
 * it is recording. The fingerprint (mode 1) stores no audio.
 *
 * HARDWARE-VERIFY: ported from the firmware source and its host test; no unit
 * has been configured through this SDK yet.
 */

import type { InfoMemLayout } from '../infomem/layout.js';

/** Bit masks of configuration byte 233. */
export const AUDIO_MODE_BYTE = Object.freeze({
  /** InfoMem offset of the byte (`NV_AUDIO_MODE`, 128 + 105). */
  INFOMEM_OFFSET: 233,
  MODE_MASK: 0x03,
  GAIN_SHIFT: 2,
  GAIN_MASK: 0x0c,
  /** Bit 4: sample the sound level into the data, channel 0x38 (DEV-1413). */
  SOUND_LEVEL: 0x10,
  INVALID: 0x80,
} as const);

/** Byte 233 bits 0-1: what is recorded while logging. */
export const AUDIO_MODE = Object.freeze({
  OFF: 0,
  /** The audio fingerprint only: landmark hashes, no audio. */
  FINGERPRINT: 1,
  /** The fingerprint and the raw 16 kHz audio. */
  FINGERPRINT_RAW: 2,
  /** The raw 16 kHz audio only. */
  RAW: 3,
} as const);

/** Byte 233 bits 2-3. Only the calibrated default is built; 1-3 read as off. */
export const AUDIO_GAIN_PRESET = Object.freeze({
  DEFAULT: 0,
} as const);

/**
 * The modes the firmware builds, one bit per {@link AUDIO_MODE}
 * (`AUDIO_MODES_BUILT`). All four are, from DEV-99's fingerprint step on.
 * Firmware with raw audio only built 0 and 3, and read 1 and 2 back as 0,
 * which is why a host learns what a unit records by reading the byte back.
 */
const AUDIO_MODES_BUILT = 0b1111;

/** `[value, label]` pairs for an audio-mode selector, in value order. */
export const AUDIO_MODE_OPTIONS: readonly (readonly [number, string])[] = Object.freeze([
  [AUDIO_MODE.OFF, 'Off'],
  [AUDIO_MODE.FINGERPRINT, 'Fingerprint only (no audio stored)'],
  [AUDIO_MODE.FINGERPRINT_RAW, 'Fingerprint and raw audio (records speech)'],
  [AUDIO_MODE.RAW, 'Raw audio only (records speech)'],
] as const);

/**
 * The byte the firmware acts on, and writes back after a configuration write:
 * `raw` with bits 5-6 cleared when it is valid and its mode is built, and 0
 * otherwise (`ShimAudioMode_correct`). Bit 4, the sound level, is kept; firmware
 * from before the sound-level channel clears it as well.
 */
export function correctAudioMode(raw: number): number {
  const byte = raw & 0xff;
  const mode = byte & AUDIO_MODE_BYTE.MODE_MASK;
  const gain = (byte & AUDIO_MODE_BYTE.GAIN_MASK) >> AUDIO_MODE_BYTE.GAIN_SHIFT;
  if (
    byte & AUDIO_MODE_BYTE.INVALID ||
    gain !== AUDIO_GAIN_PRESET.DEFAULT ||
    !(AUDIO_MODES_BUILT & (1 << mode))
  ) {
    return 0;
  }
  return (
    byte & (AUDIO_MODE_BYTE.MODE_MASK | AUDIO_MODE_BYTE.GAIN_MASK | AUDIO_MODE_BYTE.SOUND_LEVEL)
  );
}

/** The mode the firmware acts on, {@link AUDIO_MODE}. */
export function audioModeOf(raw: number): number {
  return correctAudioMode(raw) & AUDIO_MODE_BYTE.MODE_MASK;
}

/** The gain preset the firmware acts on: always 0 until a preset is built. */
export function audioGainPresetOf(raw: number): number {
  return (correctAudioMode(raw) & AUDIO_MODE_BYTE.GAIN_MASK) >> AUDIO_MODE_BYTE.GAIN_SHIFT;
}

/** Whether the unit keeps the fingerprint, an `.AFP` file (modes 1 and 2). */
export function recordsAudioFingerprint(raw: number): boolean {
  const mode = audioModeOf(raw);
  return mode === AUDIO_MODE.FINGERPRINT || mode === AUDIO_MODE.FINGERPRINT_RAW;
}

/** Whether the unit keeps raw audio, a `.WAV` file (modes 2 and 3). */
export function recordsRawAudio(raw: number): boolean {
  const mode = audioModeOf(raw);
  return mode === AUDIO_MODE.FINGERPRINT_RAW || mode === AUDIO_MODE.RAW;
}

/**
 * Whether the unit samples the sound level into its data, channel 0x38
 * (DEV-1413): bit 4 of the byte as the firmware corrects it. Streamed and
 * logged alike, whatever the mode.
 */
export function soundLevelEnabled(raw: number): boolean {
  return (correctAudioMode(raw) & AUDIO_MODE_BYTE.SOUND_LEVEL) !== 0;
}

/**
 * What a readback says about the sound-level channel, after a host wrote
 * byte 233 with bit 4 set: true when the bit came back (the firmware has the
 * channel), false when the firmware cleared it (it does not). `null` when the
 * byte written did not set the bit, which asks nothing.
 *
 * The firmware corrects the byte when it takes a configuration, so compare
 * with what the device reads back (`readInfoMemConfig`), not with the image
 * that was written.
 */
export function soundLevelSupportedByReadback(written: number, readBack: number): boolean | null {
  if (!soundLevelEnabled(written)) return null;
  return soundLevelEnabled(readBack);
}

/**
 * What byte 233 turns on, apart: {@link recordsAudioFingerprint},
 * {@link recordsRawAudio} and {@link soundLevelEnabled}.
 */
export interface AudioModeParts {
  /** The fingerprint: landmark hashes, which store no sound. */
  fingerprint: boolean;
  /** The raw 16 kHz audio, which records speech. */
  raw: boolean;
  /**
   * The sound-level channel, bit 4 (DEV-1413). Absent reads as off, so a host
   * written before the channel builds the byte it always did.
   */
  soundLevel?: boolean;
}

/**
 * The byte that turns on exactly `parts`, at the default gain. Every
 * combination of the fingerprint and raw audio is a mode, so a host can offer
 * byte 233 as enables, as Shimmer Capture's Microphone tile does; `soundLevel`
 * sets bit 4 as well.
 */
export function joinAudioMode(parts: AudioModeParts): number {
  let mode: number;
  if (parts.fingerprint) mode = parts.raw ? AUDIO_MODE.FINGERPRINT_RAW : AUDIO_MODE.FINGERPRINT;
  else mode = parts.raw ? AUDIO_MODE.RAW : AUDIO_MODE.OFF;
  return parts.soundLevel ? mode | AUDIO_MODE_BYTE.SOUND_LEVEL : mode;
}

/**
 * Byte 233 split into {@link AudioModeParts}, as the firmware reads it: the
 * inverse of {@link joinAudioMode} on every corrected byte.
 */
export function splitAudioMode(raw: number): Required<AudioModeParts> {
  return {
    fingerprint: recordsAudioFingerprint(raw),
    raw: recordsRawAudio(raw),
    soundLevel: soundLevelEnabled(raw),
  };
}

/**
 * Whether setting this mode records speech, so a host must ask the user to
 * confirm first: modes 2 and 3, which keep raw audio. Takes a mode (0-3); a
 * whole byte is read by its bits 0-1, so the sound-level bit never hides a
 * mode that records speech.
 */
export function audioModeRecordsSpeech(mode: number): boolean {
  const m = mode & AUDIO_MODE_BYTE.MODE_MASK;
  return m === AUDIO_MODE.FINGERPRINT_RAW || m === AUDIO_MODE.RAW;
}

/**
 * The byte for a mode at the default gain, corrected the way the firmware
 * will correct it, so what a host writes is what it reads back from firmware
 * that builds the mode. A mode outside 0-3 gives 0. The sound level is off;
 * {@link withSoundLevel} turns it on.
 */
export function encodeAudioMode(mode: number): number {
  const m = Math.trunc(mode);
  if (!(m >= 0 && m <= AUDIO_MODE_BYTE.MODE_MASK)) return 0;
  return correctAudioMode(m);
}

/**
 * The byte with the sound level (bit 4) turned on or off and everything else
 * as the firmware reads it: corrected first, so a byte the firmware reads as
 * off stays off apart from bit 4. Firmware without the channel reads bit 4
 * back clear ({@link soundLevelSupportedByReadback}).
 */
export function withSoundLevel(raw: number, on: boolean): number {
  const byte = correctAudioMode(raw) & ~AUDIO_MODE_BYTE.SOUND_LEVEL;
  return on ? byte | AUDIO_MODE_BYTE.SOUND_LEVEL : byte;
}

/** A short name for a mode: `Off`, `Fingerprint`, `Fingerprint + raw`, `Raw`. */
export function describeAudioMode(mode: number): string {
  switch (mode) {
    case AUDIO_MODE.OFF:
      return 'Off';
    case AUDIO_MODE.FINGERPRINT:
      return 'Fingerprint';
    case AUDIO_MODE.FINGERPRINT_RAW:
      return 'Fingerprint + raw';
    case AUDIO_MODE.RAW:
      return 'Raw';
    default:
      return `Mode ${mode}`;
  }
}

/**
 * Apply, to an InfoMem image about to be written, the firmware's check on
 * byte 233 (`ShimConfig_checkAndCorrectConfig`): the byte corrected, so what a
 * host writes is what it reads back from firmware that builds every mode. Pass
 * `microphone: false` for hardware without one, where the firmware holds the
 * byte at 0 (every Shimmer3). Does nothing when the layout has no byte 233.
 *
 * @returns the offsets of the bytes it changed
 */
export function applyAudioModeRules(
  image: Uint8Array,
  layout: InfoMemLayout,
  microphone = layout.isShimmer3R,
): number[] {
  const at = layout.idxAudioMode;
  if (at === undefined) return [];
  const value = microphone ? correctAudioMode(image[at]) : 0;
  if (image[at] === value) return [];
  image[at] = value;
  return [at];
}
