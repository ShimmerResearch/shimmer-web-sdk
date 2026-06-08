import { SensorBase } from './SensorBase.js';
import { i16le } from '../protocol.js';
import { OP_IDX } from '../constants.js';

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

  // Per-stream ODRs (the FIFO interleaves accel/gyro/mag, so each stream is
  // timestamped on its own rate — see computeSampleTimestamps).
  private accelHz = 15;
  private gyroHz = 15;
  private magHz = 10;

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

  private decodeMagOdrHz(code: number): number {
    // LIS2MDL ODR datasheet register values.
    switch (code) {
      case 0:
        return 10;
      case 1:
        return 20;
      case 2:
        return 50;
      case 3:
        return 100;
      default:
        return 10;
    }
  }

  private calibrateAccel(raw: [number, number, number]): [number, number, number] {
    const scale = (this.accelFsG / 32768) * 9.80665;
    return [raw[0] * scale, raw[1] * scale, raw[2] * scale];
  }

  private calibrateGyro(raw: [number, number, number]): [number, number, number] {
    const scale = this.gyroFsDps / 32768;
    return [raw[0] * scale, raw[1] * scale, raw[2] * scale];
  }

  private calibrateMag(raw: [number, number, number]): [number, number, number] {
    // LIS2MDL nominal sensitivity is 1.5 mGauss/LSB (0.15 uT/LSB).
    const scale = 0.15;
    return [raw[0] * scale, raw[1] * scale, raw[2] * scale];
  }

  override parsePayload(sensorPayloadBytes: Uint8Array): LSM6DSVSample[] {
    if (!sensorPayloadBytes?.length) return [];

    const entryCount = sensorPayloadBytes[0] ?? 0;
    const maxEntriesByLength = Math.floor((sensorPayloadBytes.length - 1) / 7);
    const n = Math.min(entryCount, maxEntriesByLength);

    const out: LSM6DSVSample[] = [];
    let offset = 1;

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

    this.accelHz = this.accEnabled ? this.decodeOdrHz(odrXl) : 0;
    this.gyroHz = this.gyroEnabled ? this.decodeOdrHz(odrG) : 0;
    this.magHz = this.magEnabled ? this.decodeMagOdrHz(odrMag) : 0;

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
}
