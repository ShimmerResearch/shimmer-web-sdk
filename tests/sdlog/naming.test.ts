import { describe, it, expect } from 'vitest';
import {
  parseSdSessionName,
  parseSdTrialFolderName,
  SdLogFormatError,
  SD_COMPANION_KINDS,
  sdCompanionKindOf,
  sdCompanionPathFor,
  sdDataPathForCompanion,
  type SdCompanionKind,
} from '../../src/devices/sdlog/index.js';

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SdLogFormatError);
    expect((e as SdLogFormatError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected SdLogFormatError(${code})`);
};

describe('parseSdSessionName', () => {
  it('splits on the LAST dash', () => {
    expect(parseSdSessionName('Shimmer_A2BB-001')).toEqual({
      shimmerName: 'Shimmer_A2BB',
      sessionNumber: 1,
    });
  });

  it('keeps dashes inside the Shimmer name', () => {
    expect(parseSdSessionName('My-Shimmer-3R-012')).toEqual({
      shimmerName: 'My-Shimmer-3R',
      sessionNumber: 12,
    });
  });

  it('rejects names without a dash, a leading dash or a non-numeric number', () => {
    expectCode(() => parseSdSessionName('NoDashHere'), 'BAD_HEADER');
    expectCode(() => parseSdSessionName('-001'), 'BAD_HEADER');
    expectCode(() => parseSdSessionName('Shimmer-'), 'BAD_HEADER');
    expectCode(() => parseSdSessionName('Shimmer-abc'), 'BAD_HEADER');
  });
});

describe('parseSdTrialFolderName', () => {
  it('splits on the LAST underscore', () => {
    expect(parseSdTrialFolderName('MyTrial_1721224800')).toEqual({
      trialName: 'MyTrial',
      configTime: '1721224800',
    });
  });

  it('keeps underscores inside the trial name', () => {
    expect(parseSdTrialFolderName('gait_lab_run_2_1721224800')).toEqual({
      trialName: 'gait_lab_run_2',
      configTime: '1721224800',
    });
  });

  it('rejects names without an underscore or with empty parts', () => {
    expectCode(() => parseSdTrialFolderName('NoUnderscore'), 'BAD_HEADER');
    expectCode(() => parseSdTrialFolderName('_1721224800'), 'BAD_HEADER');
    expectCode(() => parseSdTrialFolderName('Trial_'), 'BAD_HEADER');
  });
});

describe('companion files', () => {
  const events = SD_COMPANION_KINDS.find((k) => k.root === 'events') as SdCompanionKind;
  const withExt: SdCompanionKind = { root: 'other', label: 'other file', extension: '.EXT' };

  it('lists the event file as the first kind, with no extension', () => {
    expect(SD_COMPANION_KINDS[0]).toEqual({ root: 'events', label: 'event file', extension: '' });
    expect(Object.isFrozen(SD_COMPANION_KINDS)).toBe(true);
  });

  it('maps a data folder or file to its companion, and the data root to the companion root', () => {
    expect(sdCompanionPathFor('data/Trial_5f2c1a90/Shimmer_8091-000', events)).toBe(
      'events/Trial_5f2c1a90/Shimmer_8091-000',
    );
    expect(sdCompanionPathFor('data/T_1/S-000/001', events, { file: true })).toBe(
      'events/T_1/S-000/001',
    );
    expect(sdCompanionPathFor('data', events)).toBe('events');
    expect(sdCompanionPathFor('/DATA/T_1/S-000', events)).toBe('events/T_1/S-000');
  });

  it('adds an extension only to a file', () => {
    expect(sdCompanionPathFor('data/T_1/S-000/001', withExt, { file: true })).toBe(
      'other/T_1/S-000/001.EXT',
    );
    expect(sdCompanionPathFor('data/T_1/S-000', withExt)).toBe('other/T_1/S-000');
  });

  it('refuses anything not under data/', () => {
    expect(sdCompanionPathFor('database/T_1', events)).toBeNull();
    expect(sdCompanionPathFor('events/T_1', events)).toBeNull();
    expect(sdCompanionPathFor('sdlog.cfg', events)).toBeNull();
  });

  it('maps a companion back to its data path, and names its kind', () => {
    expect(sdDataPathForCompanion('events/T_1/S-000/001')).toBe('data/T_1/S-000/001');
    expect(sdDataPathForCompanion('Events/T_1/S-002')).toBe('data/T_1/S-002');
    expect(sdDataPathForCompanion('events')).toBe('data');
    expect(sdCompanionKindOf('events/T_1/S-000/001')).toBe(events);
    expect(sdCompanionKindOf('data/T_1/S-000/001')).toBeNull();
    expect(sdCompanionKindOf('eventsx/T_1')).toBeNull();
    expect(sdDataPathForCompanion('data/T_1/S-000/001')).toBeNull();
  });
});
