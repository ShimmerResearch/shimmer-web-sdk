/**
 * Device RTC drift estimation over a live connection (DEV-844).
 *
 * Sample the device clock periodically against the host clock and fit a
 * least-squares slope of (device − host) offset vs host time: the
 * dimensionless slope × 1e6 is directly the crystal error in ppm, giving a
 * usable estimate in hours instead of waiting days between connections.
 * Device time resolves to 1/32768 s, so per-sample noise is just transport
 * round-trip jitter (~tens of ms); the fit averages it out. Host timestamps
 * should be taken at the midpoint of the read round-trip, bounding transport
 * latency to ±rtt/2.
 *
 * Host clock steps (NTP corrections) are a measurement hazard: the wall
 * clock jumping mid-series pollutes the least-squares slope while looking
 * like device drift (seen live on DEV-844: a −1.4 s Windows NTP step bent
 * the fit from 1020 to 1077 ppm). Each sample therefore also records a
 * monotonic timestamp (`performance.now()`): wall-vs-monotonic divergence
 * between samples attributes a jump to the HOST, which resets the fit
 * baseline instead of counting as a device step.
 *
 * This class is pure bookkeeping — the caller owns the sampling timer, the
 * device read, and any UI. Feed it one {@link RtcDriftSampleInput} per read.
 */

export interface RtcDriftSampleInput {
  /** Host wall-clock unix seconds at the midpoint of the device-time read. */
  hostSec: number;
  /** Device clock in unix seconds, as read from the device. */
  devSec: number;
  /** Read round-trip in ms (kept per sample so outliers are explainable). */
  rttMs: number;
  /** Host monotonic clock (e.g. `performance.now()`) in ms at the read. */
  perfMs: number;
}

export interface RtcDriftSample extends RtcDriftSampleInput {
  /** Device-minus-host clock offset in seconds. */
  offsetSec: number;
}

/** What {@link RtcDriftMonitor.addSample} concluded about a new sample. */
export type RtcDriftSampleEvent =
  | { kind: 'sample'; sample: RtcDriftSample }
  /** The HOST wall clock stepped (NTP): the fit baseline was reset and the
   * series restarted from this sample. */
  | { kind: 'host-step'; sample: RtcDriftSample; hostStepSec: number }
  /** The DEVICE clock stepped between samples. */
  | { kind: 'device-step'; sample: RtcDriftSample; deltaSec: number };

export interface RtcDriftMonitorOptions {
  /** Offset jump treated as a device clock step (default 1 s). */
  deviceStepThresholdSeconds?: number;
  /** Wall-vs-monotonic divergence treated as a host clock step (default 0.5 s). */
  hostStepThresholdSeconds?: number;
}

export class RtcDriftMonitor {
  readonly samples: RtcDriftSample[] = [];
  /** Device clock steps detected across the whole run (survives rebaselines). */
  deviceSteps = 0;
  /** Host (NTP) clock steps detected; each one rebaselines the fit. */
  hostSteps = 0;

  private readonly deviceStepThresholdSeconds: number;
  private readonly hostStepThresholdSeconds: number;

  constructor(options: RtcDriftMonitorOptions = {}) {
    this.deviceStepThresholdSeconds = options.deviceStepThresholdSeconds ?? 1;
    this.hostStepThresholdSeconds = options.hostStepThresholdSeconds ?? 0.5;
  }

  /** Drop all samples and step counts (e.g. when starting a new run). */
  reset(): void {
    this.samples.length = 0;
    this.deviceSteps = 0;
    this.hostSteps = 0;
  }

  /**
   * Drop the samples but keep the step counters. Call when the device time is
   * written: a time write moves the offset baseline, so every prior sample is
   * invalid and the fit must not straddle the discontinuity.
   */
  rebaseline(): void {
    this.samples.length = 0;
  }

  /**
   * Record one device-time reading. Attributes any offset jump before
   * recording it: wall-clock elapsed minus monotonic elapsed isolates host
   * clock steps (NTP) from device steps. A host step resets the fit baseline
   * (the fit must not straddle the discontinuity); a device step is counted
   * and kept in-series.
   */
  addSample(input: RtcDriftSampleInput): RtcDriftSampleEvent {
    const sample: RtcDriftSample = { ...input, offsetSec: input.devSec - input.hostSec };
    const prev = this.samples[this.samples.length - 1];

    const hostStepSec = prev
      ? sample.hostSec - prev.hostSec - (sample.perfMs - prev.perfMs) / 1000
      : 0;
    if (Math.abs(hostStepSec) > this.hostStepThresholdSeconds) {
      this.hostSteps++;
      this.samples.length = 0;
      this.samples.push(sample);
      return { kind: 'host-step', sample, hostStepSec };
    }

    if (prev && Math.abs(sample.offsetSec - prev.offsetSec) > this.deviceStepThresholdSeconds) {
      this.deviceSteps++;
      this.samples.push(sample);
      return { kind: 'device-step', sample, deltaSec: sample.offsetSec - prev.offsetSec };
    }

    this.samples.push(sample);
    return { kind: 'sample', sample };
  }

  /**
   * Least-squares slope of offset vs host time, in ppm (offset and time are
   * both in seconds, so the dimensionless slope × 1e6 is directly ppm).
   * Null until two samples spanning a non-zero interval exist.
   */
  ppmFit(): number | null {
    const s = this.samples;
    if (s.length < 2) return null;
    const t0 = s[0].hostSec;
    const y0 = s[0].offsetSec;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (const p of s) {
      const x = p.hostSec - t0;
      const y = p.offsetSec - y0;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    const n = s.length;
    const denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    return ((n * sxy - sx * sy) / denom) * 1e6;
  }

  /** Elapsed span of the current sample series in minutes (0 when empty). */
  elapsedMinutes(): number {
    const s = this.samples;
    if (s.length < 2) return 0;
    return (s[s.length - 1].hostSec - s[0].hostSec) / 60;
  }

  /**
   * CSV rows (header first) of the current series, matching the DEV-844
   * export format: host ISO time, host/device unix seconds, offset, rtt,
   * monotonic seconds.
   */
  toCsvRows(): string[] {
    const rows = ['host_iso,host_unix_s,device_unix_s,offset_s,rtt_ms,perf_monotonic_s'];
    for (const p of this.samples) {
      rows.push(
        `${new Date(p.hostSec * 1000).toISOString()},${p.hostSec.toFixed(3)},${p.devSec.toFixed(5)},${p.offsetSec.toFixed(3)},${p.rttMs},${(p.perfMs / 1000).toFixed(3)}`,
      );
    }
    return rows;
  }
}
