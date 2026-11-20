/**
 * Places the first record of an SD data file at the time it was actually
 * sampled (DEV-1095). Port of the Java driver's
 * `driverUtilities/SdTimestampAnchor` — keep the two in step.
 *
 * A file's timeline is its header's initial timestamp plus the elapsed ticks of
 * its records. Subtracting the first record's raw timestamp pins that record to
 * the header time, which is only right if the header holds the first record's
 * time. LogAndStream does not write that: the header carries the RTC at the
 * moment the file was *created* (`sdFileSyncTs`), and records buffered when the
 * file opened were sampled before it. On a Shimmer3R, file 000 is created after
 * sampling starts (SD power-up, directory, header), so its first records predate
 * the header by roughly 160 ms more than at a mid-stream split — a permanent
 * step back at the 000 → 001 boundary. A Shimmer3 (LogAndStream v1.1.5) takes
 * file 000's header 1.8 ms before its first record instead, so the same split
 * steps forward by 2.7 ms.
 *
 * A record's 3-byte timestamp is the low 24 bits of the same 32768 Hz counter
 * as the header's initial timestamp, so the first record's full counter value
 * is the header value moved by the signed, wrap-corrected distance between the
 * two low parts. Exact whenever the header lies within 256 s (half the counter
 * period) of the first record, whichever moment the firmware chose for it.
 *
 * Counter domain: apply this before adding the RTC difference, which on
 * Shimmer3 is an arbitrary offset to real time.
 *
 * Verified on Shimmer3R: the raw 000/001 files of a 1024 Hz recording put each
 * first packet 162.72 ms and 3.94 ms before its header, and anchored this way
 * the 000 → 001 split is exactly one sample period (tests/sdlog/anchor.test.ts).
 *
 * Verified on Shimmer3 (MSP430) too, where the RTC difference is an offset to
 * real time rather than the counter's high bytes: the raw files of a 33-file
 * LogAndStream v1.1.5 recording at 1024 Hz put file 000's first packet 1.831 ms
 * after its header and every later file's 0.885 ms before, so the first
 * packet's low 24 bits share the header's counter domain, and all 32 splits
 * close to exactly one sample period.
 */

/** 2^24: modulo of the 3-byte tick counter (512 s at 32768 Hz). */
const TICKS_MAX_3_BYTE = 2 ** 24;

/**
 * Largest header-to-first-record distance read as a lead time: 10 s at
 * 32768 Hz. The real lead is well under a second, so a larger distance means
 * the header does not describe this counter.
 */
export const SDLOG_MAX_LEAD_TICKS = 10 * 32768;

const floorMod = (a: number, m: number): number => ((a % m) + m) % m;

/**
 * Signed distance from the header's low bits to the first record's raw
 * timestamp, folded into `[-maxTicks/2, maxTicks/2)`: positive when the record
 * was sampled after the header was written, negative when before.
 */
export function signedLeadTicks(
  initialTicks: number,
  firstRawTicks: number,
  maxTicks: number,
): number {
  const half = maxTicks / 2;
  const low = floorMod(initialTicks, maxTicks);
  return floorMod(firstRawTicks - low + half, maxTicks) - half;
}

/**
 * The value to subtract from `initialTicks + unwrapped` so each record lands on
 * its own counter time. Falls back to the first record's raw timestamp — the
 * previous behaviour, pinning it to the header — for a 2-byte counter, an
 * initial timestamp of zero, or a distance beyond {@link SDLOG_MAX_LEAD_TICKS}.
 */
export function firstTsOffsetFromInitialTsTicks(
  initialTicks: number,
  firstRawTicks: number,
  maxTicks: number,
): number {
  if (maxTicks !== TICKS_MAX_3_BYTE || initialTicks === 0) return firstRawTicks;
  const lead = signedLeadTicks(initialTicks, firstRawTicks, maxTicks);
  if (Math.abs(lead) > SDLOG_MAX_LEAD_TICKS) return firstRawTicks;
  return firstRawTicks - lead;
}
