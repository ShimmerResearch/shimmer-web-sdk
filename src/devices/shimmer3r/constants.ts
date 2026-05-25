/**
 * Shimmer3R BLE protocol opcodes.
 */
export const OPCODES = Object.freeze({
  DATA: 0x00,
  INQUIRY_CMD: 0x01,
  INQUIRY_RSP: 0x02,
  SAMPLING_RATE: 0x05,
  START_STREAM: 0x07,
  SET_SENSORS_CMD: 0x08,
  GSR_RANGE_RSP: 0x20,
  SET_GSR_RANGE: 0x21,
  STOP_STREAM: 0x20,
  ACK: 0xff,
  SET_INTERNAL_EXP_POWER_ENABLE_CMD: 0x5e,
  START_BT_STREAM_SD_LOGGING: 0x70,
  STOP_BT_STREAM_SD_LOGGING: 0x97,
} as const);

export type Opcode = (typeof OPCODES)[keyof typeof OPCODES];

/** Default BLE service / characteristic UUIDs for Shimmer3R. */
export const SHIMMER3R_DEFAULTS = Object.freeze({
  SERVICE_UUID: '65333333-a115-11e2-9e9a-0800200ca100',
  /** Write characteristic (host → device). */
  CHAR_RX_UUID: '65333333-a115-11e2-9e9a-0800200ca102',
  /** Notify characteristic (device → host). */
  CHAR_TX_UUID: '65333333-a115-11e2-9e9a-0800200ca101',
} as const);

/**
 * Timestamp field descriptors keyed by width.
 * Shimmer3R firmware ≥ v1.0.22 always uses u24.
 */
export const TIMESTAMP_FIELD = Object.freeze({
  u16: { name: 'TIMESTAMP', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  u24: { name: 'TIMESTAMP', fmt: 'u24', endian: 'le', sizeBytes: 3 },
} as const);

export type TimestampFmt = 'u16' | 'u24';

/** GSR signal name constant used in ObjectCluster fields. */
export const GSR_NAME = 'GSR';

/** ADC limit below which GSR range-3 calibration is clamped. */
export const GSR_UNCAL_LIMIT_RANGE3 = 683;

/**
 * Shimmer3R GSR resistance min/max per hardware range (kΩ).
 * Index 0 = range 0 (8–63 kΩ) … index 3 = range 3 (680–4700 kΩ).
 */
export const SHIMMER3_GSR_RESISTANCE_MIN_MAX_KOHMS: ReadonlyArray<[number, number]> = [
  [8.0, 63.0],
  [63.0, 220.0],
  [220.0, 680.0],
  [680.0, 4700.0],
];
