/**
 * Bluetooth CRC mode for the Shimmer3 / Shimmer3R LiteProtocol.
 *
 * The firmware can append a CRC to everything it sends, in one of three modes,
 * selected by the host with `SET_CRC_COMMAND` (0x8b). With it on, a host can
 * *prove* a streaming frame is intact rather than inferring it from where the
 * preamble bytes fall, which is what keeps a stream from drifting out of sync
 * after a dropped byte.
 *
 * Three properties of the firmware's implementation shape this module, all read
 * from `log-and-stream-common`:
 *
 *  - **It is device-to-host only.** `checkCrc` is called from the EEPROM brand
 *    record and SD sync and from nowhere else — never on the Bluetooth command
 *    receive path — so a host never appends a CRC to a command, in any mode.
 *    Only inbound framing changes.
 *  - **The algorithm is the dock UART's.** `CRC/shimmer_crc.c:24` calls
 *    `platform_crcData`, which `Platform/platform_api.c:56-61` defines as
 *    `ShimSwCrc_calc` and neither platform overrides, and the dock protocol
 *    calls the same function (`Comms/shimmer_dock_usart.c:676,708`). So this
 *    module reuses {@link shimmerUartCrcCalc} rather than growing a third copy
 *    of a CRC that already exists twice in this SDK. Reimplementing its loop
 *    would be a mistake: the odd-length zero-pad means folding the bytes
 *    naively gives a different answer.
 *  - **One byte is the same CRC truncated.** `calculateCrcAndInsert`
 *    (`CRC/shimmer_crc.c:19-32`) computes over the whole message *including its
 *    header or opcode byte*, appends the low byte, and appends the high byte as
 *    well only in two-byte mode. So one-byte mode is not a weaker algorithm,
 *    just fewer bits of it on the wire.
 *
 * Note the firmware's CRC helper takes a `uint8_t` length, so at most 255 bytes
 * are covered. A worst-case Shimmer3R data packet is well inside that, but it
 * is a real bound rather than an oversight.
 */

import { shimmerUartCrcCalc } from '../dock/crc.js';
import { FW_ID, HW_ID } from '../infomem/layout.js';
import { statusPayloadBytesFor } from './protocol.js';

/** CRC modes the firmware accepts as `SET_CRC_COMMAND`'s only argument. */
export const CRC_MODE = Object.freeze({
  /**
   * No CRC on anything the device sends.
   *
   * The firmware's default. It sets this at startup
   * (`ShimBt_btCommsProtocolInit`, `Comms/shimmer_bt_uart.c:114`) and again on
   * every disconnect (`ShimBt_handleBtRfCommStateChange`, `:2624`), on both
   * platforms. Every Shimmer3R release does this, and every Shimmer3 release
   * from LogAndStream v0.15.000, so on those releases a CRC never outlives the
   * connection it was set on, and a host that wants one asks again on the next.
   *
   * Two cases can still start a link with a CRC on, and a host cannot tell them
   * from the usual one because the mode cannot be read back:
   *
   *  - **Shimmer3 LogAndStream v0.11.0 and older** (v0.15.000 was the next
   *    release). `SET_CRC_COMMAND` sets `crcChecksum` there, and only `Init()`
   *    clears it (shimmer3-firmware `LogAndStream_v0.11.0`,
   *    `LogAndStream/main.c:581`), so it lasts until the device next boots.
   *  - **A link the firmware never saw drop.** Web Bluetooth's `disconnect()`
   *    keeps the physical link up while anything else on the host is using the
   *    device (the spec's "garbage-collect the connection"), and the next
   *    `connect()` reuses it, so the firmware's disconnect branch never ran. An
   *    injected transport can do the same. `SHIMMER3_BT_COMMUNICATION_PROTOCOL.md`
   *    also leaves open whether the reset happens across a BLE reconnection the
   *    radio module handles without telling the firmware ("Still unverified").
   *
   * This SDK therefore assumes off on connect, because that is the side that
   * fails safe: expecting a trailer that is not there misplaces every frame
   * boundary, while expecting none when there is one costs only a resync.
   *
   * Shimmer3R firmware before LogAndStream v1.00.011 also goes back to off
   * whenever sensing stops, mid-connection and without telling the host. This
   * SDK does not turn a CRC on there: see {@link SHIMMER3R_LINK_CRC_MIN_FIRMWARE}.
   */
  OFF: 0,
  /** Low byte of the CRC-16 appended to everything the device sends. */
  ONE_BYTE: 1,
  /**
   * Both bytes appended, low first.
   *
   * On Shimmer3R LogAndStream v1.00.024 to v1.00.049 this overruns the status
   * push unless its ACK prefix is off: see {@link twoByteCrcOverrunsStatusPush}.
   */
  TWO_BYTE: 2,
} as const);

/** A valid `SET_CRC_COMMAND` argument: 0, 1 or 2. */
export type CrcMode = (typeof CRC_MODE)[keyof typeof CRC_MODE];

/**
 * True when `mode` is one the firmware understands.
 *
 * Worth checking, because the firmware does not: `SET_CRC_COMMAND` casts
 * `args[0]` straight into its enum (`shimmer_bt_uart.c:933-937`), so a bad
 * value from a host becomes an out-of-range mode on the device with no
 * complaint. Rejecting it here is the only thing standing in the way.
 */
export function isCrcMode(mode: unknown): mode is CrcMode {
  return mode === CRC_MODE.OFF || mode === CRC_MODE.ONE_BYTE || mode === CRC_MODE.TWO_BYTE;
}

/**
 * How many bytes `mode` adds to the end of every message the device sends.
 * Numerically the mode itself, which is why the firmware writes
 * `packet_length += crcMode`; named so callers read as intent, not arithmetic.
 */
export function crcTrailerBytes(mode: CrcMode): 0 | 1 | 2 {
  return mode;
}

/**
 * Append `mode`'s CRC to `msg`, returning a new array.
 *
 * A host has no reason to call this — the firmware does not check commands —
 * but a test double pretending to *be* the firmware does, and building its
 * frames with the same function the verifier uses is what stops the two
 * drifting apart.
 *
 * A new array in EVERY mode, off included. Returning `msg` itself when there is
 * nothing to append would make the return value sometimes owned and sometimes
 * aliased, so a caller that retained or wrote through it would mutate its own
 * input in exactly one mode. The copy costs nothing at the sizes this is used
 * at, and callers are test doubles building frames rather than a hot path.
 */
export function appendCrc(msg: Uint8Array, mode: CrcMode): Uint8Array {
  if (mode === CRC_MODE.OFF) return new Uint8Array(msg);
  const [lsb, msb] = shimmerUartCrcCalc(msg, msg.length);
  const out = new Uint8Array(msg.length + mode);
  out.set(msg, 0);
  out[msg.length] = lsb;
  if (mode === CRC_MODE.TWO_BYTE) out[msg.length + 1] = msb;
  return out;
}

/**
 * Check the CRC on a complete inbound message: `msg` is the payload followed by
 * `mode` trailing bytes.
 *
 * Mirrors the firmware's own `checkCrc` (`CRC/shimmer_crc.c:56-77`), including
 * that one-byte mode compares the low byte only and that `CRC_OFF` is vacuously
 * valid — a caller that has no CRC to check has nothing to reject.
 */
export function verifyCrc(msg: Uint8Array, mode: CrcMode): boolean {
  if (mode === CRC_MODE.OFF) return true;
  const payloadLen = msg.length - mode;
  if (payloadLen < 1) return false;
  const [lsb, msb] = shimmerUartCrcCalc(msg, payloadLen);
  if (msg[payloadLen] !== lsb) return false;
  return mode === CRC_MODE.ONE_BYTE || msg[payloadLen + 1] === msb;
}

/**
 * The first Shimmer3R firmware this SDK turns a link CRC on for: LogAndStream
 * v1.00.011.
 *
 * Every release before it, v0.00.002 to v1.00.010 (November and December
 * 2024), turns the CRC off by itself whenever sensing stops, in
 * `S4Sens_stopSensing` (shimmer3r-firmware `S3R_Production/S4_App/s4_sensing.c`,
 * `:354` at v1.00.010). The host is not told. The clear arrived with 43926e49
 * and was removed by c8016de3, and v1.00.011 was the first release without it.
 * Every later release turns the CRC off only at startup and on disconnect.
 *
 * The stop's own ACK still carries the trailer. `BtUart_processCmd` schedules
 * the stop (task bit 12) and then the ACK (bit 6), and the task loop always
 * runs the lowest bit first (`S4_NORM_Task_getCurrent`), so the ACK is built
 * while the CRC is still on (`shimmer_bt_comms.c:2344`). Every reply after it
 * is bare, so a host still expecting the trailer waits for bytes that never
 * come, and the exchange after the stop is lost.
 *
 * A host cannot track the clear instead. `stopSensing` runs for more than the
 * host's own stops: STOP_STREAMING (0x20), STOP_SDBT (0x97) and STOP_LOGGING
 * (0x93), but also the user button and docking, which end SD logging without
 * the host asking. Nothing tells the host that the CRC went with them: a dock
 * pushes a status, but no status carries the CRC mode. Its own stops are no
 * easier, because the stream still in flight and the stop's ACK both carry the
 * CRC, so the moment the device stopped adding it cannot be seen from the host.
 */
export const SHIMMER3R_LINK_CRC_MIN_FIRMWARE = Object.freeze({
  major: 1,
  minor: 0,
  internal: 11,
} as const);

/**
 * True unless the firmware turns the link CRC off by itself whenever sensing
 * stops, which Shimmer3R LogAndStream did before
 * {@link SHIMMER3R_LINK_CRC_MIN_FIRMWARE}.
 *
 * The hardware decides which version line the number belongs to, because
 * Shimmer3 and Shimmer3R LogAndStream versions overlap. No Shimmer3 firmware
 * clears the CRC at a stop: every LogAndStream tag from v0.15.000 clears it only
 * at startup and on disconnect, and v0.11.0 and older only at startup.
 *
 * The hardware is taken as the device reports it, and one build reports it
 * wrongly. LogAndStream_Shimmer3R v1.00.008 is a side build for older Consensys,
 * v1.00.007 with `OLD_CONSENSYS_SUPPORT` set, and it reports hardware 3. It does
 * clear the CRC, but it sends exactly what a Shimmer3 on LogAndStream v1.00.008
 * sends, so it passes here. That is deliberate: refusing every Shimmer3 on that
 * release would be wrong far more often.
 *
 * Firmware other than LogAndStream returns true. No Shimmer3R build of anything
 * else is known, so there is no source to judge it by.
 *
 * HARDWARE-VERIFY: derived from the firmware source (the task order and both
 * clear sites at v1.00.010) and a scripted device. No Shimmer3R on v1.00.010 or
 * earlier has been run against this SDK.
 *
 * @param hardwareVersion The DEVICE_VERSION_RESPONSE hardware id: 10 for a
 *   Shimmer3R, 3 for a Shimmer3.
 * @param fw The FW_VERSION_RESPONSE, as `Shimmer3RClient.readFwVersion()`
 *   returns it. `patch` is the firmware's internal version number.
 */
export function keepsLinkCrcWhenSensingStops(
  hardwareVersion: number,
  fw: Readonly<{ fwId: number; major: number; minor: number; patch: number }>,
): boolean {
  if (hardwareVersion !== HW_ID.SHIMMER_3R || fw.fwId !== FW_ID.LOGANDSTREAM) return true;
  return isAtLeast(fw, SHIMMER3R_LINK_CRC_MIN_FIRMWARE);
}

/**
 * The Shimmer3R firmware that made room for a 2-byte CRC in its unsolicited
 * status push: LogAndStream v1.00.050.
 *
 * Before it, the firmware builds the push in a six-byte stack buffer,
 * `uint8_t selfcmd[6]` (`ShimBt_instreamStatusRespSend`, log-and-stream-common
 * `Comms/shimmer_bt_uart.c:2262` at f39be8c1f, which v1.00.049 pins). The push
 * is the ACK prefix, 0x8A 0x71, the status bytes and the CRC. From v1.00.024 the
 * status is two bytes (`SHIMMER3R_TWO_BYTE_STATUS_MIN_FIRMWARE`), so a 2-byte
 * CRC makes seven, and `calculateCrcAndInsert` (`:2275`) writes the seventh past
 * the end of the buffer. The sensor hardfaults: DEV-621, "Streaming + SDLogging
 * (Triggered on Undock) with 2 bytes CRC enabled causing hardfaults".
 *
 * v1.00.050 sizes the buffer `3 + STATUS_BYTE_COUNT + CRC_MAX_SUPPORTED_BYTES`
 * (log-and-stream-common merge 4fb8696). It resized no other buffer, and none
 * needed it.
 */
export const SHIMMER3R_STATUS_PUSH_BUFFER_FIX_FIRMWARE = Object.freeze({
  major: 1,
  minor: 0,
  internal: 50,
} as const);

/**
 * True when a 2-byte link CRC overruns this firmware's unsolicited status push
 * for as long as the push carries its ACK prefix: Shimmer3R LogAndStream
 * v1.00.024 to v1.00.049. See {@link SHIMMER3R_STATUS_PUSH_BUFFER_FIX_FIRMWARE}
 * for the overrun.
 *
 * The overrun needs all three of the prefix, two status bytes and a 2-byte CRC.
 * Take any one away and the push is six bytes, which fits:
 *
 *  - **A 1-byte CRC.**
 *  - **One status byte.** v1.00.023 and earlier send one, and so does every
 *    Shimmer3 release. The width comes from {@link statusPayloadBytesFor}, so
 *    this boundary and the status framing's cannot drift apart.
 *  - **The prefix off.** It is on by default: `ShimBt_resetBtResponseVars` sets
 *    `useAckPrefixForInstreamResponses = 1` (`Comms/shimmer_bt_uart.c:185` at
 *    f39be8c1f). SET_INSTREAM_RESPONSE_ACK_PREFIX_STATE (0xA3) sets it from its
 *    argument (`:867`), and `Shimmer3RClient.setCrcMode` sends it, with 0,
 *    before a 2-byte CRC wherever this is true.
 *
 * The firmware pushes whenever its state changes for a reason the host did not
 * cause:
 *
 *  - docking and undocking (`log_and_stream_common.c:297,314`);
 *  - sensing starting or stopping because of the user button, a trial-duration
 *    expiry or a low battery (`ShimBt_instreamStatusRespSendIfNotBtCmd`,
 *    `:2242`, called from `TaskList/shimmer_taskList.c:127,131`).
 *
 * The host's own starts and stops do not push. So the overrun waits for an
 * event that can come at any point in a session, mid-stream included, and long
 * after the CRC went on.
 *
 * Any hardware but a Shimmer3R returns false, as does firmware other than
 * LogAndStream.
 *
 * Read off the firmware source at every Shimmer3R tag from v1.00.011 to
 * v1.00.051.
 *
 * @param hardwareVersion The DEVICE_VERSION_RESPONSE hardware id: 10 for a
 *   Shimmer3R, 3 for a Shimmer3.
 * @param fw The FW_VERSION_RESPONSE, as `Shimmer3RClient.readFwVersion()`
 *   returns it. `patch` is the firmware's internal version number.
 */
export function twoByteCrcOverrunsStatusPush(
  hardwareVersion: number,
  fw: Readonly<{ fwId: number; major: number; minor: number; patch: number }>,
): boolean {
  return (
    statusPayloadBytesFor(hardwareVersion, fw) === 2 &&
    !isAtLeast(fw, SHIMMER3R_STATUS_PUSH_BUFFER_FIX_FIRMWARE)
  );
}

/** True when `fw` is `min` or later. `patch` is the firmware's internal number. */
function isAtLeast(
  fw: Readonly<{ major: number; minor: number; patch: number }>,
  min: Readonly<{ major: number; minor: number; internal: number }>,
): boolean {
  return (
    fw.major > min.major ||
    (fw.major === min.major &&
      (fw.minor > min.minor || (fw.minor === min.minor && fw.patch >= min.internal)))
  );
}
