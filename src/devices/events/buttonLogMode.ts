/**
 * Configuration byte 232 (`NV_BUTTON_LOG_MODE`) on a Shimmer3 or Shimmer3R:
 * what the user button does, what else may start SD logging, and whether the
 * TTL input is recorded.
 *
 *    bits 0-2  button mode   {@link BUTTON_MODE}
 *    bits 3-4  log triggers  {@link LOG_TRIGGERS}, read only when the button
 *                            mode is not {@link BUTTON_MODE.LEGACY}
 *    bit 5     TTL input recorded, whatever the button mode
 *    bit 6     unused, cleared
 *    bit 7     must be 0
 *
 * 0 means "as before": `userButtonEnable` (byte 217 bit 5) decides both what a
 * press does and whether leaving the dock starts logging. Anything the firmware
 * cannot act on reads as 0 too: bit 7 set (erased flash, and firmware before the
 * byte, is 0xFF), a reserved value, or a button mode that is not built.
 *
 * A port of log-and-stream-common `Configuration/shimmer_button_log_mode.c`,
 * kept rule for rule so a host reads every one of the 256 values exactly as the
 * firmware does. `docs/SHIMMER3_CONFIGURATION_INFOMEM.md` §8.3 has the table and
 * the reasons behind each rule.
 *
 * HARDWARE-VERIFY: ported from the firmware source and its host tests; no
 * device running the byte has been configured through this SDK yet.
 */

import { BIT_SHIFT, HW_ID, type InfoMemLayout } from '../infomem/layout.js';

/** Bit masks of configuration byte 232. */
export const BUTTON_LOG_MODE = Object.freeze({
  /** InfoMem offset of the byte (`NV_BUTTON_LOG_MODE`, 128 + 104). */
  INFOMEM_OFFSET: 232,
  BUTTON_MASK: 0x07,
  TRIGGER_SHIFT: 3,
  TRIGGER_MASK: 0x18,
  TTL_INPUT: 0x20,
  INVALID: 0x80,
} as const);

/**
 * Bits 0-2: what a press does. 6 and 7 are reserved and read as
 * {@link BUTTON_MODE.LEGACY}. "Recorded" means every press and release goes to
 * the event channel; a double press is then what starts and stops logging, so a
 * marker press cannot stop a recording.
 */
export const BUTTON_MODE = Object.freeze({
  /** `userButtonEnable` decides, as before the byte existed. */
  LEGACY: 0,
  /** A press does nothing, and the LED shows nothing while it is held. */
  DISABLED: 1,
  /** A press starts and stops logging. */
  SINGLE_PRESS: 2,
  /** A double press starts and stops logging. */
  DOUBLE_PRESS: 3,
  /** A double press starts and stops logging, and every press is recorded. */
  DOUBLE_RECORDED: 4,
  /** Every press is recorded, and a press never starts or stops logging. */
  RECORDED: 5,
} as const);

export type ButtonMode = (typeof BUTTON_MODE)[keyof typeof BUTTON_MODE];

/** Bits 3-4: what else may start logging. 3 is reserved. */
export const LOG_TRIGGERS = Object.freeze({
  /** A host command only. */
  HOST: 0,
  /** A host command, or leaving the dock (on Shimmer3R, unplugging USB-C). */
  HOST_UNDOCK: 1,
  /** Nothing: SD logging is off. */
  NONE: 2,
} as const);

export type LogTriggers = (typeof LOG_TRIGGERS)[keyof typeof LOG_TRIGGERS];

/** `[value, label]` pairs for a button-mode selector, in value order. */
export const BUTTON_MODE_OPTIONS: readonly (readonly [number, string])[] = Object.freeze([
  [BUTTON_MODE.LEGACY, 'As before (Start Logging On Button Press decides)'],
  [BUTTON_MODE.DISABLED, 'Disabled'],
  [BUTTON_MODE.SINGLE_PRESS, 'Press starts/stops logging'],
  [BUTTON_MODE.DOUBLE_PRESS, 'Double press starts/stops logging'],
  [BUTTON_MODE.DOUBLE_RECORDED, 'Double press starts/stops logging, every press recorded'],
  [BUTTON_MODE.RECORDED, 'Every press recorded, logging untouched'],
] as const);

/** `[value, label]` pairs for a log-trigger selector, in value order. */
export const LOG_TRIGGER_OPTIONS: readonly (readonly [number, string])[] = Object.freeze([
  [LOG_TRIGGERS.HOST, 'Host command only'],
  [LOG_TRIGGERS.HOST_UNDOCK, 'Host command or undock'],
  [LOG_TRIGGERS.NONE, 'Nothing: SD logging off'],
] as const);

function isButtonModeBuilt(mode: number): boolean {
  return mode >= BUTTON_MODE.DISABLED && mode <= BUTTON_MODE.RECORDED;
}

function canPressStartLogging(mode: number): boolean {
  return (
    mode === BUTTON_MODE.SINGLE_PRESS ||
    mode === BUTTON_MODE.DOUBLE_PRESS ||
    mode === BUTTON_MODE.DOUBLE_RECORDED
  );
}

/**
 * The byte the firmware acts on, and writes back after a configuration write:
 * `raw` itself when it is valid, 0 when bit 7 is set, and otherwise the button
 * mode and log triggers cleared when either is not valid (a legacy byte's log
 * triggers are not read, so they are cleared too). Bit 5 stands on its own
 * unless bit 7 is set. Bit 6 is cleared.
 */
export function correctButtonLogMode(raw: number): number {
  const byte = raw & 0xff;
  const mode = byte & BUTTON_LOG_MODE.BUTTON_MASK;
  const trig = (byte & BUTTON_LOG_MODE.TRIGGER_MASK) >> BUTTON_LOG_MODE.TRIGGER_SHIFT;
  const ttl = byte & BUTTON_LOG_MODE.TTL_INPUT;
  if (byte & BUTTON_LOG_MODE.INVALID) return 0;
  if (!isButtonModeBuilt(mode) || trig > LOG_TRIGGERS.NONE) return ttl;
  return (
    byte & (BUTTON_LOG_MODE.BUTTON_MASK | BUTTON_LOG_MODE.TRIGGER_MASK | BUTTON_LOG_MODE.TTL_INPUT)
  );
}

/** The button mode the firmware acts on (bits 0-2 of the corrected byte). */
export function buttonModeOf(raw: number): number {
  return correctButtonLogMode(raw) & BUTTON_LOG_MODE.BUTTON_MASK;
}

/** The log triggers the firmware acts on: 0 whenever the button mode is legacy. */
export function logTriggersOf(raw: number): number {
  return (
    (correctButtonLogMode(raw) & BUTTON_LOG_MODE.TRIGGER_MASK) >> BUTTON_LOG_MODE.TRIGGER_SHIFT
  );
}

/** Whether the TTL input's edges are recorded. */
export function isTtlInputEnabled(raw: number): boolean {
  return (correctButtonLogMode(raw) & BUTTON_LOG_MODE.TTL_INPUT) !== 0;
}

/** Whether every press and release goes to the event channel (modes 4 and 5). */
export function recordsButtonPresses(raw: number): boolean {
  const mode = buttonModeOf(raw);
  return mode === BUTTON_MODE.DOUBLE_RECORDED || mode === BUTTON_MODE.RECORDED;
}

/** Whether starting and stopping takes a double press (modes 3 and 4). */
export function isDoublePress(raw: number): boolean {
  const mode = buttonModeOf(raw);
  return mode === BUTTON_MODE.DOUBLE_PRESS || mode === BUTTON_MODE.DOUBLE_RECORDED;
}

/** Whether SD logging is off: log triggers 2, which only a non-legacy mode reads. */
export function isLoggingDisabled(raw: number): boolean {
  return logTriggersOf(raw) === LOG_TRIGGERS.NONE;
}

/** Whether the button does nothing, its LED included (mode 1). */
export function isButtonDisabled(raw: number): boolean {
  return buttonModeOf(raw) === BUTTON_MODE.DISABLED;
}

/**
 * Whether a press starts and stops logging. Starting still has to pass the
 * firmware's start check, which logging off fails.
 */
export function doesPressToggleLogging(raw: number, userButtonEnable: boolean): boolean {
  const mode = buttonModeOf(raw);
  if (mode === BUTTON_MODE.LEGACY) return userButtonEnable;
  return canPressStartLogging(mode);
}

/**
 * Whether leaving the dock, or on Shimmer3R unplugging USB-C, starts logging.
 * Never with single touch, where the sync centre's press starts every node.
 */
export function doesUndockStartLogging(
  raw: number,
  userButtonEnable: boolean,
  singleTouchStart = false,
): boolean {
  if (singleTouchStart) return false;
  if (buttonModeOf(raw) === BUTTON_MODE.LEGACY) return !userButtonEnable;
  return logTriggersOf(raw) === LOG_TRIGGERS.HOST_UNDOCK;
}

/**
 * The `userButtonEnable` the firmware holds byte 217 at for this byte, so a
 * host or firmware that knows only byte 217 never falls back to an undock
 * start. 0 only where a press cannot start logging and leaving the dock does;
 * otherwise 1. A legacy byte leaves `userButtonEnable` as it is.
 */
export function nearestUserButtonEnable(raw: number, userButtonEnable: boolean): boolean {
  const mode = buttonModeOf(raw);
  if (mode === BUTTON_MODE.LEGACY) return userButtonEnable;
  return !(!canPressStartLogging(mode) && logTriggersOf(raw) === LOG_TRIGGERS.HOST_UNDOCK);
}

/**
 * Whether single touch can work: it needs a press that can start logging.
 * The firmware clears `singleTouchStart` when this is false.
 */
export function allowsSingleTouch(raw: number): boolean {
  const mode = buttonModeOf(raw);
  if (mode === BUTTON_MODE.LEGACY) return true;
  return canPressStartLogging(mode) && !isLoggingDisabled(raw);
}

/**
 * The corrected byte with press recording taken out, as the firmware does on a
 * board with no button edges to record (SR48-6-0): a recorded double press
 * becomes a plain double press, and recording alone becomes disabled.
 */
export function withoutPressRecording(raw: number): number {
  const fixed = correctButtonLogMode(raw);
  const rest = fixed & ~BUTTON_LOG_MODE.BUTTON_MASK & 0xff;
  switch (fixed & BUTTON_LOG_MODE.BUTTON_MASK) {
    case BUTTON_MODE.DOUBLE_RECORDED:
      return rest | BUTTON_MODE.DOUBLE_PRESS;
    case BUTTON_MODE.RECORDED:
      return rest | BUTTON_MODE.DISABLED;
    default:
      return fixed;
  }
}

/** The three settings byte 232 holds. */
export interface ButtonLogModeSettings {
  /** Bits 0-2, {@link BUTTON_MODE}. */
  buttonMode: number;
  /** Bits 3-4, {@link LOG_TRIGGERS}. Not read while the button mode is legacy. */
  logTriggers: number;
  /** Bit 5. */
  ttlInput: boolean;
}

/** The settings a byte holds, as the firmware reads them (corrected first). */
export function decodeButtonLogMode(raw: number): ButtonLogModeSettings {
  return {
    buttonMode: buttonModeOf(raw),
    logTriggers: logTriggersOf(raw),
    ttlInput: isTtlInputEnabled(raw),
  };
}

/**
 * The byte for a set of settings, corrected the way the firmware will correct
 * it, so what a host writes is what it reads back. A legacy button mode drops
 * the log triggers, and an out-of-range value makes the button mode and log
 * triggers read as legacy while the TTL bit stands.
 */
export function encodeButtonLogMode(settings: ButtonLogModeSettings): number {
  const mode = Math.trunc(settings.buttonMode);
  const trig = Math.trunc(settings.logTriggers);
  let raw = settings.ttlInput ? BUTTON_LOG_MODE.TTL_INPUT : 0;
  if (mode >= 0 && mode <= BUTTON_LOG_MODE.BUTTON_MASK && trig >= 0 && trig <= 3) {
    raw |= mode | (trig << BUTTON_LOG_MODE.TRIGGER_SHIFT);
  }
  return correctButtonLogMode(raw);
}

/** What a byte does, worked out the way the firmware works it out. */
export interface ButtonLogModeBehaviour extends ButtonLogModeSettings {
  /** The byte as stored. */
  raw: number;
  /** The byte the firmware acts on, and writes back. */
  corrected: number;
  /** Whether a press starts and stops logging. */
  pressTogglesLogging: boolean;
  /** Whether that takes a double press. */
  doublePress: boolean;
  /** Whether every press and release is recorded. */
  recordsPresses: boolean;
  /** Whether leaving the dock (or unplugging USB-C on Shimmer3R) starts logging. */
  undockStartsLogging: boolean;
  /** Whether nothing can start SD logging. */
  loggingDisabled: boolean;
  /** Whether the button does nothing, LED included. */
  buttonDisabled: boolean;
  /** The `userButtonEnable` the firmware will hold byte 217 at. */
  userButtonEnable: boolean;
}

/**
 * Everything a byte means for a device, given its `userButtonEnable` (byte 217
 * bit 5) and `singleTouchStart` (byte 218 bit 7), which decide the legacy
 * behaviour and gate the undock start.
 */
export function describeButtonLogMode(
  raw: number,
  userButtonEnable: boolean,
  singleTouchStart = false,
): ButtonLogModeBehaviour {
  const ube = nearestUserButtonEnable(raw, userButtonEnable);
  // The firmware clears single touch where no press can start logging.
  const singleTouch = singleTouchStart && allowsSingleTouch(raw);
  return {
    ...decodeButtonLogMode(raw),
    raw: raw & 0xff,
    corrected: correctButtonLogMode(raw),
    pressTogglesLogging: doesPressToggleLogging(raw, ube),
    doublePress: isDoublePress(raw),
    recordsPresses: recordsButtonPresses(raw),
    undockStartsLogging: doesUndockStartLogging(raw, ube, singleTouch),
    loggingDisabled: isLoggingDisabled(raw),
    buttonDisabled: isButtonDisabled(raw),
    userButtonEnable: ube,
  };
}

// ---------------------------------------------------------------------------
// The firmware's checks, on a whole InfoMem image
// ---------------------------------------------------------------------------

/** What a board can record, which the firmware's checks take into account. */
export interface EventChannelBoardSupport {
  /** Whether the button's edges reach the firmware. Not on SR48-6-0, whose button is used for dock detection. */
  recordsButtonEdges: boolean;
  /** Whether the board has the TTL input. Not on SR48-6-0. */
  ttlInputSupported: boolean;
}

/** `EXP_BRD_GSR_UNIFIED`, the SR48 board. */
const SR_GSR_UNIFIED = 48;

/**
 * What a board supports, from its hardware version and SR identity
 * (`ShimBrd_isBoardSr48_6_0`, `ShimBrd_isTtlInputSupported`,
 * log-and-stream-common `Boards/shimmer_boards.c`). Both rules are Shimmer3R
 * only; a board whose identity is unknown gets everything.
 */
export function eventChannelBoardSupport(
  hardwareVersion: number,
  board?: { boardId: number; boardRev: number; specialRev: number } | null,
): EventChannelBoardSupport {
  const sr48_6_0 =
    hardwareVersion === HW_ID.SHIMMER_3R &&
    !!board &&
    board.boardId === SR_GSR_UNIFIED &&
    board.boardRev === 6 &&
    board.specialRev === 0;
  return { recordsButtonEdges: !sr48_6_0, ttlInputSupported: !sr48_6_0 };
}

/**
 * Apply, to an InfoMem image about to be written, the checks the firmware makes
 * on byte 232 when it takes a configuration
 * (`ShimConfig_checkAndCorrectConfig`, log-and-stream-common
 * `Configuration/shimmer_config.c`), so that what a host writes is what it
 * reads back:
 *
 * - byte 232 corrected, with press recording and the TTL input taken out where
 *   the board has neither;
 * - single touch (byte 218 bit 7) cleared when no press can start logging;
 * - Start Logging On Button Press (`userButtonEnable`, byte 217 bit 5) held at
 *   the button mode's nearest equivalent.
 *
 * The firmware's other checks are not made here. Does nothing when the layout
 * has no byte 232.
 *
 * @returns the offsets of the bytes it changed
 */
export function applyButtonLogModeRules(
  image: Uint8Array,
  layout: InfoMemLayout,
  board: EventChannelBoardSupport = { recordsButtonEdges: true, ttlInputSupported: true },
): number[] {
  const at = layout.idxButtonLogMode;
  if (at === undefined) return [];
  const changed: number[] = [];
  const set = (idx: number, value: number): void => {
    if (image[idx] !== value) {
      image[idx] = value;
      changed.push(idx);
    }
  };

  let byte = correctButtonLogMode(image[at]);
  if (!board.recordsButtonEdges) byte = withoutPressRecording(byte);
  if (!board.ttlInputSupported) byte &= ~BUTTON_LOG_MODE.TTL_INPUT & 0xff;
  set(at, byte);

  const cfg1 = layout.idxSDExperimentConfig1;
  const singleTouchBit = 1 << BIT_SHIFT.SINGLE_TOUCH;
  if (image[cfg1] & singleTouchBit && !allowsSingleTouch(byte)) {
    set(cfg1, image[cfg1] & ~singleTouchBit & 0xff);
  }

  const cfg0 = layout.idxSDExperimentConfig0;
  const ubeBit = 1 << BIT_SHIFT.BUTTON_START;
  const ube = nearestUserButtonEnable(byte, (image[cfg0] & ubeBit) !== 0);
  set(cfg0, ube ? image[cfg0] | ubeBit : image[cfg0] & ~ubeBit & 0xff);
  return changed;
}
