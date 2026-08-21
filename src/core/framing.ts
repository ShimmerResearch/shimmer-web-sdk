/**
 * Sentinels shared by the byte-stream (unframed transport) message framers.
 *
 * A framer is a pure function `(buf) => number` that reports how many bytes the
 * message at the head of `buf` occupies, so a client reading from an unframed
 * pipe (Web Serial, RFCOMM/SPP, a dock UART) can rebuild the message boundaries
 * that BLE notifications hand it for free.
 *
 * `src/devices/shimmer3/protocol.ts` and `src/devices/dock/protocol.ts` each
 * predate this module and export their own identically-valued copies; they are
 * public API and are left alone. New framers should import from here.
 */

/** Not enough bytes buffered yet to determine the message length. */
export const NEED_MORE = -1;

/**
 * The leading byte is not the start of a message we understand — the caller
 * should drop one byte and retry (resynchronise) rather than guess a length.
 */
export const RESYNC = 0;
