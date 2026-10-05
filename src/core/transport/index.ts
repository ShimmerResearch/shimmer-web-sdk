/**
 * Pluggable transport layer for the Shimmer device clients.
 *
 * A {@link ShimmerTransport} is a raw byte pipe (connect / write / notify /
 * disconnect) with no protocol knowledge. The clients construct a web transport
 * by default, so existing browser usage is unchanged; other runtimes (React
 * Native, Bluetooth Classic) can inject their own implementation.
 */
export type {
  ShimmerTransport,
  ShimmerTransportKind,
  TransportCapabilities,
  TransportWriteOptions,
  Unsubscribe,
  DiscoveredDevice,
  DeviceKind,
  TransportScanner,
} from './types.js';
export {
  WebBluetoothTransport,
  type WebBluetoothTransportOptions,
} from './WebBluetoothTransport.js';
export { WebSerialTransport, type WebSerialTransportOptions } from './WebSerialTransport.js';
export {
  LoopbackTransport,
  type LoopbackTransportOptions,
  type LoopbackWrite,
} from './LoopbackTransport.js';
