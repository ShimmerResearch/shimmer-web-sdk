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

/**
 * Why a byte was consumed without becoming a message (for logging).
 *
 * - `resync` — the framer could not size a message here.
 * - `gated` — {@link DrainOptions.inspect} rejected the byte as out of context.
 * - `rejected` — the framer sized a message but {@link DrainOptions.decode}
 *   refused it (a failed CRC, a malformed body).
 */
export type DropReason = 'resync' | 'gated' | 'rejected';

export interface DrainOptions<T = Uint8Array> {
  /** Framer for the protocol being drained. */
  messageLength: MessageLengthFn;
  /**
   * Turn a framed message into whatever the caller's handlers consume, or return
   * `null` to refuse it. Omit to receive the raw bytes.
   *
   * Refusal deliberately resynchronises by **one byte**, not by the whole span:
   * a packet that framed but failed its CRC is evidence that the framing itself
   * was wrong — the real packet header may be a byte or two further on, and
   * skipping the whole supposed length would step over it. This mirrors the Java
   * driver's `parseSinglePacket` CRC-fail path.
   */
  decode?: (msg: Uint8Array) => T | null;
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
  /**
   * Dispatch each message the moment it is extracted, before the next head byte
   * is inspected. When omitted, messages are collected into
   * {@link DrainResult.messages} and the caller dispatches them afterwards.
   *
   * **Use this whenever `inspect` or `coalesce` read state that a handler
   * mutates synchronously.** Both Shimmer clients do: delivering a response
   * decrements the gate counters (`_awaitInq`/`_awaitCmd`) or the expected-ACK
   * count inside the handler, not on a later microtask. Collecting first would
   * evaluate every hook against the state as it was before *any* message was
   * delivered — so a stray 0x02 following a genuine INQUIRY_RESPONSE in the same
   * read would still look "awaited" and get framed, swallowing the bytes behind
   * it instead of being dropped.
   *
   * **Must not throw.** An exception here escapes `drainByteStream`, so the
   * caller never receives {@link DrainResult.rest} and never advances its
   * accumulator — every message in that read would be delivered again on the
   * next one. All three in-tree callers dispatch through an emit helper that
   * swallows handler exceptions, which is what makes this safe today.
   */
  onMessage?: (msg: T) => void;
  /** Notified for every byte dropped, so callers can log without duplicating the loop. */
  onDrop?: (byte: number, reason: DropReason) => void;
}

export interface DrainResult<T = Uint8Array> {
  /** Complete messages, in wire order — decoded when a `decode` was supplied. */
  messages: T[];
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
 *
 * Pass {@link DrainOptions.onMessage} to have each message dispatched as it is
 * extracted. That ordering matters whenever `inspect` or `coalesce` consult state
 * a handler mutates synchronously — see that option's note.
 */
export function drainByteStream(
  buf: Uint8Array,
  opts: DrainOptions<Uint8Array> & { decode?: undefined },
): DrainResult<Uint8Array>;
/**
 * Drain into decoded values of type `T`.
 *
 * `decode` is REQUIRED in this form, and that is the whole point of splitting
 * the signature: `T` is only ever inhabited by what `decode` returns, so
 * `drainByteStream<MyPacket>(buf, { messageLength, onMessage })` — no `decode` —
 * must not compile. It used to, and the implementation's cast then handed
 * `onMessage` a raw `Uint8Array` that the compiler believed was a `MyPacket`.
 */
export function drainByteStream<T>(
  buf: Uint8Array,
  opts: DrainOptions<T> & { decode: (msg: Uint8Array) => T | null },
): DrainResult<T>;
export function drainByteStream<T = Uint8Array>(
  buf: Uint8Array,
  opts: DrainOptions<T>,
): DrainResult<T> {
  const { messageLength, decode, inspect, coalesce, onMessage, onDrop } = opts;
  const messages: T[] = [];
  const deliver = (m: T): void => {
    if (onMessage) onMessage(m);
    else messages.push(m);
  };
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

    // Nothing is consumed until the disposition is known, so a message `decode`
    // refuses can still resync by one byte from where it started.
    let payload = new Uint8Array(rest.subarray(0, len));
    let consumed = len;

    const extra = coalesce ? coalesce(payload, rest.subarray(len)) : 0;
    if (extra > 0 && extra <= rest.length - len) {
      const merged = new Uint8Array(len + extra);
      merged.set(payload, 0);
      merged.set(rest.subarray(len, len + extra), len);
      payload = merged;
      consumed = len + extra;
    }

    if (decode) {
      const decoded = decode(payload);
      if (decoded === null) {
        onDrop?.(rest[0], 'rejected');
        rest = rest.subarray(1);
        continue;
      }
      deliver(decoded);
    } else {
      // No decode: T is Uint8Array, guaranteed by the overloads above — the
      // decoded form cannot be reached without a `decode`. The cast is confined
      // to this implementation signature and is unobservable to callers.
      deliver(payload as unknown as T);
    }
    rest = rest.subarray(consumed);
  }

  return {
    messages,
    rest: rest.length ? new Uint8Array(rest) : new Uint8Array(0),
    stopped,
  };
}
