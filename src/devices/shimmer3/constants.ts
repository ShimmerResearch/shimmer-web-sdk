/**
 * Classic-Bluetooth (RFCOMM/SPP) Shimmer3 constants.
 *
 * The LiteProtocol opcode set, sensor bitmap, channel formats and timestamp
 * descriptors are byte-for-byte identical to the Shimmer3R, so they are
 * re-exported from `../shimmer3r/` rather than duplicated. Only the values that
 * are genuinely Shimmer3-classic-specific live here.
 */

// Re-export the shared LiteProtocol surface so Shimmer3 consumers import from one
// module (these are identical across the two device families).
export {
  OPCODES,
  BT_FEATURE,
  TIMESTAMP_FIELD,
  GSR_NAME,
  GSR_UNCAL_LIMIT_RANGE3,
  SHIMMER3_GSR_RESISTANCE_MIN_MAX_KOHMS,
  type Opcode,
  type TimestampFmt,
} from '../shimmer3r/constants.js';
export { SensorBitmapShimmer3 } from '../shimmer3r/SensorBitmap.js';
export type { SensorBitmapShimmer3Key } from '../shimmer3r/SensorBitmap.js';

export { SHIMMER3_SPP_UUID, SHIMMER3_SAMPLING_CLOCK_FREQ } from './protocol.js';
// Imported as well as re-exported: SHIMMER3_SPP_SERIAL_OPTIONS below needs the
// value in scope, and a re-export alone does not bind it locally.
import { SHIMMER3_SPP_UUID as SPP_UUID } from './protocol.js';

/**
 * The `WebSerialTransport` options that reach a Shimmer over classic Bluetooth.
 *
 * Both Bluetooth fields are required and they do different jobs, which is the
 * whole reason this is a constant rather than something each caller assembles:
 * `allowedBluetoothServiceClassIds` only *permits* Bluetooth ports to appear at
 * all, while `filters` is what *narrows* the picker to Shimmers. Supply the
 * permission alone and the picker lists every serial port and every paired
 * Bluetooth device, which is unusable — a mistake that has been made once
 * already, in the demos this constant replaces.
 *
 * Spread it and add whatever the call site needs on top:
 *
 * ```ts
 * new WebSerialTransport({ ...SHIMMER3_SPP_SERIAL_OPTIONS, bufferSize: 64 * 1024 })
 * ```
 *
 * Works on desktop Chrome/Edge 117+ and — because Android's Web Serial serves
 * RFCOMM and nothing else — on Android Chrome 138+, where the sensor must be
 * paired in system settings first. See `describePlatformSupport`.
 */
export const SHIMMER3_SPP_SERIAL_OPTIONS = Object.freeze({
  filters: [{ bluetoothServiceClassId: SPP_UUID }] as const,
  allowedBluetoothServiceClassIds: [SPP_UUID] as const,
  kind: 'rfcomm',
} as const);

/**
 * Connect-handshake defaults, ported from the timings/sequence in
 * com.shimmerresearch.bluetooth.ShimmerBluetooth.
 */
export const SHIMMER3_DEFAULTS = Object.freeze({
  /**
   * How long to drain-and-discard bytes after the dummy read that flushes the
   * RFCOMM buffer on connect. ShimmerBluetooth's dummy read polls the serial
   * buffer with short sleeps; 250 ms comfortably covers an ACK + response at
   * classic-BT latencies.
   */
  DUMMY_READ_DRAIN_MS: 250,
  /** Per-command ACK timeout (ms). */
  ACK_TIMEOUT_MS: 1500,
  /** Response (post-ACK) timeout (ms). */
  RESPONSE_TIMEOUT_MS: 2000,
  /**
   * Default streaming timestamp width. Classic Shimmer3 LogAndStream firmware
   * with version code ≥ 6 uses a 3-byte timestamp
   * (ShimmerObject#updateTimestampByteLength); older firmware uses 2 bytes.
   */
  TIMESTAMP_FMT: 'u24' as const,
});
