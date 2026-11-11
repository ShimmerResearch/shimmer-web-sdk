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
  // A kind with two files per data file under one root, told apart by extension.
  const pair: SdCompanionKind = {
    root: 'other',
    label: 'other file',
    extensions: ['.ONE', '.TWO'],
  };

  it('lists the event file as the first kind, with no extension', () => {
    expect(SD_COMPANION_KINDS[0]).toEqual({ root: 'events', label: 'event file', extensions: [] });
    expect(Object.isFrozen(SD_COMPANION_KINDS)).toBe(true);
    expect(Object.isFrozen(SD_COMPANION_KINDS[0].extensions)).toBe(true);
  });

  it('lists the audio files as the second kind, a WAV and a fingerprint per data file (DEV-99)', () => {
    const audio = SD_COMPANION_KINDS[1];
    expect(audio).toEqual({ root: 'audio', label: 'audio file', extensions: ['.WAV', '.AFP'] });
    expect(Object.isFrozen(audio.extensions)).toBe(true);
    expect(sdCompanionPathFor('data/T_1/S-000/001', audio, '.WAV')).toBe('audio/T_1/S-000/001.WAV');
    expect(sdCompanionPathFor('data/T_1/S-000/001', audio, '.afp')).toBe('audio/T_1/S-000/001.AFP');
    expect(sdCompanionPathFor('data/T_1/S-000', audio)).toBe('audio/T_1/S-000');
    expect(sdDataPathForCompanion('audio/T_1/S-000/001.WAV')).toBe('data/T_1/S-000/001');
    expect(sdDataPathForCompanion('AUDIO/T_1/S-000/001.afp')).toBe('data/T_1/S-000/001');
    expect(sdCompanionKindOf('audio/T_1/S-000/001.AFP')).toBe(audio);
    expect(sdCompanionKindOf('audiox/T_1')).toBeNull();
  });

  it('maps a data folder or file to its companion, and the data root to the companion root', () => {
    expect(sdCompanionPathFor('data/Trial_5f2c1a90/Shimmer_8091-000', events)).toBe(
      'events/Trial_5f2c1a90/Shimmer_8091-000',
    );
    expect(sdCompanionPathFor('data/T_1/S-000/001', events)).toBe('events/T_1/S-000/001');
    expect(sdCompanionPathFor('data', events)).toBe('events');
    expect(sdCompanionPathFor('/DATA/T_1/S-000', events)).toBe('events/T_1/S-000');
  });

  it('adds an extension the kind has, spelt as the kind spells it, and refuses one it has not', () => {
    expect(sdCompanionPathFor('data/T_1/S-000/001', pair, '.TWO')).toBe('other/T_1/S-000/001.TWO');
    expect(sdCompanionPathFor('data/T_1/S-000/001', pair, '.one')).toBe('other/T_1/S-000/001.ONE');
    expect(sdCompanionPathFor('data/T_1/S-000', pair)).toBe('other/T_1/S-000');
    expect(sdCompanionPathFor('data/T_1/S-000/001', pair, '.CSV')).toBeNull();
    expect(sdCompanionPathFor('data/T_1/S-000/001', events, '.ONE')).toBeNull();
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

  it("drops any of a kind's extensions on the way back, and only those", () => {
    const kinds = [events, pair];
    expect(sdDataPathForCompanion('other/T_1/S-000/001.TWO', kinds)).toBe('data/T_1/S-000/001');
    expect(sdDataPathForCompanion('other/T_1/S-000/001.one', kinds)).toBe('data/T_1/S-000/001');
    expect(sdDataPathForCompanion('other/T_1/S-000', kinds)).toBe('data/T_1/S-000');
    expect(sdDataPathForCompanion('other/T_1/S-000/001.CSV', kinds)).toBe('data/T_1/S-000/001.CSV');
    expect(sdCompanionKindOf('other/T_1', kinds)).toBe(pair);
    expect(sdCompanionKindOf('other/T_1')).toBeNull();
  });
});
