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
// Protocol command bytes
// ---------------------------------------------------------------------------

/** Request the device to send logged data. */
export const READ_DATA_REQ = new Uint8Array([0x12, 0x00, 0x00]);

/** Request the device to disconnect cleanly. */
export const DISCONNECT_REQ = new Uint8Array([0x2b, 0x00, 0x00]);

/** Acknowledge a correctly-received logged data payload. */
export const DATA_ACK = new Uint8Array([0x82, 0x00, 0x00]);

/** Negative-acknowledge a logged data payload (triggers retransmission). */
export const DATA_NACK = new Uint8Array([0x72, 0x00, 0x00]);

/** Header byte that signals End-of-Stream for logged data transfer. */
export const DATA_EOS_HDR = 0x42;

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
