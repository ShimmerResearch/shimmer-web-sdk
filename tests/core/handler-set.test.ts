import { describe, it, expect, vi } from 'vitest';
import { HandlerSet } from '../../src/core/handlerSet.js';

// The four clients each hand-rolled this emitter, so none of it was pinned
// anywhere. The error-swallowing in particular is load-bearing: it is what
// lets `drainByteStream` promise that dispatching a message cannot abort the
// drain and strand its accumulator.

const boom = new Error('handler exploded');

describe('HandlerSet', () => {
  it('delivers to every listener, in registration order', () => {
    const seen: string[] = [];
    const hs = new HandlerSet<number>(() => {});
    hs.add((n) => seen.push(`a${n}`));
    hs.add((n) => seen.push(`b${n}`));

    hs.emit(1);

    expect(seen).toEqual(['a1', 'b1']);
  });

  it('carries on past a throwing listener and still reaches the later ones', () => {
    const seen: string[] = [];
    const onError = vi.fn();
    const hs = new HandlerSet<number>(onError);
    hs.add(() => seen.push('first'));
    hs.add(() => {
      throw boom;
    });
    hs.add(() => seen.push('third'));

    expect(() => hs.emit(0)).not.toThrow();

    expect(seen).toEqual(['first', 'third']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('reports a non-Error throw unchanged, rather than wrapping it', () => {
    const onError = vi.fn();
    const hs = new HandlerSet<void>(onError);
    hs.add(() => {
      throw 'a string';
    });

    hs.emit(undefined);

    expect(onError).toHaveBeenCalledWith('a string');
  });

  it('registers a given function once, however often it is added', () => {
    const fn = vi.fn();
    const hs = new HandlerSet<number>(() => {});
    hs.add(fn);
    hs.add(fn);

    expect(hs.size).toBe(1);
    hs.emit(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops delivering to a removed listener, and ignores removing an unknown one', () => {
    const fn = vi.fn();
    const hs = new HandlerSet<number>(() => {});
    hs.add(fn);
    hs.delete(fn);
    expect(() => hs.delete(vi.fn())).not.toThrow();

    hs.emit(1);

    expect(fn).not.toHaveBeenCalled();
    expect(hs.size).toBe(0);
  });

  it('clear() drops every listener', () => {
    const fn = vi.fn();
    const hs = new HandlerSet<number>(() => {});
    hs.add(fn);
    hs.add(vi.fn());
    hs.clear();

    hs.emit(1);

    expect(hs.size).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('emits nothing and does not throw when empty', () => {
    const onError = vi.fn();
    const hs = new HandlerSet<number>(onError);

    expect(() => hs.emit(1)).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  it('lets an onError that throws escape, as its docblock warns', () => {
    // Pinned because it is the one way a listener's exception can still reach
    // the emitter: the reporter is called inside the loop. Callers pass a log
    // line, so this does not bite in practice — but a future caller passing
    // something fallible should find this test rather than a surprise.
    const hs = new HandlerSet<number>(() => {
      throw new Error('reporter exploded');
    });
    const later = vi.fn();
    hs.add(() => {
      throw boom;
    });
    hs.add(later);

    expect(() => hs.emit(1)).toThrow('reporter exploded');
    expect(later).not.toHaveBeenCalled();
  });
});
