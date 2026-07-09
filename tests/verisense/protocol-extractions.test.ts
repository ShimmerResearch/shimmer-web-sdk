import { describe, it, expect } from 'vitest';
import {
  VERISENSE_MAX_PLAUSIBLE_UNIX_SECONDS,
  formatVerisenseUnixAndHuman,
  decodeVerisenseBleOptimizationResult,
  defaultVerisensePasskeyForId,
  buildVerisenseAdvertisedName,
  parseVerisenseAdvertisedName,
  deriveVerisenseMacIdFromName,
  verisenseDeviceFileTag,
} from '../../src/devices/verisense/protocolUtils.js';
import {
  VERISENSE_OPERATIONAL_FIELD_SCHEMA,
  VERISENSE_OP_CONFIG_BYTE_SIZE,
  VERISENSE_SENSOR_ENABLE_FIELDS,
  VERISENSE_SENSOR_RATE_DEFAULT_GROUPS,
  resolveVerisenseSensorRateFieldKey,
  VERISENSE_BLE_SYNC_SCHEDULES,
  VERISENSE_BLE_SCHEDULE_DEFAULTS,
  minutesSinceMidnightToHHMM,
  hhmmToMinutesSinceMidnight,
  padVerisenseOperationalConfig,
  expectedVerisenseStreamSensorIds,
  expectedVerisenseStreamSensorIdsFromConfig,
  createBlankVerisenseOperationalConfig,
} from '../../src/devices/verisense/operationalConfig.js';

const SCHEMA_KEYS = new Set(VERISENSE_OPERATIONAL_FIELD_SCHEMA.map((f) => f.key));
const ENABLE_KEYS = new Set(VERISENSE_SENSOR_ENABLE_FIELDS.map((f) => f.key));

describe('decodeVerisenseBleOptimizationResult', () => {
  it('decodes the not-connected flag', () => {
    expect(decodeVerisenseBleOptimizationResult(0x80).notConnected).toBe(true);
    expect(decodeVerisenseBleOptimizationResult(0x00).notConnected).toBe(false);
  });

  it('decodes the individual request flags', () => {
    const r = decodeVerisenseBleOptimizationResult(0x07);
    expect(r).toEqual({
      notConnected: false,
      phyRequested: true,
      connIntervalRequested: true,
      dataLengthRequested: true,
      resultMask: 0x07,
    });
    expect(decodeVerisenseBleOptimizationResult(0x02)).toMatchObject({
      phyRequested: false,
      connIntervalRequested: true,
      dataLengthRequested: false,
    });
  });
});

describe('defaultVerisensePasskeyForId', () => {
  it('maps passkey ID 01 to the fixed firmware default', () => {
    expect(defaultVerisensePasskeyForId('01')).toBe('123456');
    expect(defaultVerisensePasskeyForId(' 01 ')).toBe('123456');
  });

  it('has no default for other IDs', () => {
    expect(defaultVerisensePasskeyForId('00')).toBeUndefined();
    expect(defaultVerisensePasskeyForId('')).toBeUndefined();
    expect(defaultVerisensePasskeyForId(null)).toBeUndefined();
  });
});

describe('Verisense advertised-name codec', () => {
  it('builds prefix-passkeyId-uniqueId', () => {
    expect(
      buildVerisenseAdvertisedName({
        prefix: 'Verisense',
        passkeyId: '01',
        uniqueId: '25112101B10F',
      }),
    ).toBe('Verisense-01-25112101B10F');
  });

  it('returns null when a part is missing', () => {
    expect(buildVerisenseAdvertisedName({ prefix: 'Verisense', passkeyId: '01' })).toBeNull();
    expect(buildVerisenseAdvertisedName({})).toBeNull();
  });

  it('parses back, keeping dashes inside the prefix', () => {
    expect(parseVerisenseAdvertisedName('Verisense-01-25112101B10F')).toEqual({
      prefix: 'Verisense',
      passkeyId: '01',
      uniqueId: '25112101B10F',
    });
    expect(parseVerisenseAdvertisedName('My-Trial-00-26011401ABCD')).toEqual({
      prefix: 'My-Trial',
      passkeyId: '00',
      uniqueId: '26011401ABCD',
    });
    expect(parseVerisenseAdvertisedName('no-tokens')).toBeNull();
    expect(parseVerisenseAdvertisedName(null)).toBeNull();
  });

  it('round-trips build → parse', () => {
    const parts = { prefix: 'Verisense', passkeyId: '01', uniqueId: '25112101B10F' };
    expect(parseVerisenseAdvertisedName(buildVerisenseAdvertisedName(parts))).toEqual(parts);
  });

  it('derives the MAC ID from the name tail', () => {
    expect(deriveVerisenseMacIdFromName('Verisense-01-25112101B10F')).toBe('B10F');
    expect(deriveVerisenseMacIdFromName('Verisense-01-XYZ')).toBeNull();
    expect(deriveVerisenseMacIdFromName('')).toBeNull();
  });

  it('builds a short device file tag from an ID or name', () => {
    expect(verisenseDeviceFileTag('25112101B10F')).toBe('B10F');
    expect(verisenseDeviceFileTag('Verisense-01-25112101b10f')).toBe('B10F');
    expect(verisenseDeviceFileTag('-')).toBe('');
    expect(verisenseDeviceFileTag(null)).toBe('');
  });
});

describe('timestamp plausibility bound', () => {
  it('is honoured by formatVerisenseUnixAndHuman', () => {
    expect(formatVerisenseUnixAndHuman(VERISENSE_MAX_PLAUSIBLE_UNIX_SECONDS + 1).human).toBe(
      'not-valid',
    );
  });
});

describe('expectedVerisenseStreamSensorIds', () => {
  it('splits the IMU stream ID by hardware generation', () => {
    expect(expectedVerisenseStreamSensorIds({ gyro: true }, { secondGeneration: false })).toEqual(
      new Set([3]),
    );
    expect(expectedVerisenseStreamSensorIds({ mag: true }, { secondGeneration: true })).toEqual(
      new Set([6]),
    );
  });

  it('maps every sensor family to its stream ID', () => {
    const ids = expectedVerisenseStreamSensorIds(
      {
        gsr: true,
        accel1: true,
        accel2: true,
        ppg: true,
        ambientLight: true,
        skinTemp: true,
        algoHub: true,
      },
      { secondGeneration: true },
    );
    expect(ids).toEqual(new Set([1, 2, 6, 4, 7, 9, 8]));
  });

  it('shares stream 1 across GSR / VBatt / VProg', () => {
    expect(expectedVerisenseStreamSensorIds({ vprog: true }, { secondGeneration: false })).toEqual(
      new Set([1]),
    );
  });

  it('reads enables straight from op-config bytes', () => {
    const op = createBlankVerisenseOperationalConfig(VERISENSE_OP_CONFIG_BYTE_SIZE);
    const setEnable = (key: string) => {
      const f = VERISENSE_SENSOR_ENABLE_FIELDS.find((x) => x.key === key)!;
      op[f.index] |= 1 << f.shift;
    };
    setEnable('ACCEL_1_EN');
    setEnable('PPG_IR_EN');
    setEnable('SKIN_TEMP_EN');
    expect(expectedVerisenseStreamSensorIdsFromConfig(op, { secondGeneration: true })).toEqual(
      new Set([2, 4, 9]),
    );
    expect(expectedVerisenseStreamSensorIdsFromConfig(null, { secondGeneration: true })).toEqual(
      new Set(),
    );
  });
});

describe('padVerisenseOperationalConfig', () => {
  it('pads legacy 86-byte templates to the canonical v9 size', () => {
    const legacy = new Uint8Array(86).fill(0x11);
    legacy[0] = 0x5a;
    const full = padVerisenseOperationalConfig(legacy);
    expect(full.length).toBe(VERISENSE_OP_CONFIG_BYTE_SIZE);
    expect(full[0]).toBe(0x5a);
    expect(full[85]).toBe(0x11);
  });

  it('returns full-size configs unchanged', () => {
    const full = new Uint8Array(VERISENSE_OP_CONFIG_BYTE_SIZE);
    expect(padVerisenseOperationalConfig(full)).toBe(full);
  });
});

describe('BLE sync-schedule tables', () => {
  it('references only real op-config field keys', () => {
    for (const s of VERISENSE_BLE_SYNC_SCHEDULES) {
      for (const key of [s.intervalKey, s.timeKey, s.durKey, s.retryKey]) {
        expect(SCHEMA_KEYS.has(key), `schema is missing ${key}`).toBe(true);
      }
    }
    expect(SCHEMA_KEYS.has('BLE_CONNECTION_TRIES_PER_DAY')).toBe(true);
  });

  it('carries the canonical defaults (01:00 daily, 10 min window)', () => {
    expect(VERISENSE_BLE_SCHEDULE_DEFAULTS.intervalHours).toBe(24);
    expect(minutesSinceMidnightToHHMM(VERISENSE_BLE_SCHEDULE_DEFAULTS.timeMins)).toBe('01:00');
  });
});

describe('sensor rate-default table', () => {
  it('references only real enable and field keys', () => {
    for (const group of VERISENSE_SENSOR_RATE_DEFAULT_GROUPS) {
      for (const enableKey of group.enableKeys) {
        expect(ENABLE_KEYS.has(enableKey), `enable schema is missing ${enableKey}`).toBe(true);
      }
      for (const field of group.fields) {
        for (const gen of ['ds3', 'dsv'] as const) {
          const key = resolveVerisenseSensorRateFieldKey(field, gen);
          expect(key, `no key for ${group.enableKeys.join('/')} on ${gen}`).toBeTruthy();
          expect(SCHEMA_KEYS.has(key!), `schema is missing ${key}`).toBe(true);
        }
      }
    }
  });

  it('resolves generation-specific IMU keys', () => {
    const accel2 = VERISENSE_SENSOR_RATE_DEFAULT_GROUPS.find((g) =>
      g.enableKeys.includes('ACCEL_2_EN'),
    )!;
    expect(resolveVerisenseSensorRateFieldKey(accel2.fields[0], 'ds3')).toBe('ODR_XL');
    expect(resolveVerisenseSensorRateFieldKey(accel2.fields[0], 'dsv')).toBe('LSM6DSV_ODR_XL');
  });
});

describe('minutes ↔ HH:MM transforms', () => {
  it('formats minutes-since-midnight', () => {
    expect(minutesSinceMidnightToHHMM(0)).toBe('00:00');
    expect(minutesSinceMidnightToHHMM(60)).toBe('01:00');
    expect(minutesSinceMidnightToHHMM(1439)).toBe('23:59');
    expect(minutesSinceMidnightToHHMM(1440)).toBeNull();
    expect(minutesSinceMidnightToHHMM(null)).toBeNull();
  });

  it('rounds fractional minutes without ever emitting ":60"', () => {
    expect(minutesSinceMidnightToHHMM(59.6)).toBe('01:00');
    expect(minutesSinceMidnightToHHMM(59.4)).toBe('00:59');
    expect(minutesSinceMidnightToHHMM(1439.4)).toBe('23:59');
    // Rounds past the valid range -> rejected, not "24:00".
    expect(minutesSinceMidnightToHHMM(1439.6)).toBeNull();
  });

  it('parses HH:MM (and H:MM)', () => {
    expect(hhmmToMinutesSinceMidnight('01:00')).toBe(60);
    expect(hhmmToMinutesSinceMidnight('7:05')).toBe(425);
    expect(hhmmToMinutesSinceMidnight('23:59')).toBe(1439);
    expect(hhmmToMinutesSinceMidnight('24:00')).toBeNull();
    expect(hhmmToMinutesSinceMidnight('nope')).toBeNull();
  });

  it('round-trips', () => {
    for (const mins of [0, 59, 60, 725, 1439]) {
      expect(hhmmToMinutesSinceMidnight(minutesSinceMidnightToHHMM(mins)!)).toBe(mins);
    }
  });
});
