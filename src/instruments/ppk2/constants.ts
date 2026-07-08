/**
 * Nordic Power Profiler Kit II (PPK2) — USB serial protocol constants.
 *
 * The PPK2 enumerates as a USB CDC ACM serial device (Nordic Semiconductor
 * VID 0x1915, PID 0xC00A). Commands are raw byte sequences with no framing;
 * the device only ever transmits (a) an ASCII metadata blob in response to
 * GET_META_DATA and (b) a continuous stream of 4-byte little-endian sample
 * words between AVERAGE_START and AVERAGE_STOP.
 *
 * Ported from the reference implementation `ppk2_api` (Python), which itself
 * mirrors Nordic's pc-nrfconnect-ppk application.
 */

export const PPK2_USB_VENDOR_ID = 0x1915;
export const PPK2_USB_PRODUCT_ID = 0xc00a;

/** CDC ACM — the baud rate is nominal, any value works. */
export const PPK2_BAUD_RATE = 9600;

/** Fixed hardware sampling rate of the current-measurement stream. */
export const PPK2_SAMPLES_PER_SECOND = 100_000;

/** Bytes per sample word in the measurement stream. */
export const PPK2_SAMPLE_BYTES = 4;

/** Serial command opcodes. */
export const PPK2_CMD = Object.freeze({
  NO_OP: 0x00,
  TRIGGER_SET: 0x01,
  AVG_NUM_SET: 0x02,
  TRIGGER_WINDOW_SET: 0x03,
  TRIGGER_INTERVAL_SET: 0x04,
  TRIGGER_SINGLE_SET: 0x05,
  AVERAGE_START: 0x06,
  AVERAGE_STOP: 0x07,
  RANGE_SET: 0x08,
  LCD_SET: 0x09,
  TRIGGER_STOP: 0x0a,
  DEVICE_RUNNING_SET: 0x0c,
  REGULATOR_SET: 0x0d,
  SWITCH_POINT_DOWN: 0x0e,
  SWITCH_POINT_UP: 0x0f,
  /** Shared opcode: [0x11, 0x01] = ampere meter, [0x11, 0x02] = source meter. */
  SET_POWER_MODE: 0x11,
  RES_USER_SET: 0x12,
  SPIKE_FILTERING_ON: 0x15,
  SPIKE_FILTERING_OFF: 0x16,
  GET_META_DATA: 0x19,
  RESET: 0x20,
  SET_USER_GAINS: 0x25,
} as const);

export type Ppk2Command = (typeof PPK2_CMD)[keyof typeof PPK2_CMD];

/** Source/input voltage limits accepted by the regulator (mV). */
export const PPK2_VDD_MIN_MV = 800;
export const PPK2_VDD_MAX_MV = 5000;
