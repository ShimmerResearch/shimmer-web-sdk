import { describe, it, expect } from 'vitest';
import {
  parseSdSessionName,
  parseSdTrialFolderName,
  SdLogFormatError,
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
