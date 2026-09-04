/**
 * Constants for the Shimmer wired/dock UART protocol.
 *
 * Ported from the Java driver's wiredProtocol package:
 *   com.shimmerresearch.comms.wiredProtocol.UartPacketDetails (UartPacketDetails.java)
 *   com.shimmerresearch.comms.wiredProtocol.AbstractCommsProtocolWired
 *
 * This is the protocol a Shimmer speaks when docked in a BasicDock/Base over the
 * dock's FTDI UART (host↔device). It is unrelated to the LiteProtocol used by
 * `Shimmer3Client` / `Shimmer3RClient` over Bluetooth — different framing,
 * commands, addressing and CRC.
 */

/** ASCII `$` — every packet starts with this byte (UartPacketDetails.java:28). */
export const UART_PACKET_HEADER = 0x24;

/**
 * Serial-line settings for the dock FTDI UART (SerialPortCommJssc.connect:
 * 8 data bits, 1 stop bit, no parity, no flow control; baud below). These are
 * transport-level hints — the codec/client are byte-pipe-agnostic — surfaced so
 * a Web Serial / native transport can configure the port. Baud from
 * AbstractSerialPortHal.SHIMMER_UART_BAUD_RATES.SHIMMER3_DOCKED = 115200.
 */
export const UART_DOCK_BAUD_RATE = 115200;

/**
 * UART packet commands (`enum UART_PACKET_CMD`, UartPacketDetails.java:34-54).
 * WRITE/READ are host→device requests; the rest are device→host responses.
 */
export const UART_PACKET_CMD = Object.freeze({
  /** Host→device: set a component property (expects ACK). */
  WRITE: 0x01,
  /** Device→host: the data payload for a READ (carries component+property). */
  DATA_RESPONSE: 0x02,
  /** Host→device: get a component property (expects DATA_RESPONSE). */
  READ: 0x03,
  /** Device→host: unrecognised command. */
  BAD_CMD_RESPONSE: 0xfc, // 252
  /** Device→host: bad argument. */
  BAD_ARG_RESPONSE: 0xfd, // 253
  /** Device→host: CRC mismatch on the received command. */
  BAD_CRC_RESPONSE: 0xfe, // 254
  /** Device→host: command accepted (the response to a successful WRITE). */
  ACK_RESPONSE: 0xff, // 255
} as const);
export type UartPacketCmd = (typeof UART_PACKET_CMD)[keyof typeof UART_PACKET_CMD];

/**
 * UART components — the addressable sub-systems (`enum UART_COMPONENT`,
 * UartPacketDetails.java:57-80).
 */
export const UART_COMPONENT = Object.freeze({
  MAIN_PROCESSOR: 0x01,
  BAT: 0x02,
  DAUGHTER_CARD: 0x03,
  PPG: 0x04,
  GSR: 0x05,
  LSM303DLHC_ACCEL: 0x06,
  MPU9X50_ACCEL: 0x07,
  BEACON: 0x08,
  RADIO_802154: 0x09,
  RADIO_BLUETOOTH: 0x0a,
  TEST: 0x0b,
} as const);
export type UartComponent = (typeof UART_COMPONENT)[keyof typeof UART_COMPONENT];

/** Access permission for a component/property (UartComponentPropertyDetails.PERMISSION). */
export type UartPermission = 'READ_ONLY' | 'WRITE_ONLY' | 'READ_WRITE';

/**
 * A component+property address, mirroring the Java
 * `UartComponentPropertyDetails` (component byte, property byte, permission,
 * human name). `mCompPropByteArray` in Java is simply `[component, property]`.
 */
export interface UartComponentProperty {
  readonly component: UartComponent;
  readonly property: number;
  readonly permission: UartPermission;
  /** Human-readable name (matches the Java `mPropertyName`). */
  readonly name: string;
}

const cp = (
  component: UartComponent,
  property: number,
  permission: UartPermission,
  name: string,
): UartComponentProperty => Object.freeze({ component, property, permission, name });

/**
 * The component/property table (`UART_COMPONENT_AND_PROPERTY`,
 * UartPacketDetails.java:98-160). Only the groups relevant to a docked
 * Shimmer3/3R identify + status + config path are surfaced, plus the factory
 * self-test; the GQ-only 802.15.4 radio entries are omitted (see README).
 */
export const UART_PROP = Object.freeze({
  MAIN_PROCESSOR: Object.freeze({
    ENABLE: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x00, 'READ_WRITE', 'ENABLE'),
    SAMPLE_RATE: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x01, 'READ_WRITE', 'SAMPLE_RATE'),
    MAC: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x02, 'READ_WRITE', 'MAC'),
    VER: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x03, 'READ_ONLY', 'VER'),
    /* Access flags verified against the firmware handler (log-and-stream-common
     * Comms/shimmer_dock_usart.c): UART_SET is implemented ONLY for
     * RWC_CFG_TIME (0x04) — writing it calls RTC_setTimeFromTicksPtr(), i.e.
     * this is the property that SETS the clock (payload from msToRtcBytesLE);
     * reading it returns the time at which the RTC was last configured.
     * CURR_LOCAL_TIME (0x05) is GET-only (current RTC value) — a SET is
     * answered with BAD_CMD. */
    RTC_CFG_TIME: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x04, 'READ_WRITE', 'RTC_CFG_TIME'),
    CURR_LOCAL_TIME: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x05, 'READ_ONLY', 'CURR_LOCAL_TIME'),
    INFOMEM: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x06, 'READ_WRITE', 'INFOMEM'),
    LED0_STATE: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x07, 'READ_WRITE', 'LED_TOGGLE'),
    DEVICE_BOOT: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x08, 'READ_ONLY', 'DEVICE_BOOT'),
    ENTER_BOOTLOADER: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x09, 'WRITE_ONLY', 'ENTER_BOOTLOADER'),
  }),
  /**
   * The factory self-test, addressed as a component whose PROPERTY byte is the
   * test type — there is no payload
   * (log-and-stream-common `Comms/shimmer_dock_usart.c:473-486`, which checks
   * the property against `FACTORY_TEST_COUNT` and answers BAD_CMD above it).
   * The same `factory_test_t` values the Bluetooth command takes
   * (`Test/shimmer_test.h:21-27`).
   *
   * Write-only, and unlike every other entry here the ACK is not the end of it:
   * the firmware then prints its report as raw text on this link. See
   * `WiredShimmerClient.runFactoryTest`.
   */
  TEST: Object.freeze({
    MAIN: cp(UART_COMPONENT.TEST, 0x00, 'WRITE_ONLY', 'FACTORY_TEST_MAIN'),
    LEDS: cp(UART_COMPONENT.TEST, 0x01, 'WRITE_ONLY', 'FACTORY_TEST_LEDS'),
    ICS: cp(UART_COMPONENT.TEST, 0x02, 'WRITE_ONLY', 'FACTORY_TEST_ICS'),
    LED_STATES: cp(UART_COMPONENT.TEST, 0x03, 'WRITE_ONLY', 'FACTORY_TEST_LED_STATES'),
  }),
  BAT: Object.freeze({
    ENABLE: cp(UART_COMPONENT.BAT, 0x00, 'READ_WRITE', 'ENABLE'),
    VALUE: cp(UART_COMPONENT.BAT, 0x02, 'READ_ONLY', 'VALUE'),
    FREQ_DIVIDER: cp(UART_COMPONENT.BAT, 0x06, 'READ_WRITE', 'DIVIDER'),
  }),
  GSR: Object.freeze({
    ENABLE: cp(UART_COMPONENT.GSR, 0x00, 'READ_WRITE', 'ENABLE'),
    RANGE: cp(UART_COMPONENT.GSR, 0x03, 'READ_WRITE', 'RANGE'),
    FREQ_DIVIDER: cp(UART_COMPONENT.GSR, 0x06, 'READ_WRITE', 'DIVIDER'),
  }),
  PPG: Object.freeze({
    ENABLE: cp(UART_COMPONENT.PPG, 0x00, 'READ_WRITE', 'ENABLE'),
    FREQ_DIVIDER: cp(UART_COMPONENT.PPG, 0x06, 'READ_WRITE', 'DIVIDER'),
  }),
  DAUGHTER_CARD: Object.freeze({
    CARD_ID: cp(UART_COMPONENT.DAUGHTER_CARD, 0x02, 'READ_WRITE', 'CARD_ID'),
    CARD_MEM: cp(UART_COMPONENT.DAUGHTER_CARD, 0x03, 'READ_WRITE', 'CARD_MEM'),
  }),
  LSM303DLHC_ACCEL: Object.freeze({
    ENABLE: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x00, 'READ_WRITE', 'ENABLE'),
    DATA_RATE: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x02, 'READ_WRITE', 'DATA_RATE'),
    RANGE: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x03, 'READ_WRITE', 'RANGE'),
    LP_MODE: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x04, 'READ_WRITE', 'LP_MODE'),
    HR_MODE: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x05, 'READ_WRITE', 'HR_MODE'),
    FREQ_DIVIDER: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x06, 'READ_WRITE', 'FREQ_DIVIDER'),
    CALIBRATION: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x07, 'READ_WRITE', 'CALIBRATION'),
  }),
  BEACON: Object.freeze({
    ENABLE: cp(UART_COMPONENT.BEACON, 0x00, 'READ_WRITE', 'ENABLE'),
    FREQ_DIVIDER: cp(UART_COMPONENT.BEACON, 0x06, 'READ_WRITE', 'DIVIDER'),
  }),
  BLUETOOTH: Object.freeze({
    VER: cp(UART_COMPONENT.RADIO_BLUETOOTH, 0x03, 'READ_ONLY', 'BT_FW_VER'),
  }),
});

/**
 * The ordered list of component/properties the Java config loops iterate
 * (`UartPacketDetails.mListOfUartCommandsConfig`, UartPacketDetails.java:172-197).
 *
 * NB: this list is GQ-oriented. `BasicDock.internalReadAllConfigByUart` only
 * issues each entry when the docked device's version is compatible
 * (`isVerCompatibleWithAnyOf`), and for a Shimmer3/3R the real configuration
 * path is InfoMem — not this list. It is surfaced here verbatim (same order) so
 * a caller can drive property-level get/set exactly as the Java does, and to
 * document precisely which properties the wired protocol exposes as discrete
 * commands. See README for what maps to the app config model.
 */
export const UART_CONFIG_COMMANDS: readonly UartComponentProperty[] = Object.freeze([
  UART_PROP.BAT.ENABLE,
  UART_PROP.BAT.FREQ_DIVIDER,
  UART_PROP.LSM303DLHC_ACCEL.ENABLE,
  UART_PROP.LSM303DLHC_ACCEL.DATA_RATE,
  UART_PROP.LSM303DLHC_ACCEL.RANGE,
  UART_PROP.LSM303DLHC_ACCEL.LP_MODE,
  UART_PROP.LSM303DLHC_ACCEL.HR_MODE,
  UART_PROP.LSM303DLHC_ACCEL.FREQ_DIVIDER,
  UART_PROP.LSM303DLHC_ACCEL.CALIBRATION,
  UART_PROP.GSR.ENABLE,
  UART_PROP.GSR.RANGE,
  UART_PROP.GSR.FREQ_DIVIDER,
  UART_PROP.BEACON.ENABLE,
  UART_PROP.BEACON.FREQ_DIVIDER,
]);

/**
 * Packet framing overhead (UartPacketDetails.java:30-31).
 * DATA = header + cmd + length + component + property (CRC counted in length).
 * OTHER = header + cmd + CRC-LSB + CRC-MSB.
 */
export const PACKET_OVERHEAD_RESPONSE_DATA = 5;
export const PACKET_OVERHEAD_RESPONSE_OTHER = 4;

/**
 * Request/response timing (AbstractCommsProtocolWired.java).
 * SERIAL_PORT_TIMEOUT = 500 ms (line 69), polled at 100 ms intervals in
 * `waitForResponse` (line 507). Retry is a dock-layer concern
 * (`AbstractDock.READ_MAC_RETRY_ATTEMPTS = 2`), not the comms layer.
 */
export const WIRED_DEFAULTS = Object.freeze({
  /** Per-request response timeout (ms). Matches Java SERIAL_PORT_TIMEOUT. */
  RESPONSE_TIMEOUT_MS: 500,
  /** MAC-read retry attempts, from AbstractDock.READ_MAC_RETRY_ATTEMPTS. */
  MAC_READ_RETRIES: 2,
});

/** Charging-status raw bytes (ShimmerBattStatusDetails.CHARGING_STATUS_BYTE). */
export const CHARGING_STATUS_BYTE = Object.freeze({
  SUSPENDED: 0xc0,
  FULLY_CHARGED: 0x40,
  PRECONDITIONING: 0x80,
  BAD_BATTERY: 0x00,
  UNKNOWN: 0xff,
} as const);

/** Parsed charging state (ShimmerBattStatusDetails.CHARGING_STATUS). */
export type ChargingStatus =
  'SUSPENDED' | 'FULLY_CHARGED' | 'CHARGING' | 'BAD_BATTERY' | 'UNKNOWN' | 'CHECKING' | 'ERROR';
