import { SensorBase } from './SensorBase.js';
import { i16le } from '../protocol.js';
import { OP_IDX } from '../constants.js';
import { CalibSensorId, applyImuCalibration } from '../calibration.js';
import type { StreamContribution } from '../../../core/StreamStats.js';

export interface LSM6DSVSample {
  tag: number;
  cnt: number;
  accel: { raw: [number, number, number]; cal: [number, number, number]; units: string } | null;
  gyro: { raw: [number, number, number]; cal: [number, number, number]; units: string } | null;
  mag: { raw: [number, number, number]; cal: [number, number, number]; units: string } | null;
}

export class SensorLSM6DSV extends SensorBase {
  private static readonly TAG_GYRO = 0x01;
  private static readonly TAG_ACCEL = 0x02;
  private static readonly TAG_SENSORHUB_SLAVE0 = 0x0e;

  accEnabled = true;
  gyroEnabled = true;
  magEnabled = true;

  private accelFsG = 2;
  private gyroFsDps = 2000;

  // Numeric full-scale codes (register values) used to select the device
  // calibration block: accel 0..3 (2/4/8/16 g), gyro 0..4 (125..2000 dps).
  private fsXlCode = 0;
  private fsGCode = 4;

  // Configured per-stream rates (the FIFO interleaves accel/gyro/mag, so each
  // stream is timestamped on its own rate — see computeSampleTimestamps). Public
  // so the per-sub-stream loss tracking (getStreamContributions) can read each.
  // accelHz/gyroHz are the configured LSM6DSV ODRs; magHz is the configured
  // magnetometer output (sensor-hub) rate. The firmware FIFO-batches accel/gyro
  // at their ODR, so they deliver at the configured rate; the mag is still
  // bounded by the accel/gyro hub trigger, so a mag rate above the accel/gyro
  // ODR delivers slower — which shows up as packet loss.
  accelHz = 15;
  gyroHz = 15;
  magHz = 15;

  constructor() {
    super();
    this.samplingRateHz = 15;
  }

  private decodeAccelFsG(code: number): number {
    switch (code) {
      case 0:
        return 2;
      case 1:
        return 4;
      case 2:
        return 8;
      case 3:
        return 16;
      default:
        return 2;
    }
  }

  private decodeGyroFsDps(code: number): number {
    // LSM6DSV FS_G datasheet register values.
    switch (code) {
      case 0:
        return 125;
      case 1:
        return 250;
      case 2:
        return 500;
      case 3:
        return 1000;
      case 4:
        return 2000;
      default:
        return 2000;
    }
  }

  private decodeOdrHz(code: number): number {
    // LSM6DSV ODR_XL / ODR_G datasheet register values (normal mode).
    switch (code) {
      case 0:
        return 0; // Off
      case 1:
        return 1.875;
      case 2:
        return 7.5;
      case 3:
        return 15;
      case 4:
        return 30;
      case 5:
        return 60;
      case 6:
        return 120;
      case 7:
        return 240;
      case 8:
        return 480;
      case 9:
        return 960;
      case 10:
        return 1920;
      case 11:
        return 3840;
      case 12:
        return 7680;
      default:
        return 15;
    }
  }

  private decodeMagOutputRateHz(code: number): number {
    // Magnetometer output (sensor-hub) rate code from op-config byte 20 bits 1:0.
    // This is the rate mag samples reach the host; the firmware derives the
    // underlying LIS2MDL ODR (20/50/100/100 Hz) to keep a fresh sample available.
    switch (code) {
      case 0:
        return 15;
      case 1:
        return 30;
      case 2:
        return 60;
      case 3:
        return 120;
      default:
        return 15;
    }
  }

  private calibrateAccel(raw: [number, number, number]): [number, number, number] {
    const dev = this.calibration?.getImu(CalibSensorId.LSM6DSV_ACCEL, this.fsXlCode);
    if (dev) return applyImuCalibration(raw, dev);
    const scale = (this.accelFsG / 32768) * 9.80665;
    return [raw[0] * scale, raw[1] * scale, raw[2] * scale];
  }

  private calibrateGyro(raw: [number, number, number]): [number, number, number] {
    const dev = this.calibration?.getImu(CalibSensorId.LSM6DSV_GYRO, this.fsGCode);
    if (dev) return applyImuCalibration(raw, dev);
    const scale = this.gyroFsDps / 32768;
    return [raw[0] * scale, raw[1] * scale, raw[2] * scale];
  }

  private calibrateMag(raw: [number, number, number]): [number, number, number] {
    const dev = this.calibration?.getImu(CalibSensorId.LIS2MDL_MAG, 0);
    if (dev) return applyImuCalibration(raw, dev);
    // LIS2MDL nominal sensitivity is 1.5 mGauss/LSB (0.15 uT/LSB).
    const scale = 0.15;
    return [raw[0] * scale, raw[1] * scale, raw[2] * scale];
  }

  override parsePayload(sensorPayloadBytes: Uint8Array): LSM6DSVSample[] {
    if (!sensorPayloadBytes?.length) return [];

    // Entry count is a 16-bit little-endian value (a full FIFO drain can return
    // more than 255 samples), followed by `count` x 7-byte tagged entries.
    const entryCount = ((sensorPayloadBytes[0] ?? 0) | ((sensorPayloadBytes[1] ?? 0) << 8)) >>> 0;
    const maxEntriesByLength = Math.floor((sensorPayloadBytes.length - 2) / 7);
    const n = Math.min(entryCount, maxEntriesByLength);

    const out: LSM6DSVSample[] = [];
    let offset = 2;

    for (let i = 0; i < n; i++) {
      const tagCnt = sensorPayloadBytes[offset];
      const tag = (tagCnt >> 3) & 0x1f;
      const cnt = (tagCnt >> 1) & 0x03;

      const x = i16le(sensorPayloadBytes, offset + 1);
      const y = i16le(sensorPayloadBytes, offset + 3);
      const z = i16le(sensorPayloadBytes, offset + 5);
      const raw: [number, number, number] = [x, y, z];

      let accel: LSM6DSVSample['accel'] = null;
      let gyro: LSM6DSVSample['gyro'] = null;
      let mag: LSM6DSVSample['mag'] = null;

      if (tag === SensorLSM6DSV.TAG_ACCEL && this.accEnabled) {
        accel = { raw, cal: this.calibrateAccel(raw), units: 'm/s^2' };
      } else if (tag === SensorLSM6DSV.TAG_GYRO && this.gyroEnabled) {
        gyro = { raw, cal: this.calibrateGyro(raw), units: 'deg/s' };
      } else if (tag === SensorLSM6DSV.TAG_SENSORHUB_SLAVE0 && this.magEnabled) {
        mag = { raw, cal: this.calibrateMag(raw), units: 'uT' };
      }

      if (accel || gyro || mag) {
        out.push({ tag, cnt, accel, gyro, mag });
      }

      offset += 7;
    }

    return out;
  }

  override applyOperationalConfig(op: Uint8Array): void {
    this.accEnabled = (op[OP_IDX.GEN_CFG_0] & 0b01000000) !== 0;
    this.gyroEnabled = (op[OP_IDX.GEN_CFG_0] & 0b00100000) !== 0;
    this.magEnabled = (op[OP_IDX.GEN_CFG_3] & 0b00000100) !== 0;

    const cfg0 = op[OP_IDX.LSM6DSV_CFG_0] ?? 0;
    const cfg1 = op[OP_IDX.LSM6DSV_CFG_1] ?? 0;
    const cfg2 = op[OP_IDX.LSM6DSV_CFG_2] ?? 0;

    const odrXl = cfg0 & 0x0f;
    const fsXl = (cfg0 >> 4) & 0x03;
    const odrG = cfg1 & 0x0f;
    const fsG = (cfg1 >> 4) & 0x0f;
    const odrMag = cfg2 & 0x03;

    this.accelFsG = this.decodeAccelFsG(fsXl);
    this.gyroFsDps = this.decodeGyroFsDps(fsG);
    this.fsXlCode = fsXl;
    this.fsGCode = fsG;

    this.accelHz = this.accEnabled ? this.decodeOdrHz(odrXl) : 0;
    this.gyroHz = this.gyroEnabled ? this.decodeOdrHz(odrG) : 0;
    // Configured mag output rate (NOT capped at the accel/gyro trigger). Loss is
    // measured against this, so when the accel/gyro that trigger the sensor hub
    // are too slow to deliver it, the shortfall surfaces as mag loss.
    this.magHz = this.magEnabled ? this.decodeMagOutputRateHz(odrMag) : 0;

    this.samplingRateHz = Math.max(this.accelHz, this.gyroHz, this.magHz, 1);
  }

  /**
   * Timestamp each stream (accel / gyro / mag) so all three cover the same block
   * time window. The tagged FIFO interleaves the streams, so the generic
   * global-index spacing spreads each stream by (#interleaved-streams)x too far
   * back and makes consecutive blocks overlap on the time axis.
   *
   * Each stream's effective rate is derived from *this block*: the block's
   * covered duration is taken from a directly-sampled reference stream (accel,
   * else gyro) at its known ODR, and every stream is then spread evenly over
   * that same duration by its own sample count. This is important for the mag
   * (LIS2MDL), which is read via the LSM6DSV sensor hub — its entries land in
   * the FIFO at the hub batch rate, NOT the LIS2MDL ODR, so a fixed mag ODR
   * would mis-spread it (the zig-zag). Deriving the rate from the block keeps it
   * aligned regardless of the hub rate.
   */
  override computeSampleTimestamps(
    decodedSamples: unknown[],
    block: {
      tsLastSampleMillis: number;
      systemTsLastSampleMillis: number;
      systemOffsetFirstTime?: number | null;
    },
  ): Array<{ tsMillis: number; systemTsMillis: number; systemTsPlotMillis: number }> {
    const samples = decodedSamples as LSM6DSVSample[];

    let accelTotal = 0;
    let gyroTotal = 0;
    let magTotal = 0;
    for (const s of samples) {
      if (s.accel) accelTotal++;
      else if (s.gyro) gyroTotal++;
      else if (s.mag) magTotal++;
    }

    // Block duration (s) from a directly-sampled reference stream at a known ODR.
    let blockPeriodSec = 0;
    if (accelTotal > 0 && this.accelHz > 0) blockPeriodSec = accelTotal / this.accelHz;
    else if (gyroTotal > 0 && this.gyroHz > 0) blockPeriodSec = gyroTotal / this.gyroHz;
    else if (magTotal > 0 && this.magHz > 0) blockPeriodSec = magTotal / this.magHz;

    // Effective per-stream rate so each stream spans exactly blockPeriodSec.
    const rateFor = (total: number): number =>
      blockPeriodSec > 0 && total > 0 ? total / blockPeriodSec : (this.samplingRateHz ?? 1);
    const accelRate = rateFor(accelTotal);
    const gyroRate = rateFor(gyroTotal);
    const magRate = rateFor(magTotal);

    let ai = 0;
    let gi = 0;
    let mi = 0;
    return samples.map((s) => {
      let numSamples = samples.length;
      let i = 0;
      let rate = this.samplingRateHz;
      if (s.accel) {
        numSamples = accelTotal;
        i = ai++;
        rate = accelRate;
      } else if (s.gyro) {
        numSamples = gyroTotal;
        i = gi++;
        rate = gyroRate;
      } else if (s.mag) {
        numSamples = magTotal;
        i = mi++;
        rate = magRate;
      }
      return this.extrapolateSampleTimes({
        numSamples,
        i,
        samplingRateHz: rate,
        tsLastSampleMillis: block.tsLastSampleMillis,
        systemTsLastSampleMillis: block.systemTsLastSampleMillis,
        systemOffsetFirstTime: block.systemOffsetFirstTime,
      });
    });
  }

  /**
   * Report up to three independent sub-streams (accel / gyro / mag) so loss is
   * tracked per stream. Each sub-stream's expected rate is its configured rate
   * (ODR for accel/gyro, output rate for mag); loss is measured against that, so
   * the mag's hub-trigger bound — or any rate the firmware/link can't keep up
   * with — surfaces as loss when a configured rate exceeds what's delivered.
   */
  override getStreamContributions(
    samplesWithTime: Array<{ timestamps?: { tsMillis: number } }>,
    sensorId: number,
  ): StreamContribution[] {
    const samples = samplesWithTime as Array<LSM6DSVSample & { timestamps?: { tsMillis: number } }>;

    const subs: Array<{
      key: string;
      label: string;
      rate: number;
      has: (s: LSM6DSVSample) => boolean;
    }> = [
      {
        key: `${sensorId}:accel`,
        label: 'Accel',
        rate: this.accelHz,
        has: (s) => !!s.accel,
      },
      {
        key: `${sensorId}:gyro`,
        label: 'Gyro',
        rate: this.gyroHz,
        has: (s) => !!s.gyro,
      },
      // Mag enters the FIFO at its configured sensor-hub output rate (`magHz`).
      { key: `${sensorId}:mag`, label: 'Mag', rate: this.magHz, has: (s) => !!s.mag },
    ];

    const out: StreamContribution[] = [];
    for (const sub of subs) {
      let count = 0;
      let first: number | null = null;
      let last: number | null = null;
      for (const s of samples) {
        if (!sub.has(s)) continue;
        count++;
        const t = s?.timestamps?.tsMillis;
        if (typeof t !== 'number') continue;
        if (first == null || t < first) first = t;
        if (last == null || t > last) last = t;
      }
      if (count === 0) continue; // disabled or no samples in this burst
      out.push({
        key: sub.key,
        label: sub.label,
        samplingRateHz: sub.rate > 0 ? sub.rate : null,
        sampleCount: count,
        firstSampleMillis: first,
        lastSampleMillis: last,
      });
    }
    return out;
  }
}
