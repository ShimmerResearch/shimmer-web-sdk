import type { HandlerSet } from './handlerSet.js';

/**
 * Which link a client is on, so that work begun on one link can neither finish
 * with the next link's traffic nor carry on over it.
 *
 * A client's connection is a sequence of links: `connect()` starts one, and a
 * drop or a `disconnect()` ends it. Work that spans awaits - a command waiting
 * for its ACK, a read waiting for its reply, a handshake issuing one command
 * after another - is begun on one link, and nothing in the bytes says which
 * link they came over. So a waiter left over from a dropped link took the next
 * link's ACK or reply, and an operation stranded part-way went on issuing its
 * later commands to whatever the client was connected to next.
 *
 * The rule: an operation captures {@link current} before its first write and
 * hands it to every step, and the client calls {@link reset} wherever a link
 * ends or a new one begins. Every step still waiting then fails at once, and
 * every later one is refused.
 *
 * Kept in one place, as {@link HandlerSet} is, because each part of it closes a
 * hole that review found one at a time: a waiter failed at the reset itself,
 * not at the next link's traffic or its own timeout ({@link listen}); a write
 * the transport is still holding ({@link run}); and a reply that settles in
 * the same turn as the drop ({@link settled}).
 */
export class LinkGeneration {
  private _current = 0;

  /** How to fail each waiter registered for the link in place, until it settles. */
  private readonly _waiters = new Set<() => void>();

  /** The link in place now. Capture it before an operation's first write. */
  get current(): number {
    return this._current;
  }

  /** Number of waiters registered for the link in place. */
  get size(): number {
    return this._waiters.size;
  }

  /** Whether `link` is still the link in place. */
  isCurrent(link: number): boolean {
    return link === this._current;
  }

  /**
   * Throw `gone()` if `link` has been reset. For a step that nothing else would
   * stop - a buffer flush, or whatever follows a best-effort write whose error
   * is swallowed.
   */
  throwIfReset(link: number, gone: () => Error): void {
    if (link !== this._current) throw gone();
  }

  /**
   * End the link in place: move to the next generation, then fail every waiter
   * registered for the old one. They fail after the move, so a waiter that asks
   * {@link isCurrent} as it fails sees its link gone. Each `fail` must not
   * throw: one that did would leave the waiters after it registered.
   */
  reset(): void {
    this._current++;
    const waiters = [...this._waiters];
    this._waiters.clear();
    for (const fail of waiters) fail();
  }

  /**
   * Call `fail` when `link` is reset - at once, if it already has been.
   *
   * @returns the waiter's unregister. Call it when the waiter settles any other
   *   way; until then the reset still holds it.
   */
  onReset(link: number, fail: () => void): () => void {
    if (link !== this._current) {
      fail();
      return () => undefined;
    }
    this._waiters.add(fail);
    return () => {
      this._waiters.delete(fail);
    };
  }

  /**
   * Add `handler` to `listeners` for as long as `link` lasts. The reset removes
   * it and calls `fail`, which must clear the waiter's timer and reject it. On
   * a link already reset `fail` runs at once, and the handler is never added.
   *
   * @returns the waiter's own unregister, for its other settle paths.
   */
  listen<T>(
    listeners: HandlerSet<T>,
    link: number,
    handler: (value: T) => void,
    fail: () => void,
  ): () => void {
    if (link !== this._current) {
      fail();
      return () => undefined;
    }
    listeners.add(handler);
    const unregister = this.onReset(link, () => {
      listeners.delete(handler);
      fail();
    });
    return () => {
      listeners.delete(handler);
      unregister();
    };
  }

  /**
   * Start `work` on `link` and settle as it does - unless `link` is reset
   * first, which rejects with `gone()` at once. On a link already reset `work`
   * is never started. `work` is an async function, so it cannot throw before
   * it returns its promise.
   *
   * For a write. A transport can hold one as its link goes down, and a write
   * that failed only when the old transport let go resumed its caller - and
   * its caller's cleanup - against whatever link had replaced it by then.
   */
  run<T>(link: number, work: () => Promise<T>, gone: () => Error): Promise<T> {
    if (link !== this._current) return Promise.reject(gone());
    return new Promise<T>((resolve, reject) => {
      const unregister = this.onReset(link, () => reject(gone()));
      work().then(
        (value) => {
          unregister();
          resolve(value);
        },
        (e: unknown) => {
          unregister();
          reject(e);
        },
      );
    });
  }

  /**
   * `p`, failed with `gone()` instead if `link` has been reset by the time its
   * value would reach the caller. A rejection passes through unchanged.
   *
   * A waiter settles, and leaves the reset's reach, inside the message that
   * completes it. When the transport reports the link down in that same turn,
   * before any continuation has run, the reset cannot see the waiter, and its
   * result would otherwise reach its caller after the next link had begun.
   */
  async settled<T>(p: Promise<T>, link: number, gone: () => Error): Promise<T> {
    const value = await p;
    if (link !== this._current) throw gone();
    return value;
  }
}

/**
 * What a waiter fails with when its link is reset under it. Every such error
 * says "The link was reset", whichever client raised it.
 */
export function linkResetError(what: string): Error {
  return new Error(`The link was reset while waiting for ${what}`);
}
