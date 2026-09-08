import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRIAL_NAME,
  macShortId,
  defaultDeviceName,
  defaultTrialIdentity,
} from '../../src/devices/infomem/defaults.js';
import {
  SHIMMER3_INFOMEM_FIELD_SCHEMA,
  SHIMMER3_INFOMEM_FIELD_GROUPS,
} from '../../src/devices/infomem/schema.js';

describe('default trial identity', () => {
  it('names a device from the last four hex characters of its MAC', () => {
    expect(defaultDeviceName('DF1797A1F3F8')).toBe('Shimmer_F3F8');
  });

  it('accepts separated MAC notations, since both reach this from different places', () => {
    expect(defaultDeviceName('df:17:97:a1:f3:f8')).toBe('Shimmer_F3F8');
    expect(defaultDeviceName('DF-17-97-A1-F3-F8')).toBe('Shimmer_F3F8');
    expect(macShortId('df1797a1f3f8')).toBe('F3F8');
  });

  it('fits the 12 ASCII bytes the InfoMem name field holds', () => {
    // A longer name would be truncated on write, leaving the device stored
    // under a different name than the one it was given.
    const name = defaultDeviceName('DF1797A1F3F8');
    expect(name).not.toBeNull();
    expect(name!.length).toBe(12);
    expect(DEFAULT_TRIAL_NAME.length).toBeLessThanOrEqual(12);
  });

  it('returns null rather than a placeholder when the MAC is unusable', () => {
    // A name that looks like an identity but identifies nothing is worse than
    // leaving the existing one alone.
    expect(defaultDeviceName('')).toBeNull();
    expect(defaultDeviceName('12')).toBeNull();
    expect(macShortId('xyz')).toBeNull();
  });

  it('pairs the device name with the default experiment ID', () => {
    expect(defaultTrialIdentity('DF1797A1F3F8')).toEqual({
      deviceName: 'Shimmer_F3F8',
      trialName: 'DefaultTrial',
    });
  });
});

describe('read-only configuration', () => {
  it('locks Multi-Shimmer Sync while leaving it visible', () => {
    // Licensed Consensys feature: readable for support, not editable here.
    const sync = SHIMMER3_INFOMEM_FIELD_GROUPS.find((g) => g.id === 'sync');
    expect(sync).toBeTruthy();
    expect(sync!.readOnly).toBe(true);
    expect(sync!.readOnlyReason).toMatch(/Consensys/);
    // Still a group a host renders, and still holds its fields.
    expect(SHIMMER3_INFOMEM_FIELD_SCHEMA.some((f) => f.group === 'sync')).toBe(true);
  });

  it('locks the deprecated Single-Touch Start and TCXO options', () => {
    for (const key of ['singleTouch', 'tcxo']) {
      const field = SHIMMER3_INFOMEM_FIELD_SCHEMA.find((f) => f.key === key);
      expect(field, key).toBeTruthy();
      expect(field!.readOnly, key).toBe(true);
      expect(field!.readOnlyReason, key).toMatch(/Deprecated/i);
    }
  });

  it('leaves every other field editable', () => {
    // A guard against a read-only flag spreading by copy-paste: only the two
    // deprecated options carry one at field level.
    const locked = SHIMMER3_INFOMEM_FIELD_SCHEMA.filter((f) => f.readOnly).map((f) => f.key);
    expect(locked.sort()).toEqual(['singleTouch', 'tcxo']);
  });

  it('gives every read-only flag a reason to show the user', () => {
    for (const f of SHIMMER3_INFOMEM_FIELD_SCHEMA) {
      if (f.readOnly) expect(f.readOnlyReason, f.key).toBeTruthy();
    }
    for (const g of SHIMMER3_INFOMEM_FIELD_GROUPS) {
      if (g.readOnly) expect(g.readOnlyReason, g.id).toBeTruthy();
    }
  });
});
