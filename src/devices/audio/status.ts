/**
 * The Shimmer3R audio recorder's status (DEV-99): the bits it adds to status
 * byte 1, which are all a host is told over Bluetooth, and the fault codes the
 * session's audio files carry.
 *
 * Format: log-and-stream-common `docs/SHIMMER3R_AUDIO.md` §5 and
 * `docs/SHIMMER3_BT_COMMUNICATION_PROTOCOL.md` §5.3; the bits are
 * `ShimAudio_statusBits` (`Audio/shimmer_audio.c`).
 *
 * HARDWARE-VERIFY: decoded from the firmware source only; no unit has answered
 * this SDK yet.
 */

/** Status byte 1 bits the recorder sets, beside bit 0, USB plugged in. */
export const AUDIO_STATUS_BITS = Object.freeze({
  /** Audio is being captured for the current log. */
  RECORDING: 0x02,
  /** This session's audio failed or was degraded; cleared when the next session starts. */
  FAULT: 0x04,
  /** This firmware records audio and this board has a microphone. Never changes while it runs. */
  AVAILABLE: 0x08,
} as const);

/**
 * Byte 97 of each audio file's header: the session's first fault. Status byte
 * 1's fault bit says only that there was one. {@link AUDIO_FAULT.OVERRUN} and {@link AUDIO_FAULT.FP_BEHIND} are
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
