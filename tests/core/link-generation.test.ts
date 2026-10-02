import { describe, it, expect, vi } from 'vitest';
import { HandlerSet } from '../../src/core/handlerSet.js';
import { LinkGeneration, linkResetError } from '../../src/core/linkGeneration.js';

// The rules a client's reconnect handling rests on, pinned once here rather
// than through every client that uses them: work begun on one link fails at
// its reset, is refused on a link already gone, and never completes with what
// belongs to the next link.

const gone = (): Error => new Error('gone');

describe('LinkGeneration', () => {
  it('moves to a new link at each reset', () => {
    const links = new LinkGeneration();
    const first = links.current;
    expect(links.isCurrent(first)).toBe(true);

    links.reset();

    expect(links.isCurrent(first)).toBe(false);
    expect(links.isCurrent(links.current)).toBe(true);
    expect(() => links.throwIfReset(first, gone)).toThrow('gone');
    expect(() => links.throwIfReset(links.current, gone)).not.toThrow();
  });

  it('fails every waiter at the reset, once, with its link already gone', () => {
    const links = new LinkGeneration();
    const link = links.current;
    const seen: boolean[] = [];
    links.onReset(link, () => seen.push(links.isCurrent(link)));
    links.onReset(link, () => seen.push(links.isCurrent(link)));

    links.reset();
    links.reset();

    expect(seen).toEqual([false, false]);
    expect(links.size).toBe(0);
  });

  it('leaves a waiter that unregistered when it settled', () => {
    const links = new LinkGeneration();
    const fail = vi.fn();
    const unregister = links.onReset(links.current, fail);

    unregister();
    links.reset();

    expect(fail).not.toHaveBeenCalled();
  });

  it('fails a waiter for a link already reset at once, and keeps nothing', () => {
    const links = new LinkGeneration();
    const old = links.current;
    links.reset();
    const fail = vi.fn();

    links.onReset(old, fail);

    expect(fail).toHaveBeenCalledTimes(1);
    expect(links.size).toBe(0);
  });

  describe('listen', () => {
    it('hears its link until the reset, which removes it and fails it', () => {
      const links = new LinkGeneration();
      const set = new HandlerSet<number>(() => {});
      const heard: number[] = [];
      const fail = vi.fn();
      links.listen(set, links.current, (n) => heard.push(n), fail);

      set.emit(1);
      links.reset();
      set.emit(2);

      expect(heard).toEqual([1]);
      expect(fail).toHaveBeenCalledTimes(1);
      expect(set.size).toBe(0);
    });

    it('removes itself from both on its own settle path', () => {
      const links = new LinkGeneration();
      const set = new HandlerSet<number>(() => {});
      const fail = vi.fn();
      const off = links.listen(set, links.current, () => {}, fail);

      off();
      links.reset();

      expect(set.size).toBe(0);
      expect(links.size).toBe(0);
      expect(fail).not.toHaveBeenCalled();
    });

    it('never listens on a link already reset', () => {
      const links = new LinkGeneration();
      const old = links.current;
      links.reset();
      const set = new HandlerSet<number>(() => {});
      const fail = vi.fn();

      links.listen(set, old, () => {}, fail);

      expect(fail).toHaveBeenCalledTimes(1);
      expect(set.size).toBe(0);
    });
  });

  describe('run', () => {
    it('settles as its work does, and unregisters', async () => {
      const links = new LinkGeneration();
      await expect(links.run(links.current, async () => 7, gone)).resolves.toBe(7);
      await expect(
        links.run(
          links.current,
          async () => {
            throw new Error('write failed');
          },
          gone,
        ),
      ).rejects.toThrow('write failed');
      expect(links.size).toBe(0);
    });

    it('fails at the reset while its work is still held', async () => {
      const links = new LinkGeneration();
      let release = (): void => undefined;
      const held = new Promise<void>((r) => (release = r));
      const run = links.run(links.current, () => held, gone);

      links.reset();

      await expect(run).rejects.toThrow('gone');
      release(); // the work settling later changes nothing
      await expect(run).rejects.toThrow('gone');
    });

    it('never starts its work on a link already reset', async () => {
      const links = new LinkGeneration();
      const old = links.current;
      links.reset();
      const work = vi.fn(async () => undefined);

      await expect(links.run(old, work, gone)).rejects.toThrow('gone');
      expect(work).not.toHaveBeenCalled();
    });
  });

  describe('settled', () => {
    it('delivers a value while its link lasts', async () => {
      const links = new LinkGeneration();
      await expect(links.settled(Promise.resolve(3), links.current, gone)).resolves.toBe(3);
    });

    it('fails a value that settled before a reset its caller had not yet seen', async () => {
      const links = new LinkGeneration();
      const p = links.settled(Promise.resolve(3), links.current, gone);
      links.reset(); // in the same turn, before any continuation has run

      await expect(p).rejects.toThrow('gone');
    });

    it('passes a rejection through unchanged', async () => {
      const links = new LinkGeneration();
      const p = links.settled(Promise.reject(new Error('ACK timeout')), links.current, gone);
      links.reset();

      await expect(p).rejects.toThrow('ACK timeout');
    });
  });
});

describe('linkResetError', () => {
  it('says the link was reset, and what was being waited for', () => {
    expect(linkResetError('the ACK').message).toBe('The link was reset while waiting for the ACK');
  });
});
