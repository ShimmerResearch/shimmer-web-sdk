/**
 * A set of listeners whose exceptions never reach the emitter.
 *
 * Every client keeps one of these for its "temp" handlers — the short-lived
 * callbacks a request registers to catch its own reply — and all four had
 * grown an identical copy of it, differing only in what they hand the
 * listeners (`Uint8Array`, `string`, `UartRxPacket`).
 *
 * Swallowing handler exceptions is not incidental tidiness, which is the
 * reason this is worth naming once rather than repeating. `drainByteStream`'s
 * `onMessage` hook documents that it **must not throw**: an exception there
 * escapes the drain, so the caller never receives the remaining tail, never
 * advances its accumulator, and re-delivers every message in that read on the
 * next one. What makes that safe is that all in-tree callers dispatch through
 * this emitter. Four hand-rolled copies could drift apart silently; one can be
 * tested, and is.
 */
export class HandlerSet<T> {
  private readonly _fns = new Set<(value: T) => void>();

  /**
   * @param onError Called with whatever a listener threw. Intended for a log
   *   line — it is invoked inside the emit loop, so if it throws, the
   *   remaining listeners are skipped and the exception escapes after all.
   */
  constructor(private readonly onError: (e: unknown) => void) {}

  /** Number of registered listeners. */
  get size(): number {
    return this._fns.size;
  }

  /** Register `fn`. Adding the same function twice registers it once. */
  add(fn: (value: T) => void): void {
    this._fns.add(fn);
  }

  /** Unregister `fn`. Safe to call for a function that was never added. */
  delete(fn: (value: T) => void): void {
    this._fns.delete(fn);
  }

  /** Drop every listener. */
  clear(): void {
    this._fns.clear();
  }

  /**
   * Hand `value` to every listener in registration order, reporting anything
   * thrown to `onError` and carrying on with the rest.
   */
  emit(value: T): void {
    this._fns.forEach((fn) => {
      try {
        fn(value);
      } catch (e) {
        this.onError(e);
      }
    });
  }
}
