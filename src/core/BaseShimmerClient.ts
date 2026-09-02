import type { IShimmerClient, ShimmerClientOptions } from './types.js';
import type { ObjectCluster } from './ObjectCluster.js';

/**
 * Abstract base class shared by all Shimmer device clients.
 *
 * Provides:
 * - A `debug` flag and `_log` helper.
 * - Stub implementations of `onStatus` and `onStreamFrame` callback properties.
 * - Abstract stubs for `connect`, `disconnect`, `startStreaming`, and `stopStreaming`
 *   that concrete sub-classes must override.
 *
 * Sub-classes should call `this._emitStatus(msg)` to surface status strings to
 * the application layer without depending on a particular event-emitter library.
 */
export abstract class BaseShimmerClient implements IShimmerClient {
  /** Enable verbose console logging. */
  debug: boolean;

  /**
   * Invoked whenever the client emits a human-readable status message
   * (e.g. "GATT connected", "Sampling rate ACKed. Applied ≈ 51.200 Hz").
   */
  onStatus: ((msg: string) => void) | null = null;

  /**
   * Invoked for every fully-decoded sensor frame while streaming.
   * The exact shape depends on the concrete sub-class:
   * - `Shimmer3RClient` passes an {@link ObjectCluster}.
   * - `VerisenseBleDevice` passes a streaming packet object (see that class).
   */
  onStreamFrame: ((frame: ObjectCluster) => void) | null = null;

  /**
   * Invoked when the link to the device goes away **without the application
   * asking for it**: the sensor was switched off, walked out of BLE range, or
   * its USB / classic-Bluetooth COM port was unplugged. `reason` carries the
   * transport's error when it supplied one.
   *
   * Deliberately NOT invoked by {@link disconnect}. A caller that closed the
   * link already knows it did, so firing there would make every teardown look
   * like a fault and force applications to filter their own action back out —
   * exactly the reconnect-loop trap this callback exists to avoid. Put shared
   * teardown after your own `await disconnect()` instead.
   *
   * Fires at most once per connection: a transport that reports the same drop
   * twice, or a `disconnect()` issued to clean up after a drop, is collapsed to
   * the first notification.
   */
  onDisconnect: ((reason?: Error) => void) | null = null;

  constructor(opts: ShimmerClientOptions = {}) {
    this.debug = opts.debug ?? true;
  }

  /** Log to console when debug is enabled. */
  protected _log(...args: unknown[]): void {
    if (this.debug) console.log('[Shimmer]', ...args);
  }

  /** Emit a status message to `onStatus` and to the debug log. */
  protected _emitStatus(msg: string): void {
    this._log(msg);
    this.onStatus?.(msg);
  }

  /** Set once {@link onDisconnect} has fired (or been suppressed) for the current connection. */
  private _disconnectNotified = true;

  /**
   * Arm {@link onDisconnect} for a fresh connection. Sub-classes call this from
   * `connect()`, so the next drop is reported even after an earlier one.
   */
  protected _armDisconnectNotification(): void {
    this._disconnectNotified = false;
  }

  /**
   * Mark the current connection's drop as already accounted for, so a transport
   * event arriving after an application-initiated `disconnect()` cannot surface
   * as a fault. Sub-classes call this from `disconnect()`.
   */
  protected _suppressDisconnectNotification(): void {
    this._disconnectNotified = true;
  }

  /**
   * Report an unexpected transport drop to {@link onDisconnect}, at most once
   * per connection. Sub-classes call this from their transport-disconnect
   * handler — never from `disconnect()`. A throwing handler is logged and
   * swallowed: the drop has already happened, so there is nothing to fail.
   */
  protected _emitDisconnect(reason?: Error): void {
    if (this._disconnectNotified) return;
    this._disconnectNotified = true;
    try {
      this.onDisconnect?.(reason);
    } catch (e) {
      this._log('onDisconnect handler error', e);
    }
  }

  abstract connect(...args: unknown[]): Promise<unknown>;
  abstract disconnect(...args: unknown[]): Promise<unknown>;
  abstract startStreaming(): Promise<void>;
  abstract stopStreaming(): Promise<void>;
}
