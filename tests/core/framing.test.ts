import { describe, it, expect, vi } from 'vitest';
import { drainByteStream, NEED_MORE, RESYNC, type DrainVerdict } from '../../src/core/framing.js';

// drainByteStream is the shared half of reading a protocol off an unframed pipe
// (Web Serial, RFCOMM/SPP, a dock UART): accumulate, extract what the framer can
// size, drop what it cannot one byte at a time, hand back the tail. Both
// Shimmer3Client and Shimmer3RClient run on it, so the edge cases are pinned
// here once rather than twice through a transport.

/** Toy protocol: [opcode][len][payload…]. 0xFF is a bare one-byte message. */
const ONE_BYTE = 0xff;
function toyLength(buf: Uint8Array): number {
  if (buf.length === 0) return NEED_MORE;
  if (buf[0] === ONE_BYTE) return 1;
  if (buf[0] !== 0xa0 && buf[0] !== 0xb0) return RESYNC;
  if (buf.length < 2) return NEED_MORE;
  const total = 2 + buf[1];
  return buf.length < total ? NEED_MORE : total;
}

const drain = (bytes: number[], opts: Partial<Parameters<typeof drainByteStream>[1]> = {}) =>
  drainByteStream(new Uint8Array(bytes), { messageLength: toyLength, ...opts });

const asArrays = (msgs: Uint8Array[]): number[][] => msgs.map((m) => Array.from(m));

describe('drainByteStream', () => {
  it('returns nothing and keeps everything when the head is incomplete', () => {
    const r = drain([0xa0, 0x03, 1, 2]);
    expect(r.messages).toEqual([]);
    expect(Array.from(r.rest)).toEqual([0xa0, 0x03, 1, 2]);
    expect(r.stopped).toBe(false);
  });

  it('extracts several messages from one buffer, in wire order', () => {
    const r = drain([0xa0, 0x02, 1, 2, ONE_BYTE, 0xb0, 0x01, 9]);
    expect(asArrays(r.messages)).toEqual([[0xa0, 0x02, 1, 2], [ONE_BYTE], [0xb0, 0x01, 9]]);
    expect(Array.from(r.rest)).toEqual([]);
  });

  it('keeps the incomplete tail after the complete messages', () => {
    const r = drain([ONE_BYTE, 0xa0, 0x04, 1, 2]);
    expect(asArrays(r.messages)).toEqual([[ONE_BYTE]]);
    expect(Array.from(r.rest)).toEqual([0xa0, 0x04, 1, 2]);
  });

  it('resyncs ONE byte at a time, so garbage cannot swallow what follows it', () => {
    // The whole point of byte-at-a-time resync: two junk bytes cost two bytes,
    // not the valid message queued behind them.
    const r = drain([0x11, 0x22, ONE_BYTE]);
    expect(asArrays(r.messages)).toEqual([[ONE_BYTE]]);
    expect(Array.from(r.rest)).toEqual([]);
  });

  it('reports every dropped byte with its reason', () => {
    const onDrop = vi.fn();
    drain([0x11, ONE_BYTE], { onDrop });
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(0x11, 'resync');
  });

  it('never slices past the buffer when a framer over-reports a length', () => {
    // A framer should say NEED_MORE rather than a length it cannot cover; if one
    // misbehaves, stop rather than hand out a truncated message.
    const liar = (): number => 99;
    const r = drainByteStream(new Uint8Array([1, 2, 3]), { messageLength: liar });
    expect(r.messages).toEqual([]);
    expect(Array.from(r.rest)).toEqual([1, 2, 3]);
  });

  describe('inspect gate', () => {
    it('drops a gated byte and carries on', () => {
      const onDrop = vi.fn();
      const inspect = (buf: Uint8Array): DrainVerdict => (buf[0] === 0xa0 ? 'drop' : 'frame');
      // 0xA0 is framable, but the gate says it is out of context here.
      const r = drain([0xa0, 0x01, 7, ONE_BYTE], { inspect, onDrop });
      expect(onDrop).toHaveBeenCalledWith(0xa0, 'gated');
      // Only the 0xA0 byte is consumed, so its former payload resyncs away and
      // the following real message still arrives.
      expect(asArrays(r.messages)).toEqual([[ONE_BYTE]]);
    });

    it('stops on demand, leaving the byte and everything after it buffered', () => {
      const inspect = (buf: Uint8Array): DrainVerdict => (buf[0] === 0x00 ? 'stop' : 'frame');
      const r = drain([ONE_BYTE, 0x00, 1, 2, 3], { inspect });
      expect(asArrays(r.messages)).toEqual([[ONE_BYTE]]);
      expect(r.stopped).toBe(true);
      expect(Array.from(r.rest)).toEqual([0x00, 1, 2, 3]);
    });

    it('sees the whole remaining buffer, not just the head byte', () => {
      const seen: number[][] = [];
      const inspect = (buf: Uint8Array): DrainVerdict => {
        seen.push(Array.from(buf));
        return 'frame';
      };
      drain([ONE_BYTE, ONE_BYTE], { inspect });
      expect(seen).toEqual([[ONE_BYTE, ONE_BYTE], [ONE_BYTE]]);
    });
  });

  describe('coalesce hook', () => {
    const mergeOneByteWithNext = (msg: Uint8Array, rest: Uint8Array): number => {
      if (msg.length !== 1 || msg[0] !== ONE_BYTE) return 0;
      if (rest.length === 0 || rest[0] === ONE_BYTE) return 0;
      const next = toyLength(rest);
      if (next === NEED_MORE || next === RESYNC || rest.length < next) return 0;
      return next;
    };

    it('merges a message with the one that follows it', () => {
      const r = drain([ONE_BYTE, 0xa0, 0x02, 1, 2], { coalesce: mergeOneByteWithNext });
      expect(asArrays(r.messages)).toEqual([[ONE_BYTE, 0xa0, 0x02, 1, 2]]);
    });

    it('leaves the message alone when the follower is incomplete', () => {
      // The follower must arrive on its own later, not be truncated into this one.
      const r = drain([ONE_BYTE, 0xa0, 0x04, 1], { coalesce: mergeOneByteWithNext });
      expect(asArrays(r.messages)).toEqual([[ONE_BYTE]]);
      expect(Array.from(r.rest)).toEqual([0xa0, 0x04, 1]);
    });

    it('does not merge two of the same one-byte message', () => {
      const r = drain([ONE_BYTE, ONE_BYTE], { coalesce: mergeOneByteWithNext });
      expect(asArrays(r.messages)).toEqual([[ONE_BYTE], [ONE_BYTE]]);
    });

    it('ignores a hook asking for more bytes than remain', () => {
      const r = drain([ONE_BYTE, 0xa0, 0x01, 7], { coalesce: () => 999 });
      expect(asArrays(r.messages)).toEqual([[ONE_BYTE], [0xa0, 0x01, 7]]);
    });
  });

  it('is pure: the input buffer is never mutated', () => {
    const input = new Uint8Array([ONE_BYTE, 0xa0, 0x01, 7]);
    const copy = Array.from(input);
    drainByteStream(input, { messageLength: toyLength });
    expect(Array.from(input)).toEqual(copy);
  });

  it('returns copies, not views onto the caller buffer', () => {
    const input = new Uint8Array([0xa0, 0x01, 7]);
    const r = drainByteStream(input, { messageLength: toyLength });
    input.fill(0);
    expect(asArrays(r.messages)).toEqual([[0xa0, 0x01, 7]]);
  });

  it('handles an empty buffer', () => {
    const r = drain([]);
    expect(r.messages).toEqual([]);
    expect(r.rest.length).toBe(0);
    expect(r.stopped).toBe(false);
  });
});
