/**
 * Shimmer transport abstraction (Phase 1 refactor).
 *
 * The device clients (`Shimmer3RClient`, `VerisenseBleDevice`) used to call
 * `navigator.bluetooth` / `navigator.serial` directly. That hard-wiring was the
 * single blocker to running the clients on React Native (react-native-ble-plx)
 * or over Bluetooth Classic (RFCOMM/SPP). This module extracts that byte pipe
 * behind {@link ShimmerTransport} so the clients become transport-consumers.
 *
 * Design rules the implementations MUST honour:
 *
 * - A transport does **no** protocol interpretation whatsoever — no ACK
 *   detection, no framing, no re-chunking. All framing/ACK/schema logic stays in
 *   the clients (and is pure).
 * - {@link ShimmerTransport.onNotify} delivers each inbound notification as the
 *   *exact* bytes received, preserving notification chunk boundaries. Shimmer3R's
 *   ACK-remainder handling depends on a response being piggybacked in the same
 *   chunk as its ACK, so a transport must never merge or re-split chunks.
 * - {@link TransportCapabilities} lets a client learn about an MTU-bounded pipe so
 *   it can chunk large writes when needed; a browser BLE write is MTU-bounded,
 *   RFCOMM is effectively unbounded.
 *
 * A web BLE implementation maps `write` → write-characteristic `writeValue`,
 * `onNotify` → notify-characteristic `characteristicvaluechanged`, and
 * `onDisconnect` → `gattserverdisconnected`. See {@link WebBluetoothTransport},
 * {@link WebSerialTransport}, and the in-repo {@link LoopbackTransport} used by
 * the test suites.
 */

/**
 * Which physical pipe a transport speaks over.
 *
 * Distinct from the Verisense client's public `TransportKind`
 * (`'ble' | 'serial' | null`), which describes that client's currently active
 * connection rather than a transport implementation.
 */
export type ShimmerTransportKind = 'ble' | 'serial' | 'rfcomm' | 'loopback' | 'mock';

/** Device families the app understands (used for scan filtering + UI). */
export type DeviceKind = 'shimmer3' | 'shimmer3r' | 'verisense';

/** Unsubscribe handle returned by the `on*` registration methods. */
export type Unsubscribe = () => void;

/**
 * Optional transport capabilities the clients can query to adapt framing.
 * BLE reports an MTU-bounded `maxWriteBytes`; RFCOMM is effectively unbounded.
 */
export interface TransportCapabilities {
  /**
   * Max bytes accepted by a single {@link ShimmerTransport.write}, if bounded.
   * Undefined means unbounded / unknown (the client should not chunk).
   */
  maxWriteBytes?: number;
  /**
   * True when the transport preserves message boundaries (BLE notifications
   * arrive one chunk per {@link ShimmerTransport.onNotify} call). A byte-stream
   * pipe such as Web Serial is not framed.
   */
  framed: boolean;
}

/** Per-write options. */
export interface TransportWriteOptions {
  /**
   * Request an acknowledged (write-with-response) transfer. When omitted the
   * transport applies its own default (see each implementation). Ignored by
   * transports that do not distinguish the two (e.g. Web Serial).
   */
  withResponse?: boolean;
}

/**
 * A bidirectional byte pipe to a single Shimmer device.
 *
 * Lifecycle: `connect()` → any number of `write()` / notify callbacks →
 * `disconnect()`. Implementations must deliver notification payloads as the
 * exact bytes received (no protocol interpretation) so the pure protocol layer
 * above stays transport-agnostic.
 */
export interface ShimmerTransport {
  /** The pipe kind — lets clients special-case (e.g. RFCOMM chunking). */
  readonly kind: ShimmerTransportKind;

  /**
   * Capability hints. `framed` is known up front; `maxWriteBytes` may only be
   * populated once connected (best-effort before then).
   */
  readonly capabilities: TransportCapabilities;

  /** Advertised device name, when the transport can supply one (for labels). */
  readonly deviceName?: string;

  /** Open the connection (and start notifications). Rejects on failure. */
  connect(): Promise<void>;

  /** Close the connection. Safe to call more than once. */
  disconnect(): Promise<void>;

  /** Send a command frame to the device (host → device). */
  write(data: Uint8Array, opts?: TransportWriteOptions): Promise<void>;

  /**
   * Register a listener for inbound notification chunks (device → host).
   * Each call delivers one notification's exact bytes. Returns an unsubscribe
   * function.
   */
  onNotify(cb: (data: Uint8Array) => void): Unsubscribe;

  /**
   * Register a listener for unexpected / requested disconnects.
   * `reason` is set when the link dropped rather than being closed by us.
   * Returns an unsubscribe function.
   */
  onDisconnect(cb: (reason?: Error) => void): Unsubscribe;
}

/**
 * A device surfaced by a {@link TransportScanner} during discovery.
 * `id` is the stable handle a transport uses to (re)connect.
 */
export interface DiscoveredDevice {
  /** Stable transport-specific identifier (BLE peripheral id / MAC / mock id). */
  id: string;
  /** Advertised name, if any. */
  name: string;
  /** Best guess at the device family from the advertisement. */
  kind: DeviceKind;
  /** Received signal strength (dBm), if the transport reports it. */
  rssi?: number;
}

/**
 * Device discovery, decoupled from the connection pipe.
 *
 * On BLE this wraps a scan (Web Bluetooth `requestLEScan` / ble-plx
 * `startDeviceScan`); on RFCOMM it wraps classic inquiry. The app calls
 * `startScan`, receives {@link DiscoveredDevice}s via the callback, then
 * constructs a {@link ShimmerTransport} for the chosen device id.
 *
 * Not consumed by the SDK clients today (they select a device at connect time
 * via the platform picker); included as part of the agreed transport contract so
 * platform transports (e.g. React Native) implement a consistent shape.
 */
export interface TransportScanner {
  readonly kind: ShimmerTransportKind;

  /**
   * Begin scanning. `onDevice` fires once per discovered (or updated) device.
   * Implementations should de-duplicate by `id` where the platform allows.
   */
  startScan(onDevice: (device: DiscoveredDevice) => void): Promise<void>;

  /** Stop an in-progress scan. Safe to call when not scanning. */
  stopScan(): Promise<void>;
}
