/**
 * Shimmer3R audio recording (DEV-99): configuration byte 233, which says
 * whether a unit records from its microphone while it logs to SD and what it
 * keeps; the recorder's status over Bluetooth; and the `.WAV` and `.AFP` files
 * it writes beside each data file under `audio/`.
 */

export {
  AUDIO_MODE_BYTE,
  AUDIO_MODE,
  AUDIO_GAIN_PRESET,
  AUDIO_MODE_OPTIONS,
  correctAudioMode,
  audioModeOf,
  audioGainPresetOf,
  recordsAudioFingerprint,
  recordsRawAudio,
  joinAudioMode,
  audioModeRecordsSpeech,
  encodeAudioMode,
  describeAudioMode,
  applyAudioModeRules,
} from './mode.js';
export type { AudioModeParts } from './mode.js';
export {
  AUDIO_OPCODES,
  AUDIO_STATUS_LENGTH,
  AUDIO_STATUS_VERSION,
  AUDIO_STATUS_BITS,
  AUDIO_STATE,
  AUDIO_FAULT,
  describeAudioState,
  describeAudioFault,
  isAudioFaultFatal,
  parseAudioStatus,
} from './status.js';
export type { AudioStatus } from './status.js';
export {
  AUDIO_FILE,
  AUDIO_FINGERPRINT_FILE,
  AUDIO_FILE_OPEN_REASON,
  AudioFileFormatError,
  parseAudioWavHeader,
  audioSampleTicks,
  parseAudioFingerprintHeader,
  parseAudioFingerprintRecord,
  parseAudioFingerprintFile,
  audioFingerprintRecordTicks,
} from './file.js';
export type {
  AudioFileIdentity,
  AudioWavHeader,
  AudioFingerprintHeader,
  AudioFingerprintRecord,
  AudioFingerprintChunk,
  AudioFingerprintFile,
} from './file.js';
