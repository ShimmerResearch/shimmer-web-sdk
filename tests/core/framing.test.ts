import { describe, it, expect, vi } from 'vitest';
import {
  drainByteStream,
  NEED_MORE,
  RESYNC,
  type DrainOptions,
  type DrainVerdict,
} from '../../src/core/framing.js';

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

/*
 * Typed against DrainOptions own Uint8Array default rather than
 * `Parameters<typeof drainByteStream>`, which erases the generic to `unknown`:
 * the `onMessage` callbacks below would receive `unknown` and `r.messages`
 * would not be a `Uint8Array[]`, so none of this file would type-check.
 */
const drain = (bytes: number[], opts: Partial<Omit<DrainOptions, 'decode'>> = {}) =>
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

  describe('decode hook', () => {
    // Modelled on the dock UART: frame by length, then validate a CRC. A packet
    // that frames but fails validation must resync by ONE byte, because a bad
    // CRC is evidence the framing itself was wrong — the real header may be a
    // byte or two further on, and skipping the whole span would step over it.
    const decodeSum = (msg: Uint8Array): { total: number } | null => {
      // Toy "CRC": the last payload byte must equal the sum of the ones before.
      const payload = msg.subarray(2);
      if (payload.length === 0) return null;
      const want = payload[payload.length - 1];
      let sum = 0;
      for (let i = 0; i < payload.length - 1; i++) sum = (sum + payload[i]) & 0xff;
      return sum === want ? { total: sum } : null;
    };

    it('returns decoded messages, not raw bytes', () => {
      const r = drainByteStream(new Uint8Array([0xa0, 0x03, 5, 6, 11]), {
        messageLength: toyLength,
        decode: decodeSum,
      });
      expect(r.messages).toEqual([{ total: 11 }]);
      expect(Array.from(r.rest)).toEqual([]);
    });

    it('resyncs ONE byte when decode refuses, not the whole framed span', () => {
      const onDrop = vi.fn();
      // First packet's checksum is wrong (12 != 5+6). Dropping only its header
      // byte lets the parser find the valid packet that starts inside it.
      const bad = [0xa0, 0x03, 5, 6, 12];
      const good = [0xa0, 0x02, 7, 7];
      const r = drainByteStream(new Uint8Array([...bad, ...good]), {
        messageLength: toyLength,
        decode: decodeSum,
        onDrop,
      });
      expect(onDrop).toHaveBeenCalledWith(0xa0, 'rejected');
      expect(r.messages).toEqual([{ total: 7 }]);
      expect(Array.from(r.rest)).toEqual([]);
    });

    it('finds a real packet that starts INSIDE a rejected one', () => {
      // Why refusal must resync by one byte and not by the framed length: here a
      // stray 0xA0 0x03 makes the framer claim a 5-byte packet that swallows the
      // start of the genuine one. Byte-at-a-time recovery walks into it and finds
      // the real header; skipping the claimed 5 bytes would land past it and lose
      // the packet entirely.
      const r = drainByteStream(new Uint8Array([0xa0, 0x03, 0xa0, 0x02, 7, 7]), {
        messageLength: toyLength,
        decode: decodeSum,
      });
      expect(r.messages).toEqual([{ total: 7 }]);
      expect(Array.from(r.rest)).toEqual([]);
    });

    it('decodes the coalesced buffer, not the pre-merge message', () => {
      const seen: number[][] = [];
      const r = drainByteStream(new Uint8Array([ONE_BYTE, 0xa0, 0x02, 7, 7]), {
        messageLength: toyLength,
        coalesce: (msg, rest) =>
          msg.length === 1 && msg[0] === ONE_BYTE && rest.length ? toyLength(rest) : 0,
        decode: (msg) => {
          seen.push(Array.from(msg));
          return msg.length;
        },
      });
      expect(seen).toEqual([[ONE_BYTE, 0xa0, 0x02, 7, 7]]);
      expect(r.messages).toEqual([5]);
    });
  });

  describe('onMessage dispatch ordering', () => {
    // The whole point of the hook: hooks that read caller state must see updates
    // a handler makes. Both Shimmer clients decrement gate counters synchronously
    // inside the handler that receives a message.
    it('dispatches each message before inspecting the next head', () => {
      // This gate allows exactly one framed message, and the handler closes it.
      // Collect-then-dispatch would inspect both heads while the gate was still
      // open, framing two.
      let allow = 1;
      const seen: number[][] = [];
      const r = drain([ONE_BYTE, ONE_BYTE], {
        inspect: () => (allow > 0 ? 'frame' : 'drop'),
        onMessage: (m) => {
          allow -= 1;
          seen.push(Array.from(m));
        },
      });
      expect(seen).toEqual([[ONE_BYTE]]);
      // The second byte was gated away, not framed.
      expect(Array.from(r.rest)).toEqual([]);
    });

    it('leaves messages empty when onMessage handles dispatch', () => {
      const seen: number[][] = [];
      const r = drain([ONE_BYTE, 0xa0, 0x01, 7], {
        onMessage: (m) => void seen.push(Array.from(m)),
      });
      expect(seen).toEqual([[ONE_BYTE], [0xa0, 0x01, 7]]);
      expect(r.messages).toEqual([]);
    });

    it('still collects into messages when onMessage is omitted', () => {
      const r = drain([ONE_BYTE, 0xa0, 0x01, 7]);
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

describe('drainByteStream type soundness', () => {
  it('refuses a decoded type with no decode to inhabit it', () => {
    interface MyPacket {
      kind: 'mine';
      n: number;
    }
    const len = (b: Uint8Array): number => (b.length >= 2 ? 2 : NEED_MORE);

    // A compile-time assertion, not a runtime one. Without the overload split
    // this call type-checks, and the implementation's `payload as unknown as T`
    // then hands `onMessage` a raw Uint8Array the compiler believes is a
    // MyPacket -- a cast that only fails much later, wherever the caller first
    // reads a property that was never there. Written as @ts-expect-error so the
    // build fails if the call ever becomes legal again.
    // @ts-expect-error `decode` is required whenever T is not Uint8Array
    drainByteStream<MyPacket>(new Uint8Array([1, 2]), {
      messageLength: len,
      onMessage: (m: MyPacket) => void m.n,
    });

    // The same call WITH a decode is the supported form, and does compile.
    const decoded: MyPacket[] = [];
    drainByteStream<MyPacket>(new Uint8Array([1, 2]), {
      messageLength: len,
      decode: (msg) => ({ kind: 'mine', n: msg.length }),
      onMessage: (m) => decoded.push(m),
    });
    expect(decoded).toEqual([{ kind: 'mine', n: 2 }]);
  });
});
