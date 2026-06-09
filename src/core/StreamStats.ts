/**
 * Device-agnostic live stream statistics: throughput, packet rate and
 * sample-gap-derived packet loss for a real-time sensor stream.
 *
 * The tracker is fed one call per received packet ({@link StreamStatsTracker.recordPacket})
 * and produces a {@link StreamStatsSnapshot} on demand ({@link StreamStatsTracker.snapshot}).
 *
 * Loss is derived from gaps in each sub-stream's *monotonic device clock*
 * (`lastSampleMillis`), NOT host receive time — host BLE buffering bunches
 * packets together and would otherwise create false gaps. Throughput and packet
 * rate, by contrast, are measured over a sliding window of host receive time
 * (`recvMillis`), which is what "bytes per wall-clock second" means.
 */

/**
 * One sub-stream's contribution from a single decoded packet. A sensor that
 * carries a single stream emits one of these per packet; a sensor whose FIFO
 * interleaves multiple streams (e.g. the LSM6DSV accel/gyro/mag) emits one per
 * active sub-stream.
 */
export interface StreamContribution {
  /** Unique key per sub-stream, e.g. `"2"` or `"6:accel"`. */
  key: string;
  /** Human label, e.g. `"Accel"`. */
  label: string;
  /** Configured/expected rate for this sub-stream, or null if unknown. */
  samplingRateHz: number | null;
  /** Number of samples of this sub-stream in this packet. */
  sampleCount: number;
  /** Min `tsMillis` (monotonic device clock) of this sub-stream in this packet. */
  firstSampleMillis: number | null;
  /** Max `tsMillis` (monotonic device clock) of this sub-stream in this packet. */
  lastSampleMillis: number | null;
}

/** Per-sub-stream loss/rate accounting in a snapshot. */
export interface StreamLossStats {
  key: string;
  sensorId: number;
  label: string;
  samplingRateHz: number | null;
  samples: number;
  expectedSamples: number;
  lostSamples: number;
  lossPct: number;
  /** Achieved sample rate over the sliding window (samples/sec). */
  windowSampleRateHz: number;
  lastSampleMillis: number | null;
}

/** Per-sensor rollup in a snapshot. */
export interface SensorStreamStats {
  sensorId: number;
  packets: number;
  bytes: number;
  crcFails: number;
  /** Windowed throughput for this sensor's frames (bytes/sec). */
  windowThroughputBps: number;
  /** Windowed packet rate for this sensor (packets/sec). */
  windowPacketRateHz: number;
  streams: StreamLossStats[];
}

/** Full snapshot of stream statistics at a point in time. */
export interface StreamStatsSnapshot {
  durationMillis: number;
  totalPackets: number;
  totalSamples: number;
  totalBytes: number;
  totalCrcFails: number;
  /** Overall windowed bytes/sec across all sensors. */
  throughputBps: number;
  /** Aggregate lostSamples / expectedSamples * 100. */
  lossPct: number;
  perSensor: Record<number, SensorStreamStats>;
}

interface ByteEvent {
  t: number;
  bytes: number;
}

interface SampleEvent {
  /** Host receive time (used for window pruning). */
  t: number;
  /** Sample count in this packet for the sub-stream. */
  n: number;
  /** Device-clock time (min tsMillis) of this sub-stream's first sample, if known. */
  devFirst: number | null;
  /** Device-clock time (max tsMillis) of this sub-stream's last sample, if known. */
  dev: number | null;
}

interface SensorAccum {
  sensorId: number;
  packets: number;
  bytes: number;
  crcFails: number;
  /** Sliding window of received frames for throughput / packet-rate. */
  throughputRing: ByteEvent[];
}

interface StreamAccum {
  key: string;
  sensorId: number;
  label: string;
  samplingRateHz: number | null;
  samples: number;
  expectedSamples: number;
  lostSamples: number;
  lastSampleMillis: number | null;
  /** Whether at least one packet has been recorded for this sub-stream. */
  started: boolean;
  /** Sliding window of sample counts for the achieved sample rate. */
  rateRing: SampleEvent[];
}

/**
 * Drop ring events older than `cutoff` (by receive time), but always keep the
 * last 2 so the rate/throughput still reflect the most recent delivery even when
 * packets arrive less often than the window (big FIFO reads, slow sensors).
 */
function pruneRing<T extends { t: number }>(ring: T[], cutoff: number): T[] {
  if (ring.length <= 2) return ring;
  let i = 0;
  while (i < ring.length - 2 && ring[i].t < cutoff) i++;
  return i > 0 ? ring.slice(i) : ring;
}

/**
 * Accumulates live statistics for one streaming session. Call {@link reset} on
 * (re)start, {@link recordPacket} for every decoded packet, {@link recordCrcFail}
 * for CRC failures, and {@link snapshot} to read the current numbers.
 */
export class StreamStatsTracker {
  private readonly windowMillis: number;
  private sessionStartMillis: number | null = null;
  private readonly sensors = new Map<number, SensorAccum>();
  private readonly streams = new Map<string, StreamAccum>();

  constructor(opts?: { windowMillis?: number }) {
    this.windowMillis = opts?.windowMillis ?? 2000;
  }

  /** Clear all state. Call when streaming (re)starts. */
  reset(): void {
    this.sessionStartMillis = null;
    this.sensors.clear();
    this.streams.clear();
  }

  private getSensor(sensorId: number): SensorAccum {
    let s = this.sensors.get(sensorId);
    if (!s) {
      s = { sensorId, packets: 0, bytes: 0, crcFails: 0, throughputRing: [] };
      this.sensors.set(sensorId, s);
    }
    return s;
  }

  private getStream(key: string, sensorId: number, label: string): StreamAccum {
    let st = this.streams.get(key);
    if (!st) {
      st = {
        key,
        sensorId,
        label,
        samplingRateHz: null,
        samples: 0,
        expectedSamples: 0,
        lostSamples: 0,
        lastSampleMillis: null,
        started: false,
        rateRing: [],
      };
      this.streams.set(key, st);
    }
    return st;
  }

  /** Record one received (and decoded) streaming packet. */
  recordPacket(p: {
    sensorId: number;
    byteLength: number;
    crcOk: boolean | null;
    recvMillis: number;
    contributions: StreamContribution[];
  }): void {
    if (this.sessionStartMillis == null) this.sessionStartMillis = p.recvMillis;

    const sensor = this.getSensor(p.sensorId);
    sensor.packets += 1;
    sensor.bytes += p.byteLength;
    sensor.throughputRing.push({ t: p.recvMillis, bytes: p.byteLength });
    // CRC failures are counted via recordCrcFail() (the dedicated emit branch),
    // not here, to avoid double-counting the same packet.

    for (const c of p.contributions) {
      const st = this.getStream(c.key, p.sensorId, c.label);
      st.label = c.label;
      st.samplingRateHz = c.samplingRateHz;
      st.samples += c.sampleCount;
      st.rateRing.push({
        t: p.recvMillis,
        n: c.sampleCount,
        devFirst: c.firstSampleMillis,
        dev: c.lastSampleMillis,
      });

      const prev = st.lastSampleMillis;
      if (
        !st.started ||
        !c.samplingRateHz ||
        c.samplingRateHz <= 0 ||
        prev == null ||
        c.lastSampleMillis == null
      ) {
        // No measurable gap yet -> assume every sample we got was expected.
        st.expectedSamples += c.sampleCount;
      } else {
        const interval = 1000 / c.samplingRateHz;
        const delta = c.lastSampleMillis - prev;
        if (delta > 0) {
          const expected = Math.round(delta / interval);
          st.expectedSamples += expected;
          st.lostSamples += Math.max(0, expected - c.sampleCount);
        }
        // delta <= 0 (reorder / duplicate): ignore for loss; still counted in samples.
      }

      st.started = true;
      if (c.lastSampleMillis != null) st.lastSampleMillis = c.lastSampleMillis;
    }
  }

  /** Record a CRC failure for a (possibly unknown) sensor. */
  recordCrcFail(sensorId?: number): void {
    const id = sensorId ?? -1;
    this.getSensor(id).crcFails += 1;
  }

  private prune(nowMillis: number): void {
    const cutoff = nowMillis - this.windowMillis;
    for (const s of this.sensors.values()) {
      s.throughputRing = pruneRing(s.throughputRing, cutoff);
    }
    for (const st of this.streams.values()) {
      st.rateRing = pruneRing(st.rateRing, cutoff);
    }
  }

  /**
   * Cadence-relative stall test: a stream is "stalled" only if its newest packet
   * is older than a multiple of its own observed packet interval (floored at the
   * window). This keeps a stalled stream reading 0 while NOT zeroing a healthy
   * stream that simply delivers less often than the window (big FIFO reads, slow
   * sensors). Events carry a receive time `t`.
   */
  private isStalled(ring: ReadonlyArray<{ t: number }>, nowMillis: number): boolean {
    if (ring.length === 0) return true;
    const newest = ring[ring.length - 1].t;
    const avgIntervalMillis =
      ring.length >= 2 ? (newest - ring[0].t) / (ring.length - 1) : this.windowMillis;
    const stallMillis = Math.max(this.windowMillis, 3 * avgIntervalMillis);
    return nowMillis - newest > stallMillis;
  }

  /**
   * Achieved sample rate for a sub-stream's windowed events.
   *
   * Measured over the *device-clock* span of the samples — from the first
   * sample of the oldest packet to the last sample of the newest packet (their
   * tsMillis), not the host receive-time window. This is robust to bursty BLE
   * delivery AND to large packets: one packet can carry hundreds of samples
   * spanning several seconds (e.g. a high FIFO watermark), so dividing its count
   * by the fixed receive window would over-report. Using the samples' own
   * device-time span gives the true rate even from a single packet. A stream
   * whose newest packet is older than a cadence-relative threshold reads 0 (see
   * {@link isStalled}).
   */
  private windowRateHz(ring: SampleEvent[], nowMillis: number): number {
    if (this.isStalled(ring, nowMillis)) return 0;

    let totalN = 0;
    let oldestFirst = Infinity;
    let newestLast = -Infinity;
    for (const e of ring) {
      totalN += e.n;
      if (e.devFirst != null && e.devFirst < oldestFirst) oldestFirst = e.devFirst;
      if (e.dev != null && e.dev > newestLast) newestLast = e.dev;
    }
    if (totalN <= 0) return 0;

    // N samples span N-1 intervals over the device-time window, so the rate is
    // (N-1) / span. A single packet uses its own first->last sample span; a
    // stream with no usable device span (1 sample / no timestamps) reads 0.
    const spanMillis = newestLast - oldestFirst;
    if (spanMillis > 0 && totalN > 1) return ((totalN - 1) / spanMillis) * 1000;
    return 0;
  }

  /**
   * Windowed throughput (bytes/sec) and packet rate over the *actual* receive
   * span of the retained events, robust to packets that arrive less often than
   * the window. Bytes/packets are counted after the oldest event (the span's
   * start point). Returns 0 if the stream is stalled (see {@link isStalled}).
   */
  private windowThroughput(
    ring: ByteEvent[],
    nowMillis: number,
  ): { bps: number; packetRateHz: number } {
    if (ring.length < 2 || this.isStalled(ring, nowMillis)) return { bps: 0, packetRateHz: 0 };
    const spanMillis = ring[ring.length - 1].t - ring[0].t;
    if (spanMillis <= 0) return { bps: 0, packetRateHz: 0 };
    let bytesAfterOldest = 0;
    for (let i = 1; i < ring.length; i++) bytesAfterOldest += ring[i].bytes;
    const spanSec = spanMillis / 1000;
    return { bps: bytesAfterOldest / spanSec, packetRateHz: (ring.length - 1) / spanSec };
  }

  /** Produce a snapshot of all statistics as of `nowMillis`. */
  snapshot(nowMillis: number): StreamStatsSnapshot {
    this.prune(nowMillis);

    const perSensor: Record<number, SensorStreamStats> = {};
    for (const s of this.sensors.values()) {
      const tp = this.windowThroughput(s.throughputRing, nowMillis);
      perSensor[s.sensorId] = {
        sensorId: s.sensorId,
        packets: s.packets,
        bytes: s.bytes,
        crcFails: s.crcFails,
        windowThroughputBps: tp.bps,
        windowPacketRateHz: tp.packetRateHz,
        streams: [],
      };
    }

    let totalPackets = 0;
    let totalBytes = 0;
    let totalCrcFails = 0;
    let totalSamples = 0;
    let totalExpected = 0;
    let totalLost = 0;
    let throughputBps = 0;

    for (const sid of Object.keys(perSensor)) {
      const s = perSensor[Number(sid)];
      totalPackets += s.packets;
      totalBytes += s.bytes;
      totalCrcFails += s.crcFails;
      throughputBps += s.windowThroughputBps;
    }

    const streamList = [...this.streams.values()].sort((a, b) => a.key.localeCompare(b.key));
    for (const st of streamList) {
      const lossPct = st.expectedSamples > 0 ? (st.lostSamples / st.expectedSamples) * 100 : 0;
      const row: StreamLossStats = {
        key: st.key,
        sensorId: st.sensorId,
        label: st.label,
        samplingRateHz: st.samplingRateHz,
        samples: st.samples,
        expectedSamples: st.expectedSamples,
        lostSamples: st.lostSamples,
        lossPct,
        windowSampleRateHz: this.windowRateHz(st.rateRing, nowMillis),
        lastSampleMillis: st.lastSampleMillis,
      };
      totalSamples += st.samples;
      totalExpected += st.expectedSamples;
      totalLost += st.lostSamples;

      // A stream's sensor row may not exist if recordPacket was never called for
      // it (only possible via a stray CRC-fail id); guard defensively.
      const sensorRow = perSensor[st.sensorId];
      if (sensorRow) sensorRow.streams.push(row);
    }

    return {
      durationMillis:
        this.sessionStartMillis != null ? Math.max(0, nowMillis - this.sessionStartMillis) : 0,
      totalPackets,
      totalSamples,
      totalBytes,
      totalCrcFails,
      throughputBps,
      lossPct: totalExpected > 0 ? (totalLost / totalExpected) * 100 : 0,
      perSensor,
    };
  }
}
