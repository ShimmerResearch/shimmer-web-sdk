/**
 * The Shimmer3R audio recorder's status over Bluetooth (DEV-99): the two bits
 * it adds to status byte 1, and the answer to `GET_AUDIO_STATUS_COMMAND`.
 *
 * Format: log-and-stream-common `docs/SHIMMER3R_AUDIO.md` §5 and
 * `docs/SHIMMER3_BT_COMMUNICATION_PROTOCOL.md` §5.3; the builder is
 * shimmer3r-firmware `Shimmer_Driver/hal_AudioRecorder.c` `PlatAudio_buildStatus`.
 *
 * HARDWARE-VERIFY: decoded from the firmware source only; no unit has answered
 * this SDK yet.
 */

/** Opcodes of the audio status command and its response. Shimmer3R only. */
export const AUDIO_OPCODES = Object.freeze({
  /** `[0xBC]` → `[ACK][0xBD][status × 32]`. Answered while streaming too. */
  GET_AUDIO_STATUS_COMMAND: 0xbc,
  AUDIO_STATUS_RESPONSE: 0xbd,
} as const);

/** Length of the status payload after the 0xBD opcode. */
export const AUDIO_STATUS_LENGTH = 32;

/** The only payload version this decoder knows. */
export const AUDIO_STATUS_VERSION = 1;

/** Status byte 1 bits the recorder sets, beside bit 0, USB plugged in. */
export const AUDIO_STATUS_BITS = Object.freeze({
  /** Audio is being captured for the current log. */
  RECORDING: 0x02,
  /** This session's audio failed or was degraded; cleared when the next session starts. */
  FAULT: 0x04,
} as const);

/** Payload byte 2: the recorder's state. */
export const AUDIO_STATE = Object.freeze({
  /** Not configured, or not logging. */
  OFF: 0,
  /** Logging has started and the files and the microphone are coming up. */
  STARTING: 1,
  RECORDING: 2,
  /** The session's recording ended normally. */
  STOPPED: 3,
  /** Stopped for the rest of the session by a fault. */
  FAULT: 4,
} as const);

/**
 * Payload byte 3, and byte 97 of each audio file's header: the session's first
 * fault. {@link AUDIO_FAULT.OVERRUN} and {@link AUDIO_FAULT.FP_BEHIND} are
 * degradations, and recording carries on; the others stop it, and logging
 * carries on.
 */
export const AUDIO_FAULT = Object.freeze({
  NONE: 0,
  /** A directory or file could not be made. */
  OPEN: 1,
  /** The microphone would not start. */
  CAPTURE: 2,
  /** A write to the card failed. */
  WRITE: 3,
  /** The card fell further behind than the capture ring holds; the gap was written as silence. */
  OVERRUN: 4,
  /** The fingerprint fell further behind than the ring holds, and skipped chunks. */
  FP_BEHIND: 5,
} as const);

/** A short description of a recorder state. */
export function describeAudioState(state: number): string {
  switch (state) {
    case AUDIO_STATE.OFF:
      return 'Off';
    case AUDIO_STATE.STARTING:
      return 'Starting';
    case AUDIO_STATE.RECORDING:
      return 'Recording';
    case AUDIO_STATE.STOPPED:
      return 'Stopped';
    case AUDIO_STATE.FAULT:
      return 'Stopped by a fault';
    default:
      return `State ${state}`;
  }
}

/** A short description of a fault. */
export function describeAudioFault(fault: number): string {
  switch (fault) {
    case AUDIO_FAULT.NONE:
      return 'None';
    case AUDIO_FAULT.OPEN:
      return 'Could not make an audio directory or file';
    case AUDIO_FAULT.CAPTURE:
      return 'The microphone would not start';
    case AUDIO_FAULT.WRITE:
      return 'A write to the card failed';
    case AUDIO_FAULT.OVERRUN:
      return 'The card fell behind; silence was written';
    case AUDIO_FAULT.FP_BEHIND:
      return 'The fingerprint fell behind; chunks were skipped';
    default:
      return `Fault ${fault}`;
  }
}

/** Whether a fault stopped the recording, rather than degrading it. */
export function isAudioFaultFatal(fault: number): boolean {
  return (
    fault !== AUDIO_FAULT.NONE && fault !== AUDIO_FAULT.OVERRUN && fault !== AUDIO_FAULT.FP_BEHIND
  );
}

/** The answer to `GET_AUDIO_STATUS_COMMAND` (0xBC). Counters are this session's. */
export interface AudioStatus {
  /** Payload version, 1. */
  version: number;
  /** The mode configured (byte 233, corrected), {@link AUDIO_MODE}. */
  mode: number;
  /** {@link AUDIO_STATE}. */
  state: number;
  /** The session's first fault, {@link AUDIO_FAULT}. */
  fault: number;
  /** Seconds recorded: of WAV in modes 2 and 3, of audio fingerprinted in mode 1. */
  seconds: number;
  /** Samples written as silence after an overrun. */
  silenceSamples: number;
  /** Times the main loop wrote ahead of the task list to save the capture ring. */
  escapeDrains: number;
  writeErrors: number;
  /** ADF error interrupts. */
  adfErrors: number;
  /** Of them, saturation: loud sound, and a start-up transient. */
  adfSaturation: number;
  fingerprintChunks: number;
  fingerprintChunksSkipped: number;
}

/**
 * Decode the 32 status bytes that follow `AUDIO_STATUS_RESPONSE`. A later
 * version's extra bytes are ignored.
 *
 * @throws RangeError when fewer than 32 bytes are given
 */
export function parseAudioStatus(payload: Uint8Array): AudioStatus {
  if (payload.length < AUDIO_STATUS_LENGTH) {
    throw new RangeError(`Audio status needs ${AUDIO_STATUS_LENGTH} bytes; got ${payload.length}.`);
  }
  const u16 = (o: number): number => payload[o] | (payload[o + 1] << 8);
  const u32 = (o: number): number =>
    (payload[o] | (payload[o + 1] << 8) | (payload[o + 2] << 16)) + payload[o + 3] * 2 ** 24;
  return {
    version: payload[0],
    mode: payload[1],
    state: payload[2],
    fault: payload[3],
    seconds: u32(4),
    silenceSamples: u32(8),
    escapeDrains: u16(12),
    writeErrors: u16(14),
    adfErrors: u32(16),
    adfSaturation: u32(20),
    fingerprintChunks: u32(24),
    fingerprintChunksSkipped: u32(28),
  };
}
