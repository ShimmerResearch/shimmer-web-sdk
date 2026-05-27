// ---------------------------------------------------------------------------
// Nordic UART Service (NUS) UUIDs used by Verisense devices
// ---------------------------------------------------------------------------

/** NUS primary service UUID. */
export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';

/** NUS TX characteristic UUID (host writes to this). */
export const NUS_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

/** NUS RX characteristic UUID (host subscribes to notifications from this). */
export const NUS_RX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// ---------------------------------------------------------------------------
// Verisense protocol command/property constants
// ---------------------------------------------------------------------------

/** Upper-nibble command classes used in protocol headers. */
export const ASM_COMMAND = Object.freeze({
  READ: 0x10,
  WRITE: 0x20,
  RESPONSE: 0x30,
  ACK: 0x40,
  NACK_BAD_HEADER_COMMAND: 0x50,
  NACK_BAD_HEADER_PROPERTY: 0x60,
  NACK_GENERIC: 0x70,
  ACK_NEXT_STAGE: 0x80,
} as const);

export type AsmCommand = (typeof ASM_COMMAND)[keyof typeof ASM_COMMAND];

/** Lower-nibble property IDs used in protocol headers. */
export const ASM_PROPERTY = Object.freeze({
  STATUS1: 0x01,
  DATA: 0x02,
  PRODUCTION_CONFIGURATION: 0x03,
  OPERATIONAL_CONFIGURATION: 0x04,
  TIME: 0x05,
  DFU_MODE: 0x06,
  PENDING_EVENTS: 0x07,
  TEST_MODE: 0x08,
  DEBUG_COMMAND: 0x09,
  STREAM_MODE: 0x0a,
  DEVICE_DISCONNECT: 0x0b,
  STATUS2: 0x0c,
} as const);

export type AsmProperty = (typeof ASM_PROPERTY)[keyof typeof ASM_PROPERTY];

/** Stream mode payload values. */
export const STREAM_MODE = Object.freeze({
  ENABLE: 0x01,
  DISABLE: 0x02,
} as const);

/** Test mode IDs documented by Verisense firmware. */
export const TEST_MODE_ID = Object.freeze({
  STOP: 0x00,
  FLASH_8MB_1: 0x01,
  FLASH_8MB_2: 0x02,
  FLASH_128MB_512MB: 0x03,
  EEPROM: 0x04,
  ACCEL1_LIS2DW12: 0x05,
  BATTERY_VOLTAGE: 0x06,
  USB_POWER: 0x07,
  ACCEL2_GYRO_LSM6DS3: 0x08,
  PPG_MAX86XXX: 0x09,
  BIOZ_MAX30002: 0x0b,
  ACCEL2_GYRO_LSM6DSV: 0x0c,
  MAG_LIS2MDL: 0x0d,
  ALL_TESTS: 0xff,
} as const);

export type TestModeId = (typeof TEST_MODE_ID)[keyof typeof TEST_MODE_ID];

/** Debug command IDs documented by Verisense firmware. */
export const DEBUG_COMMAND_ID = Object.freeze({
  FLASH_LOOKUP_TABLE_READ: 0x01,
  FLASH_LOOKUP_TABLE_ERASE: 0x02,
  RWC_SCHEDULER_READ: 0x03,
  ERASE_128MB_512MB_FLASH: 0x04,
  ERASE_8MB_FLASH_1: 0x05,
  ERASE_8MB_FLASH_2: 0x06,
  ERASE_OPERATIONAL_CONFIG: 0x07,
  ERASE_PRODUCTION_CONFIG: 0x08,
  CLEAR_PENDING_EVENTS: 0x09,
  ERASE_FLASH_AND_LOOKUP_TABLE: 0x0a,
  TEST_DATA_TRANSFER_LOOP: 0x0b,
  LOAD_TEST_LOOKUP_TABLE: 0x0c,
  LED_TEST: 0x0d,
  MAX86XXX_LED_TEST: 0x0e,
  CHECK_PAYLOAD_CRC_ERRORS: 0x0f,
  READ_EVENT_LOG: 0x10,
  POWER_PROFILER_TEST: 0x11,
  READ_RECORD_BUFFER_DETAILS: 0x12,
  SYSTEM_RESET: 0x13,
  IC_POWER_CONSUMPTION_TEST: 0x14,
  DELETE_ALL_BONDS: 0x15,
} as const);

export type DebugCommandId = (typeof DEBUG_COMMAND_ID)[keyof typeof DEBUG_COMMAND_ID];

// ---------------------------------------------------------------------------
// Operational config byte offsets
// ---------------------------------------------------------------------------

/**
 * Byte indices into the Verisense operational config blob (`op[OP_IDX.xxx]`).
 * Index 0 is the config version byte (must be 0x5A for a valid config).
 */
export const OP_IDX = Object.freeze({
  GEN_CFG_0: 1,
  GEN_CFG_1: 2,
  GEN_CFG_2: 3,
  GEN_CFG_3: 4,

  ACCEL1_CFG_0: 5,
  ACCEL1_CFG_1: 6,
  ACCEL1_CFG_2: 7,
  ACCEL1_CFG_3: 8,

  GYRO_ACCEL2_CFG_0: 10,
  GYRO_ACCEL2_CFG_1: 11,
  GYRO_ACCEL2_CFG_2: 12,
  GYRO_ACCEL2_CFG_3: 13,
  GYRO_ACCEL2_CFG_4: 14,
  GYRO_ACCEL2_CFG_5: 15,
  GYRO_ACCEL2_CFG_6: 16,
  GYRO_ACCEL2_CFG_7: 17,

  START_TIME: 21,
  END_TIME: 25,
  INACTIVE_TIMEOUT: 29,
  BLE_RETRY_COUNT: 30,
  BLE_TX_POWER: 31,
  BLE_DATA_TRANS_WKUP_INT_HRS: 32,
  BLE_DATA_TRANS_WKUP_TIME: 33,
  BLE_DATA_TRANS_WKUP_DUR: 35,
  BLE_DATA_TRANS_RETRY_INT: 36,
  BLE_STATUS_WKUP_INT_HRS: 38,
  BLE_STATUS_WKUP_TIME: 39,
  BLE_STATUS_WKUP_DUR: 41,
  BLE_STATUS_RETRY_INT: 42,
  BLE_RTC_SYNC_WKUP_INT_HRS: 44,
  BLE_RTC_SYNC_WKUP_TIME: 45,
  BLE_RTC_SYNC_WKUP_DUR: 47,
  BLE_RTC_SYNC_RETRY_INT: 48,

  ADC_CHANNEL_SETTINGS_0: 50,
  ADC_CHANNEL_SETTINGS_1: 51,
  ADAPTIVE_SCHEDULER_INT: 52,
  ADAPTIVE_SCHEDULER_FAILCOUNT_MAX: 54,
  PPG_REC_DUR_SECS_LSB: 55,
  PPG_REC_DUR_SECS_MSB: 56,
  PPG_REC_INT_MINS_LSB: 57,
  PPG_REC_INT_MINS_MSB: 58,
  PPG_FIFO_CONFIG: 59,
  PPG_MODE_CONFIG2: 60,
  PPG_MA_DEFAULT: 61,
  PPG_MA_MAX_RED_IR: 62,
  PPG_MA_MAX_GREEN_BLUE: 63,
  PPG_AGC_TARGET_PERCENT_OF_RANGE: 64,
  PPG_MA_LED_PILOT: 66,
  PPG_DAC1_CROSSTALK: 67,
  PPG_DAC2_CROSSTALK: 68,
  PPG_DAC3_CROSSTALK: 69,
  PPG_DAC4_CROSSTALK: 70,
  PROX_AGC_MODE: 71,
} as const);

export type OpIdx = keyof typeof OP_IDX;
