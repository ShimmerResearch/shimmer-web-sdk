/**
 * Reading a protocol off an unframed pipe: the sentinels every framer returns,
 * and the drain loop that turns a framer into message boundaries.
 *
 * A **framer** is a pure function `(buf) => number` reporting how many bytes the
 * message at the head of `buf` occupies — the length knowledge the Java driver
 * encodes in its blocking `readBytes(n)` calls, expressed as a function. Each
 * device family owns its own (`shimmer3ControlMessageLength`,
 * `shimmer3rControlMessageLength`, the dock's `wiredPacketLength`), because that
 * part genuinely differs per protocol.
 *
 * The **drain** ({@link drainByteStream}) is the part that does not differ, so it
 * lives here once: accumulate, extract every complete message, resynchronise
 * past what cannot be framed, hand back the tail. `Shimmer3Client` and
 * `Shimmer3RClient` both run on it, differing only in their framer and in two
 * small hooks ({@link DrainOptions.inspect}, {@link DrainOptions.coalesce}).
 *
 * `src/devices/shimmer3/protocol.ts` and `src/devices/dock/protocol.ts` each
 * predate this module and export their own identically-valued sentinel copies;
 * they are public API and are left alone. New framers should import from here.
 */

/** Not enough bytes buffered yet to determine the message length. */
export const NEED_MORE = -1;

/**
 * The leading byte is not the start of a message we understand — the caller
 * should drop one byte and retry (resynchronise) rather than guess a length.
 */
export const RESYNC = 0;

/** A framer: total length of the message at the head of `buf`, or a sentinel. */
export type MessageLengthFn = (buf: Uint8Array) => number;

/**
 * What {@link drainByteStream} should do with the byte at the head of the
 * buffer, before any framing is attempted.
 *
 * - `frame` — the normal path: consult the framer.
 * - `drop` — consume this one byte and carry on. For an opcode that is only
 *   valid in a context the caller tracks (an INQUIRY_RESPONSE with no inquiry
 *   outstanding is a stray stream byte, and framing it would swallow real
 *   control traffic).
 * - `stop` — end the drain, leaving this byte and everything after it in
 *   {@link DrainResult.rest}. For bytes that belong to another plane entirely,
 *   such as stream data whose length only the schema knows.
 */
export type DrainVerdict = 'frame' | 'drop' | 'stop';

/** Why a byte was consumed without becoming a message (for logging). */
export type DropReason = 'resync' | 'gated';

export interface DrainOptions {
  /** Framer for the protocol being drained. */
  messageLength: MessageLengthFn;
  /**
   * Per-head-byte gate, evaluated before framing. Defaults to always `frame`.
   * Called with the whole remaining buffer so a gate can look past byte 0.
   */
  inspect?: (buf: Uint8Array) => DrainVerdict;
  /**
   * Chance to merge the message that follows `msg` into it, returning how many
   * extra bytes to consume (0 = leave them for the next iteration). `rest`
   * starts immediately after `msg`.
   *
   * This exists because BLE coalesces an ACK with the response written straight
   * after it into a single notification, and clients built against BLE depend on
   * that. A drain that emitted them separately would deliver the response before
   * the awaiting caller had registered its handler.
   */
  coalesce?: (msg: Uint8Array, rest: Uint8Array) => number;
  /** Notified for every byte dropped, so callers can log without duplicating the loop. */
  onDrop?: (byte: number, reason: DropReason) => void;
}

export interface DrainResult {
  /** Complete messages, in wire order. */
  messages: Uint8Array[];
  /** Bytes not consumed — the caller stores this back as its accumulator. */
  rest: Uint8Array;
  /** True when {@link DrainOptions.inspect} returned `stop`. */
  stopped: boolean;
}

/**
 * Rebuild message boundaries from an unframed byte stream.
 *
 * The shared half of what a client reading from Web Serial, RFCOMM/SPP or a dock
 * UART has to do: accumulate, extract every complete message the framer can
 * size, drop what cannot be framed one byte at a time (never guessing a length),
 * and hand back the incomplete tail. Pure — no client state is touched — so the
 * awkward cases are unit-testable without a transport.
 *
 * Byte-at-a-time resynchronisation is the deliberate choice over flushing the
 * buffer on garbage: a corrupt byte then costs one byte, not every valid message
 * queued behind it.
 */
export function drainByteStream(buf: Uint8Array, opts: DrainOptions): DrainResult {
  const { messageLength, inspect, coalesce, onDrop } = opts;
  const messages: Uint8Array[] = [];
  let rest: Uint8Array = buf;
  let stopped = false;

  for (;;) {
    if (rest.length === 0) break;

    if (inspect) {
      const verdict = inspect(rest);
      if (verdict === 'stop') {
        stopped = true;
        break;
      }
      if (verdict === 'drop') {
        onDrop?.(rest[0], 'gated');
        rest = rest.subarray(1);
        continue;
      }
    }

    const len = messageLength(rest);
    if (len === NEED_MORE) break;
    if (len === RESYNC) {
      onDrop?.(rest[0], 'resync');
      rest = rest.subarray(1);
      continue;
    }
    // Defensive: a framer should report NEED_MORE rather than a length it cannot
    // yet cover, but never slice past the end of the buffer if one does.
    if (rest.length < len) break;

    const msg = new Uint8Array(rest.subarray(0, len));
    rest = rest.subarray(len);

    const extra = coalesce ? coalesce(msg, rest) : 0;
    if (extra > 0 && extra <= rest.length) {
      const merged = new Uint8Array(msg.length + extra);
      merged.set(msg, 0);
      merged.set(rest.subarray(0, extra), msg.length);
      messages.push(merged);
      rest = rest.subarray(extra);
      continue;
    }

    messages.push(msg);
  }

  return {
    messages,
    rest: rest.length ? new Uint8Array(rest) : new Uint8Array(0),
    stopped,
  };
}
