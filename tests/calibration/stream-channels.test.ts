import { describe, expect, it } from 'vitest';
import { ObjectCluster } from '../../src/core/ObjectCluster.js';
import {
  ADC_BITS,
  ADC_VREF_VOLTS,
  BATTERY_DIVIDER_RATIO,
  SCALAR_CALIBRATORS,
  calibrateStreamFrame,
  type StreamCalibrationState,
} from '../../src/devices/calibration/streamChannels.js';
import {
  channelFormatsFor,
  type ShimmerGeneration,
} from '../../src/devices/shimmer3r/channelFormats.js';
import { parseBmp390Coefficients } from '../../src/devices/pressure/index.js';
import type { PressureCalibration } from '../../src/devices/pressure/index.js';

const BMP390_BLOCK = Uint8Array.from([
  0xe7, 0x6b, 0xf0, 0x4a, 0xf9, 0xab, 0x1c, 0x9b, 0x15, 0x06, 0x01, 0xd2, 0x49, 0x18, 0x5f, 0x03,
  0xfa, 0x3a, 0x0f, 0x07, 0xf5,
]);

const bmp390: PressureCalibration = {
  sensor: 'bmp390',
  coefficients: parseBmp390Coefficients(BMP390_BLOCK),
  calibrated: true,
  raw: BMP390_BLOCK,
};

function state(over: Partial<StreamCalibrationState> = {}): StreamCalibrationState {
  return {
    generation: 'shimmer3r',
    family: 'shimmer3r',
    ranges: { lnAccel: 0, wrAccel: 0, gyro: 0, mag: 0, altAccel: 0, altMag: 0 },
    emitInertial: true,
    gsrRange: 0,
    exg: null,
    pressure: null,
    pressureOversampling: 0,
    ...over,
  };
}

/** A frame carrying one raw field per channel name of a generation. */
function frameFor(generation: ShimmerGeneration, value = 2000): ObjectCluster {
  const oc = new ObjectCluster('test');
  oc.add('TIMESTAMP', 12345, 'ticks', 'raw');
  for (const fmt of Object.values(channelFormatsFor(generation))) {
    oc.add(fmt.name, value, 'no_units', 'raw');
  }
  return oc;
}

const calNames = (oc: ObjectCluster): string[] =>
  oc.fields.filter((f) => f.kind === 'cal').map((f) => f.name);

describe('ADC constants', () => {
  it('are 3.0 V at 12 bits, both generations', () => {
    // The Java u14 type string describes no shipping firmware path; the only
    // 14-bit resolution in the platform code is under SHIMMER4_SDK.
    expect(ADC_VREF_VOLTS).toBe(3);
    expect(ADC_BITS).toBe(12);
    expect(BATTERY_DIVIDER_RATIO).toBe(2);
  });
});

describe('calibrateStreamFrame — coverage', () => {
  it('calibrates every Shimmer3R channel a frame can carry', () => {
    const oc = frameFor('shimmer3r');
    calibrateStreamFrame(oc, state({ pressure: bmp390 }));
    const cal = new Set(calNames(oc));

    // Inertial triples.
    for (const n of [
      'LN_ACCEL_X',
      'LN_ACCEL_Y',
      'LN_ACCEL_Z',
      'WR_ACCEL_X',
      'WR_ACCEL_Y',
      'WR_ACCEL_Z',
      'GYRO_X',
      'GYRO_Y',
      'GYRO_Z',
      'MAG_X',
      'MAG_Y',
      'MAG_Z',
      'HG_ACCEL_X',
      'HG_ACCEL_Y',
      'HG_ACCEL_Z',
      'ALT_MAG_X',
      'ALT_MAG_Y',
      'ALT_MAG_Z',
    ]) {
      expect(cal.has(n), n).toBe(true);
    }
    // Everything that used to reach a host as raw counts only.
    for (const n of [
      'BATTERY',
      'EXT_ADC_0',
      'EXT_ADC_1',
      'EXT_ADC_2',
      'INT_ADC_0',
      'INT_ADC_2',
      'INT_ADC_3',
      'PPG',
      'PRESSURE',
      'TEMPERATURE',
      'GSR',
      'Exg1_Status',
      'Exg2_Status',
      'Exg1_CH1_24Bit',
      'Exg1_CH2_24Bit',
      'Exg2_CH1_24Bit',
      'Exg2_CH2_24Bit',
      'Exg1_CH1_16Bit',
      'Exg1_CH2_16Bit',
      'Exg2_CH1_16Bit',
      'Exg2_CH2_16Bit',
    ]) {
      expect(cal.has(n), n).toBe(true);
    }
    // Plus the two GSR channels that only exist calibrated.
    expect(cal.has('GSR_RESISTANCE')).toBe(true);
    expect(cal.has('GSR_RANGE')).toBe(true);
  });

  it('calibrates every Shimmer3 channel, bridge amplifier included', () => {
    const oc = frameFor('shimmer3');
    calibrateStreamFrame(
      oc,
      state({ generation: 'shimmer3', family: 'shimmer3-old', pressure: bmp390 }),
    );
    const cal = new Set(calNames(oc));
    for (const n of [
      'BATTERY',
      'EXT_EXP_ADC_A6',
      'EXT_EXP_ADC_A7',
      'EXT_EXP_ADC_A15',
      'INT_EXP_ADC_A1',
      'INT_EXP_ADC_A12',
      'INT_EXP_ADC_A14',
      'BRIDGE_AMP_HIGH',
      'BRIDGE_AMP_LOW',
      'PPG',
      'GSR',
      'PRESSURE',
      'TEMPERATURE',
    ]) {
      expect(cal.has(n), n).toBe(true);
    }
  });

  it('leaves every raw field exactly as the decoder wrote it', () => {
    const oc = frameFor('shimmer3r', 1234);
    calibrateStreamFrame(oc, state({ pressure: bmp390 }));
    for (const f of oc.fields) {
      if (f.kind !== 'raw') continue;
      if (f.name === 'TIMESTAMP') continue;
      expect(f.value, f.name).toBe(1234);
    }
  });

  it('never calibrates the timestamp — that is the client’s clock', () => {
    const oc = frameFor('shimmer3r');
    calibrateStreamFrame(oc, state());
    expect(calNames(oc)).not.toContain('TIMESTAMP');
  });

  it('adds nothing for a channel this SDK cannot convert', () => {
    const oc = new ObjectCluster('test');
    oc.add('CH_ff', 999, 'no_units', 'raw');
    calibrateStreamFrame(oc, state());
    // Better an honestly raw-only column than a `cal` field holding the same
    // number and claiming a conversion.
    expect(calNames(oc)).toEqual([]);
  });
});

describe('calibrateStreamFrame — values and units', () => {
  const one = (name: string, raw: number, over: Partial<StreamCalibrationState> = {}) => {
    const oc = new ObjectCluster('test');
    oc.add(name, raw, 'no_units', 'raw');
    calibrateStreamFrame(oc, state({ emitInertial: false, ...over }));
    return oc.get(name, 'cal')!;
  };

  it('converts an ADC line to millivolts', () => {
    expect(one('EXT_ADC_0', 2048).value).toBeCloseTo(1500.3663004, 6);
    expect(one('EXT_ADC_0', 4095).value).toBeCloseTo(3000, 9);
    expect(one('EXT_ADC_0', 0).value).toBe(0);
    expect(one('EXT_ADC_0', 2048).unit).toBe('mV');
  });

  it('converts the battery through its x2 divider', () => {
    expect(one('BATTERY', 2048).value).toBeCloseTo(3000.7326007, 6);
    expect(one('BATTERY', 2048).unit).toBe('mV');
  });

  it('converts PPG as the ADC line it is', () => {
    expect(one('PPG', 2048).value).toBeCloseTo(one('EXT_ADC_0', 2048).value, 9);
  });

  it('converts the bridge amplifier with the board’s offset and gain', () => {
    expect(one('BRIDGE_AMP_HIGH', 4095).value).toBeCloseTo(5.3648711, 6);
    expect(one('BRIDGE_AMP_HIGH', 60).value).toBe(0);
    expect(one('BRIDGE_AMP_LOW', 4095).value).toBeCloseTo(8.5543199, 6);
    expect(one('BRIDGE_AMP_LOW', 1950).value).toBe(0);
  });

  it('converts ExG at the chip defaults when no bank has been read', () => {
    expect(one('Exg1_CH1_24Bit', 8388607).value).toBeCloseTo(403.3333333, 6);
    expect(one('Exg1_CH1_16Bit', 32767).value).toBeCloseTo(201.6666667, 6);
    expect(one('Exg1_CH1_24Bit', 8388607).unit).toBe('mV');
  });

  it('passes the ExG status byte through with no unit', () => {
    const f = one('Exg1_Status', 0x2c);
    expect(f.value).toBe(0x2c);
    expect(f.unit).toBe('no_units');
  });

  it('reads the ExG gain and reference out of the banks it is given', () => {
    // Bank byte 3 bits 4-6 = ch1 gain setting; 6 is gain 12. Bank byte 1 bit 4
    // = the 4.033 V reference.
    const exg1 = new Uint8Array(10);
    exg1[3] = 6 << 4;
    exg1[1] = 1 << 4;
    const f = one('Exg1_CH1_24Bit', 1e6, { exg: { exg1, exg2: new Uint8Array(10) } });
    expect(f.value).toBeCloseTo(40.0642602, 6);
    // Chip 2's bank is untouched, so it keeps the defaults.
    const g = one('Exg2_CH1_24Bit', 1e6, { exg: { exg1, exg2: new Uint8Array(10) } });
    expect(g.value).toBeCloseTo(48.0810859, 6);
  });

  it('converts inertial channels with their own units', () => {
    const oc = new ObjectCluster('test');
    for (const axis of ['X', 'Y', 'Z']) oc.add(`GYRO_${axis}`, 1000, 'no_units', 'raw');
    calibrateStreamFrame(oc, state());
    expect(oc.get('GYRO_X', 'cal')!.unit).toBe('deg/s');
  });

  it('suppresses only the inertial groups when asked to', () => {
    const oc = frameFor('shimmer3r');
    calibrateStreamFrame(oc, state({ emitInertial: false, pressure: bmp390 }));
    const cal = new Set(calNames(oc));
    expect(cal.has('GYRO_X')).toBe(false);
    expect(cal.has('LN_ACCEL_X')).toBe(false);
    // Everything else still converts.
    expect(cal.has('BATTERY')).toBe(true);
    expect(cal.has('GSR')).toBe(true);
    expect(cal.has('PRESSURE')).toBe(true);
  });
});

describe('calibrateStreamFrame — pressure pair', () => {
  const pair = (over: Partial<StreamCalibrationState>) => {
    const oc = new ObjectCluster('test');
    oc.add('PRESSURE', 0x640d00, 'no_units', 'raw');
    oc.add('TEMPERATURE', 0x7fba00, 'no_units', 'raw');
    calibrateStreamFrame(oc, state({ emitInertial: false, ...over }));
    return oc;
  };

  it('compensates both channels together, in kPa and °C', () => {
    const oc = pair({ pressure: bmp390 });
    expect(oc.get('PRESSURE', 'cal')!.value).toBeCloseTo(100.9118245, 6);
    expect(oc.get('PRESSURE', 'cal')!.unit).toBe('kPa');
    expect(oc.get('TEMPERATURE', 'cal')!.value).toBeCloseTo(23.1701699, 6);
    expect(oc.get('TEMPERATURE', 'cal')!.unit).toBe('Degrees Celsius');
  });

  it('leaves both raw-only when the coefficients were never read', () => {
    const oc = pair({ pressure: null });
    expect(oc.get('PRESSURE', 'cal')).toBeNull();
    expect(oc.get('TEMPERATURE', 'cal')).toBeNull();
    // The raw values survive, so a host still has something to plot.
    expect(oc.get('PRESSURE', 'raw')!.value).toBe(0x640d00);
  });

  it('leaves both raw-only when the coefficient block was blank', () => {
    const oc = pair({
      pressure: {
        sensor: 'bmp390',
        coefficients: null,
        calibrated: false,
        raw: new Uint8Array(21),
      },
    });
    expect(oc.get('PRESSURE', 'cal')).toBeNull();
    expect(oc.get('TEMPERATURE', 'cal')).toBeNull();
  });

  it('needs no coefficients for a BMP581', () => {
    const oc = new ObjectCluster('test');
    oc.add('PRESSURE', 6400000, 'no_units', 'raw');
    oc.add('TEMPERATURE', 1638400, 'no_units', 'raw');
    calibrateStreamFrame(
      oc,
      state({
        emitInertial: false,
        pressure: {
          sensor: 'bmp581',
          coefficients: null,
          calibrated: true,
          raw: new Uint8Array(0),
        },
      }),
    );
    expect(oc.get('PRESSURE', 'cal')!.value).toBe(100);
    expect(oc.get('TEMPERATURE', 'cal')!.value).toBe(25);
  });

  it('does nothing when only one of the pair is present', () => {
    const oc = new ObjectCluster('test');
    oc.add('PRESSURE', 0x640d00, 'no_units', 'raw');
    calibrateStreamFrame(oc, state({ emitInertial: false, pressure: bmp390 }));
    expect(oc.get('PRESSURE', 'cal')).toBeNull();
  });

  /** BST-BMP180-DS000 §3.5's own coefficients, block and parsed. */
  const bmp180 = (): PressureCalibration => {
    const raw = new Uint8Array(22);
    const put = (o: number, v: number) => {
      raw[o] = (v >> 8) & 0xff;
      raw[o + 1] = v & 0xff;
    };
    const c = {
      ac1: 408,
      ac2: -72,
      ac3: -14383,
      ac4: 32741,
      ac5: 32757,
      ac6: 23153,
      b1: 6190,
      b2: 4,
      mb: -32768,
      mc: -8711,
      md: 2868,
    };
    put(0, c.ac1);
    put(2, c.ac2 & 0xffff);
    put(4, c.ac3 & 0xffff);
    put(6, c.ac4);
    put(8, c.ac5);
    put(10, c.ac6);
    put(12, c.b1);
    put(14, c.b2);
    put(16, c.mb & 0xffff);
    put(18, c.mc & 0xffff);
    put(20, c.md);
    return { sensor: 'bmp180', coefficients: c, calibrated: true, raw };
  };

  it('passes the oversampling through to the BMP180 compensation', () => {
    const oc = new ObjectCluster('test');
    oc.add('PRESSURE', 23843 * 256, 'no_units', 'raw');
    oc.add('TEMPERATURE', 27898, 'no_units', 'raw');
    calibrateStreamFrame(
      oc,
      state({
        emitInertial: false,
        generation: 'shimmer3',
        family: 'shimmer3-old',
        pressureOversampling: 0,
        pressure: bmp180(),
      }),
    );
    expect(oc.get('PRESSURE', 'cal')!.value).toBeCloseTo(69.9606585, 6);
    expect(oc.get('TEMPERATURE', 'cal')!.value).toBeCloseTo(15.0471242, 6);
  });

  it('and the setting reaches the compensation, rather than defaulting to zero', () => {
    /* The oversampling parameter defaults to 0 in `compensatePressure`, so a
       test that passes 0 cannot tell a forwarded setting from a dropped one.
       This one passes 3 against a raw value that is NOT the chip's own
       left-aligned output, where the two settings genuinely disagree: the
       `2^(8-oss)` shift no longer cancels, and oss 3 reads about eight times
       the pressure of oss 0. */
    const read = (oss: number): number => {
      const oc = new ObjectCluster('test');
      oc.add('PRESSURE', 23843, 'no_units', 'raw');
      oc.add('TEMPERATURE', 27898, 'no_units', 'raw');
      calibrateStreamFrame(
        oc,
        state({
          emitInertial: false,
          generation: 'shimmer3',
          family: 'shimmer3-old',
          pressureOversampling: oss,
          pressure: bmp180(),
        }),
      );
      return oc.get('PRESSURE', 'cal')!.value;
    };
    expect(read(3)).toBeGreaterThan(read(0) * 1.5);
  });
});

describe('SCALAR_CALIBRATORS', () => {
  it('gives every entry a unit from the shared vocabulary', () => {
    const allowed = new Set(['mV', 'no_units']);
    for (const [name, c] of Object.entries(SCALAR_CALIBRATORS)) {
      expect(allowed.has(c.unit), `${name} → ${c.unit}`).toBe(true);
    }
  });

  it('is frozen, so a host cannot reach in and change a conversion', () => {
    expect(Object.isFrozen(SCALAR_CALIBRATORS)).toBe(true);
  });
});
