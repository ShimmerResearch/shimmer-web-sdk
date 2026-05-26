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

  abstract connect(...args: unknown[]): Promise<unknown>;
  abstract disconnect(...args: unknown[]): Promise<unknown>;
  abstract startStreaming(): Promise<void>;
  abstract stopStreaming(): Promise<void>;
}
