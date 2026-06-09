import type { StreamContribution } from '../../../core/StreamStats.js';

/**
 * Abstract base class for all Verisense sensor decoders.
 *
 * Provides:
 * - Timestamp unwrapping (handles the 1-minute rollover at 32768 ticks/s).
 * - System-time offset tracking for plotting calibrated wall-clock timestamps.
 * - Per-sample time extrapolation based on sampling rate and last-sample tick.
 */
export abstract class SensorBase {
  /** Verisense clock frequency in ticks per second. */
  static readonly CLOCK_FREQ = 32768;

  /** 1-minute rollover at 32768 ticks/s (matches C# Sensor.cs). */
  static readonly TICKS_MAX_VALUE = 60 * 32768;

  protected lastTicksUnwrapped = 0;
  protected cycle = 0;

  /** (system time) − (shimmer time) at first sample, in milliseconds. */
  systemOffsetFirstTime: number | null = null;

  /** Sampling rate in Hz (used for per-sample time extrapolation). */
  samplingRateHz: number | null = null;

  /** Whether this sensor is enabled in the operational config. */
  enabled = true;

  /** Reset all timestamp state (call on (re)connect or when streaming restarts). */
  resetTimestamps(): void {
    this.lastTicksUnwrapped = 0;
    this.cycle = 0;
    this.systemOffsetFirstTime = null;
  }

  /**
   * Unwrap a rolling 24-bit tick counter to a monotonically increasing value.
   */
  unwrapTicks(ticks: number): number {
    let unwrapped = ticks + SensorBase.TICKS_MAX_VALUE * this.cycle;
    if (this.lastTicksUnwrapped > unwrapped) {
      this.cycle += 1;
      unwrapped = ticks + SensorBase.TICKS_MAX_VALUE * this.cycle;
    }
    this.lastTicksUnwrapped = unwrapped;
    return unwrapped;
  }

  /** Convert unwrapped ticks to milliseconds. */
  ticksToMillis(unwrappedTicks: number): number {
    return (unwrappedTicks / SensorBase.CLOCK_FREQ) * 1000.0;
  }

  /**
   * Compute the calibrated shimmer timestamp for the *last* sample in a burst,
   * and store the first-seen system-offset for later plotting.
   *
   * @param lastSampleTicksU24  24-bit tick counter from the packet header.
   * @param systemMillis        `Date.now()` at the time of packet receipt.
   */
  getTimestampUnwrappedMillis(
    lastSampleTicksU24: number,
    systemMillis: number,
  ): { shimmerMillis: number; systemOffsetFirstTime: number } {
    const unwrappedTicks = this.unwrapTicks(lastSampleTicksU24);
    const shimmerMillis = this.ticksToMillis(unwrappedTicks);

    if (this.systemOffsetFirstTime == null) {
      this.systemOffsetFirstTime = systemMillis - shimmerMillis;
    }

    return { shimmerMillis, systemOffsetFirstTime: this.systemOffsetFirstTime };
  }

  /**
   * Extrapolate the timestamp for sample `i` of `numSamples` in a burst,
   * given the timestamp of the *last* sample and the sampling rate.
   *
   * @returns Object with `tsMillis`, `systemTsMillis`, and `systemTsPlotMillis`.
   */
  extrapolateSampleTimes(opts: {
    numSamples: number;
    i: number;
    samplingRateHz?: number | null;
    tsLastSampleMillis: number;
    systemTsLastSampleMillis: number;
    systemOffsetFirstTime?: number | null;
  }): { tsMillis: number; systemTsMillis: number; systemTsPlotMillis: number } {
    const sr = opts.samplingRateHz ?? this.samplingRateHz;
    const { tsLastSampleMillis, systemTsLastSampleMillis, systemOffsetFirstTime } = opts;

    if (!sr || sr <= 0) {
      return {
        tsMillis: tsLastSampleMillis,
        systemTsMillis: systemTsLastSampleMillis,
        systemTsPlotMillis:
          systemOffsetFirstTime != null
            ? tsLastSampleMillis + systemOffsetFirstTime
            : systemTsLastSampleMillis,
      };
    }

    const sampleOffsetSec = (opts.numSamples - opts.i - 1) / sr;
    const tsMillis = tsLastSampleMillis - sampleOffsetSec * 1000;
    const systemTsMillis = systemTsLastSampleMillis - sampleOffsetSec * 1000;
    const systemTsPlotMillis =
      systemOffsetFirstTime != null ? tsMillis + systemOffsetFirstTime : systemTsMillis;

    return { tsMillis, systemTsMillis, systemTsPlotMillis };
  }

  /**
   * Compute per-sample timestamps for a whole decoded burst.
   *
   * The base implementation treats every decoded sample as one evenly-spaced
   * time step at `samplingRateHz` (correct when each decoded sample is a single
   * combined time step). Sensors whose decoded array *interleaves* multiple
   * streams at different cadences (e.g. the LSM6DSV tagged FIFO, which mixes
   * accel / gyro / mag entries) override this to timestamp each stream on its
   * own rate — otherwise the shared rate spreads each stream's samples too far
   * back and consecutive blocks overlap on the time axis.
   */
  computeSampleTimestamps(
    decodedSamples: unknown[],
    block: {
      tsLastSampleMillis: number;
      systemTsLastSampleMillis: number;
      systemOffsetFirstTime?: number | null;
    },
  ): Array<{ tsMillis: number; systemTsMillis: number; systemTsPlotMillis: number }> {
    const num = decodedSamples.length;
    const out = new Array(num);
    for (let i = 0; i < num; i++) {
      out[i] = this.extrapolateSampleTimes({
        numSamples: num,
        i,
        samplingRateHz: this.samplingRateHz,
        tsLastSampleMillis: block.tsLastSampleMillis,
        systemTsLastSampleMillis: block.systemTsLastSampleMillis,
        systemOffsetFirstTime: block.systemOffsetFirstTime,
      });
    }
    return out;
  }

  /**
   * Turn a decoded + timestamped burst into one or more stream contributions
   * for live throughput / packet-loss tracking. The default treats the sensor
   * as a single stream; sensors whose decoded array interleaves several
   * sub-streams at different cadences (e.g. the LSM6DSV tagged FIFO) override
   * this to report one contribution per sub-stream so loss is tracked
   * independently.
   */
  getStreamContributions(
    samplesWithTime: Array<{ timestamps?: { tsMillis: number } }>,
    sensorId: number,
  ): StreamContribution[] {
    let first: number | null = null;
    let last: number | null = null;
    for (const s of samplesWithTime) {
      const t = s?.timestamps?.tsMillis;
      if (typeof t !== 'number') continue;
      if (first == null || t < first) first = t;
      if (last == null || t > last) last = t;
    }
    return [
      {
        key: String(sensorId),
        label: `Sensor ${sensorId}`,
        samplingRateHz: this.samplingRateHz,
        sampleCount: samplesWithTime.length,
        firstSampleMillis: first,
        lastSampleMillis: last,
      },
    ];
  }

  /** Parse a raw sensor payload byte array into decoded samples. */
  abstract parsePayload(sensorPayloadBytes: Uint8Array): unknown[];

  /** Apply the Verisense operational config blob to update decoder settings. */
  abstract applyOperationalConfig(op: Uint8Array): void;
}
