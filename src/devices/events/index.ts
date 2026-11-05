/**
 * The Shimmer3 / Shimmer3R event channel (DEV-971): configuration byte 232,
 * which sets what the user button does, what else starts SD logging and
 * whether the TTL input is recorded; and the timestamped button and TTL
 * records, from an event file on the card or streamed live over Bluetooth.
 */

export {
  BUTTON_LOG_MODE,
  BUTTON_MODE,
  LOG_TRIGGERS,
  BUTTON_MODE_OPTIONS,
  LOG_TRIGGER_OPTIONS,
  correctButtonLogMode,
  buttonModeOf,
  logTriggersOf,
  isTtlInputEnabled,
  recordsButtonPresses,
  isDoublePress,
  isLoggingDisabled,
  isButtonDisabled,
  doesPressToggleLogging,
  doesUndockStartLogging,
  nearestUserButtonEnable,
  allowsSingleTouch,
  withoutPressRecording,
  decodeButtonLogMode,
  encodeButtonLogMode,
  describeButtonLogMode,
  eventChannelBoardSupport,
  applyButtonLogModeRules,
} from './buttonLogMode.js';
export type {
  ButtonMode,
  LogTriggers,
  ButtonLogModeSettings,
  ButtonLogModeBehaviour,
  EventChannelBoardSupport,
} from './buttonLogMode.js';
export {
  EVENT_TICKS_PER_SECOND,
  EVENT_FILE,
  EVENT_RECORD_TYPE,
  EVENT_RECORD_FLAG,
  EVENT_CHANNEL,
  EVENT_INPUT,
  EVENT_FILE_OPEN_REASON,
  EVENT_CHANNEL_OPCODES,
  EVENT_FRAME_LENGTH,
  EVENT_CHANNEL_STATUS_LENGTH,
  EventFileFormatError,
  parseEventRecord,
  describeEventRecord,
  parseEventFile,
  eventTicksToUnixMs,
  eventFrameLength,
  parseEventFrame,
  parseEventChannelStatus,
} from './record.js';
export type { EventRecord, EventFileHeader, EventFile, EventChannelStatus } from './record.js';
