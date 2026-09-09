/**
 * Turning a stream's 24-bit tick counter into a monotonic device clock, and
 * then into wall-clock time.
 *
 * Two problems, and they are separable.
 *
 * **The counter wraps.** It runs at 32768 Hz in 24 bits, so it returns to zero
 * every 512 seconds exactly — and in 16 bits, on Shimmer3 firmware older than
 * LogAndStream 0.5.4, every **2 seconds**. Plotting the raw value against time
 * draws a sawtooth. Unwrapping it is a matter of counting the wraps, and the
 * naive rule ("the value went down, so it wrapped") is wrong for a duplicated
 * or reordered packet: it adds 512 s permanently, which is what the Java
 * driver's `unwrapTimeStamp` does (`ShimmerObject.java:3830-3848`).
 *
 * **The counter has no origin.** It says nothing about what time it is. To place
 * samples on a wall clock a host has to anchor the counter against something,
 * and there are three ways of doing that, in descending order of how well they
 * work:
 *
 * | Anchor | When | Accuracy |
 * |---|---|---|
 * | `rwc-aligned` | Shimmer3R | exact, to the tick |
 * | `rwc-estimated` | Shimmer3 | ± half the round trip |
 * | `host` | no real-world clock set, or firmware without the command | ± half the round trip, and wrong by however wrong the sensor's clock is |
 *
 * The first is available because on a Shimmer3R the stream's timestamp **is**
 * the low 24 bits of the same 64-bit counter `GET_RWC` returns: the packet
 * timestamp comes from `RTC_get32()` and the real-world clock from
 * `RTC_get64()` (`Sensing/shimmer_sensing.c:445-476`; `RTC/shimmer_rtc.h:25-28`
 * defines `RTC_getRwcTime` as `RTC_get64`, and `Core/Src/rtc.c` gives the two
 * functions identical bodies). So one `GET_RWC` reply pins every subsequent
 * sample exactly, with no clock-comparison error at all: the host only has to
 * decide *which* wrap of the counter a sample belongs to, and elapsed host time
 * settles that with hundreds of seconds of slack.
 *
 * A Shimmer3's counter cannot be set. Its real-world clock is that free-running
 * counter plus a stored offset — `RTC_getRwcTime()` returns
 * `rwcTimeDiff64 + RTC_get64()` (`Shimmer_Driver/5xx_HAL/hal_RTC.c:73-76`) —
 * and the offset is not sent over Bluetooth, only into an SD header. So a host
 * can only estimate where the counter stood when the reply was composed, which
 * is what `rwc-estimated` does and why it carries the round trip as its
 * uncertainty.
 *
 * `host` is the Consensys method: the host's own clock at the first packet,
 * carried forward by the device's counter
 * (`SystemTimestampPlot.java:19-42`). It is the fallback rather than the
 * default because it inherits the host's clock error rather than the sensor's,
 * and a sensor whose clock is set is the better reference for its own data.
 */

/** The sample counter's frequency, on every Shimmer3-family device. */
export const TICKS_PER_SECOND = 32768;

/** Ticks per millisecond — 32.768, as the firmware and the Java driver have it. */
export const TICKS_PER_MS = TICKS_PER_SECOND / 1000;

/** Where a timeline's wall-clock time came from. See the module docblock. */
export type TimelineSource = 'rwc-aligned' | 'rwc-estimated' | 'host';

/** How wide the device's sample counter is. */
export type TimestampBits = 16 | 24;

/** One stamped sample. */
export interface StreamStamp {
  /** The counter with its wraps added back, monotonic across a session. */
  unwrappedTicks: number;
  /**
   * Milliseconds on the device's own clock: `unwrappedTicks / 32.768`.
   *
   * Not zeroed at stream start — it begins wherever the counter stood, which is
   * what the Java driver emits on its `TIMESTAMP` CAL channel. Subtract the
   * first sample's value for "seconds since start".
   */
  deviceMs: number;
  /** Unix milliseconds, or `null` when the timeline has no anchor yet. */
  unixMs: number | null;
  /** Which anchor produced `unixMs`; `null` when there is none. */
  source: TimelineSource | null;
}

/** What a host should be told about a timeline's anchor. */
export interface TimelineState {
  source: TimelineSource | null;
  /** Host clock reading the anchor was taken at, or `null`. */
  anchorHostMs: number | null;
  /** Unix time the anchor assigned, or `null`. */
  anchorUnixMs: number | null;
  /**
   * How far out the anchor could be, in milliseconds.
   *
   * Zero for `rwc-aligned` — the arithmetic is exact. Half the measured round
   * trip for the other two, which is the best a single request/response
   * exchange can say about when the far end read its clock.
   */
  anchorUncertaintyMs: number;
  /**
   * Device-minus-host at the moment of anchoring, or `null` — including while
   * the anchor is still waiting for its first sample.
   */
  skewMs: number | null;
  /** How many counter wraps have been counted this session. */
  wraps: number;
  /** The counter width in use. */
  timestampBits: TimestampBits;
}

interface PendingAnchor {
  kind: 'rwc-aligned' | 'rwc-estimated' | 'host';
  /** The device's real-world clock, in ticks. Absent for a host anchor. */
  rwcTicks?: bigint;
  /** Host clock at the midpoint of the exchange that produced it. */
  hostMs: number;
  uncertaintyMs: number;
}

interface ResolvedAnchor {
  source: TimelineSource;
  /** Unwrapped tick value this anchor is bound to. */
  unwrappedTicks: number;
  /** Unix milliseconds at that tick value. */
  unixMs: number;
  hostMs: number;
  uncertaintyMs: number;
  skewMs: number | null;
}

/** Options for {@link StreamTimeline}. */
export interface StreamTimelineOptions {
  /** Counter width. Default 24. */
  timestampBits?: TimestampBits;
}

/**
 * Unwraps a device sample counter and, once anchored, reports wall-clock time
 * for every sample.
 *
 * One instance per stream. A client resets it at stream start and re-anchors
 * whenever the device's clock is written, because that steps the very counter
 * the samples are timed by.
 */
export class StreamTimeline {
  private _bits: TimestampBits;
  private _modulo: number;
  private _lastRaw: number | null = null;
  private _lastUnwrapped = 0;
  private _lastHostMs: number | null = null;
  private _wraps = 0;
  private _pending: PendingAnchor | null = null;
  private _anchor: ResolvedAnchor | null = null;
  /**
   * The last anchor REQUEST, kept so it can be re-bound to a new stream's first
   * sample. A request is durable in a way a binding is not: it says what the
   * device's clock read at a known host time, which stays true across a stream
   * restart, whereas the binding is to an unwrapped tick origin that does not.
   */
  private _request: PendingAnchor | null = null;

  constructor(opts: StreamTimelineOptions = {}) {
    this._bits = opts.timestampBits ?? 24;
    this._modulo = 2 ** this._bits;
  }

  /** The counter width this timeline is unwrapping. */
  get timestampBits(): TimestampBits {
    return this._bits;
  }

  /**
   * Change the counter width.
   *
   * A Shimmer3 client learns this from the firmware version during its
   * handshake, which happens after the timeline exists. Resets everything: a
   * wrap count means nothing against a different modulo, and an anchor is
   * bound to an unwrapped tick value that is about to start again.
   */
  setTimestampBits(bits: TimestampBits): void {
    if (bits === this._bits) return;
    this._bits = bits;
    this._modulo = 2 ** bits;
    this.reset();
  }

  /**
   * Start again: new stream, new counter origin.
   *
   * Any anchor is dropped rather than carried over. Between two streams the
   * counter has kept running, so an anchor bound to the old stream's unwrapped
   * origin says nothing about the new one, and a host re-reads the clock.
   */
  reset(): void {
    this._lastRaw = null;
    this._lastUnwrapped = 0;
    this._lastHostMs = null;
    this._wraps = 0;
    this._anchor = null;
    /* The binding goes; the request stays, to be re-bound to this stream's
       first sample. So a host that read the clock once, on connect, gets a
       wall-clock axis on every later stream without asking again — and for an
       aligned anchor it is still exact, because the answer comes from each
       sample's own counter bits rather than from elapsed time. */
    this._pending = this._request;
  }

  /**
   * Anchor against the device's real-world clock.
   *
   * @param rwcTicks  The 64-bit tick count `GET_RWC` returned.
   * @param hostMs    The host clock at the **midpoint** of the exchange —
   *   `(before + after) / 2` — which is the best single estimate of when the
   *   device composed its reply.
   * @param opts.rttMs  The exchange's round-trip time. Half of it is the
   *   uncertainty, and it is ignored for an aligned anchor, which does not
   *   depend on when the reply was composed.
   * @param opts.aligned  True when the stream timestamp is the low bits of this
   *   same counter — a Shimmer3R. False for a Shimmer3, whose counter and
   *   real-world clock differ by a stored offset the host cannot read.
   */
  anchorToRwc(rwcTicks: bigint, hostMs: number, opts: { rttMs?: number; aligned: boolean }): void {
    this._pending = {
      kind: opts.aligned ? 'rwc-aligned' : 'rwc-estimated',
      rwcTicks,
      hostMs,
      uncertaintyMs: opts.aligned ? 0 : (opts.rttMs ?? 0) / 2,
    };
    this._request = this._pending;
    this._anchor = null;
  }

  /**
   * Anchor against the host's own clock, the Consensys method: the next sample
   * is taken to have happened now, and the device's counter carries time
   * forward from there.
   */
  anchorToHost(hostMs: number, opts: { rttMs?: number } = {}): void {
    this._pending = {
      kind: 'host',
      hostMs,
      uncertaintyMs: (opts.rttMs ?? 0) / 2,
    };
    this._request = this._pending;
    this._anchor = null;
  }

  /** Drop any anchor and any standing request, leaving the unwrap running. */
  clearAnchor(): void {
    this._pending = null;
    this._request = null;
    this._anchor = null;
  }

  /**
   * True when this timeline has been told how to place samples on a wall clock
   * — whether or not a sample has arrived to bind it to yet.
   *
   * A client checks this before spending a round trip on the clock: one reading
   * serves every stream of a session.
   */
  get hasAnchorRequest(): boolean {
    return this._request !== null;
  }

  /**
   * Unwrap one sample's counter value and, if anchored, place it on a wall
   * clock.
   *
   * @param raw    The counter value from the packet, wraps included.
   * @param hostMs The host clock when the packet arrived. Used only to recover
   *   wraps that went by unseen — see below — never to time the sample, which
   *   the device's own counter does far better.
   */
  stamp(raw: number, hostMs?: number): StreamStamp {
    const unwrapped = this._unwrap(raw, hostMs);
    this._lastRaw = ((raw % this._modulo) + this._modulo) % this._modulo;
    this._lastUnwrapped = unwrapped;
    /* How many counter boundaries this session has crossed. The unwrapped value
       starts below one modulo (it starts AT a raw counter value), so flooring
       the division counts crossings directly. Clamped at zero because a
       reordered packet arriving first can carry the value slightly negative. */
    this._wraps = Math.max(0, Math.floor(unwrapped / this._modulo));
    if (hostMs !== undefined) this._lastHostMs = hostMs;

    if (this._pending) this._resolveAnchor(unwrapped, hostMs);

    const deviceMs = unwrapped / TICKS_PER_MS;
    if (!this._anchor) {
      return { unwrappedTicks: unwrapped, deviceMs, unixMs: null, source: null };
    }
    const unixMs = this._anchor.unixMs + (unwrapped - this._anchor.unwrappedTicks) / TICKS_PER_MS;
    return { unwrappedTicks: unwrapped, deviceMs, unixMs, source: this._anchor.source };
  }

  private _unwrap(raw: number, hostMs?: number): number {
    const value = ((raw % this._modulo) + this._modulo) % this._modulo;
    if (this._lastRaw === null) return value;

    const half = this._modulo / 2;
    /* Forward distance from the last sample. A step of less than half a modulo
       is taken as forward motion (crossing a wrap if it has to); more than half
       is taken as a small step BACKWARDS, i.e. a duplicated or reordered
       packet. Without that guard one out-of-order packet adds a whole modulo —
       512 s on a Shimmer3R — for the rest of the session. */
    const forward = (value - this._lastRaw + this._modulo) % this._modulo;
    let unwrapped =
      forward <= half
        ? this._lastUnwrapped + forward
        : this._lastUnwrapped - (this._modulo - forward);

    /* The rule above cannot see a wrap that went by entirely — more than a
       whole modulo of samples missed, which is 512 s on a 24-bit counter but
       only 2 s on the 16-bit one older Shimmer3 firmware uses. The host clock
       is the only witness. Its jitter is irrelevant at this scale: it is being
       asked how many whole modulos went by, not when the sample happened. */
    if (hostMs !== undefined && this._lastHostMs !== null) {
      const elapsedTicks = (hostMs - this._lastHostMs) * TICKS_PER_MS;
      if (elapsedTicks > half) {
        const expected = this._lastUnwrapped + elapsedTicks;
        const missed = Math.round((expected - unwrapped) / this._modulo);
        if (missed > 0) unwrapped += missed * this._modulo;
      }
    }

    return unwrapped;
  }

  /**
   * Turn a pending anchor into a resolved one, now that a sample's unwrapped
   * tick value is known to bind it to.
   */
  private _resolveAnchor(unwrapped: number, hostMs?: number): void {
    const pending = this._pending;
    if (!pending) return;
    const at = hostMs ?? pending.hostMs;

    if (pending.kind === 'host') {
      this._pending = null;
      this._anchor = {
        source: 'host',
        unwrappedTicks: unwrapped,
        unixMs: at,
        hostMs: at,
        uncertaintyMs: pending.uncertaintyMs,
        skewMs: null,
      };
      return;
    }

    const rwcTicks = pending.rwcTicks;
    if (rwcTicks === undefined) {
      this._pending = null;
      return;
    }

    /* Where the device's clock stood when this sample was taken, estimated from
       the anchor plus however long the host says has passed since. Good to tens
       of milliseconds, which is all that is needed below. */
    const elapsedSinceAnchorTicks = (at - pending.hostMs) * TICKS_PER_MS;
    const approxTicks = Number(rwcTicks) + elapsedSinceAnchorTicks;

    let absoluteTicks: number;
    if (pending.kind === 'rwc-aligned') {
      /* The sample's counter value IS the low bits of the device's real-world
         clock, so the answer is the value congruent to it that lies nearest the
         estimate above. The estimate only has to be right to within half a
         modulo — 256 seconds — so this is exact in practice however sloppy the
         host clock is. */
      const low = ((unwrapped % this._modulo) + this._modulo) % this._modulo;
      const base = Math.round((approxTicks - low) / this._modulo) * this._modulo;
      absoluteTicks = base + low;
    } else {
      /* No congruence to exploit: a Shimmer3's counter and its real-world clock
         differ by an offset only the device knows. The estimate is the answer,
         and its error is the link's latency asymmetry. */
      absoluteTicks = approxTicks;
    }

    const unixMs = absoluteTicks / TICKS_PER_MS;
    this._pending = null;
    this._anchor = {
      source: pending.kind,
      unwrappedTicks: unwrapped,
      unixMs,
      hostMs: at,
      uncertaintyMs: pending.uncertaintyMs,
      skewMs: unixMs - at,
    };
  }

  /**
   * What a host should show about this timeline.
   *
   * `source` reports what *will* place these samples as soon as one arrives,
   * not only what already has: a host wants to label its time axis when the
   * stream starts, not one packet later. {@link anchored} is the narrower
   * question of whether a sample has bound the anchor yet.
   */
  get state(): TimelineState {
    return {
      source: this._anchor?.source ?? this._pending?.kind ?? this._request?.kind ?? null,
      anchorHostMs: this._anchor?.hostMs ?? null,
      anchorUnixMs: this._anchor?.unixMs ?? null,
      anchorUncertaintyMs: this._anchor?.uncertaintyMs ?? 0,
      skewMs: this._anchor?.skewMs ?? null,
      wraps: this._wraps,
      timestampBits: this._bits,
    };
  }

  /** True once wall-clock time is available. */
  get anchored(): boolean {
    return this._anchor !== null;
  }
}
