import { describe, it, expect } from 'vitest';
import {
  classifyPpgLedTestFailure,
  isVerisensePpgLedTestError,
  resolveHardwarePpgSupport,
  VerisensePpgLedTestError,
} from '../../src/devices/verisense/ppgLedTest.js';

/**
 * The exact string `validatePendingResponse` builds for a refusal — the only
 * thing the classifier has to work with, because the firmware's debug dispatch
 * NACKs an unknown command, a board with no PPG and a wedged PPG bus through
 * the same `sendNackGeneric()` call (DEV-973 / DEV-1021).
 */
const NACK_GENERIC_DEBUG = new Error('Device returned NACK command=0x70 property=0x9');
const TIMEOUT = new Error('Request timeout');

describe('classifyPpgLedTestFailure', () => {
  it('reads a NACK on known-PPG hardware as a PPG comms failure', () => {
    const err = classifyPpgLedTestFailure(NACK_GENERIC_DEBUG, { hardwarePpgSupport: true });

    expect(err).toBeInstanceOf(VerisensePpgLedTestError);
    expect(err.reason).toBe('ppg-comms');
    expect(err.hardwarePpgSupport).toBe(true);
    expect(err.cause).toBe(NACK_GENERIC_DEBUG);
  });

  it('warns the operator not to scrap the board as a dead-LED fault', () => {
    const err = classifyPpgLedTestFailure(NACK_GENERIC_DEBUG, { hardwarePpgSupport: true });

    // The whole point of DEV-1021: the reason must separate "comms failure"
    // from "operator says the LEDs are not lit".
    expect(err.operatorMessage).toMatch(/PPG comms failure/i);
    expect(err.operatorMessage).toMatch(/not\s+.*scrap|do not scrap/i);
    // No hardware caveat when the revision is known.
    expect(err.operatorMessage).not.toMatch(/hardware revision unknown/i);
  });

  it('reads a NACK on hardware with no PPG front end as not-supported', () => {
    const err = classifyPpgLedTestFailure(NACK_GENERIC_DEBUG, { hardwarePpgSupport: false });

    expect(err.reason).toBe('not-supported');
    expect(err.operatorMessage).toMatch(/no PPG front end/i);
    expect(err.operatorMessage).toMatch(/not a unit fault/i);
  });

  it('fails loud when the hardware revision is unknown, but flags the ambiguity', () => {
    const err = classifyPpgLedTestFailure(NACK_GENERIC_DEBUG, { hardwarePpgSupport: null });

    expect(err.reason).toBe('ppg-comms');
    expect(err.hardwarePpgSupport).toBeNull();
    expect(err.operatorMessage).toMatch(/hardware revision unknown/i);
  });

  it.each([
    ['0x50', new Error('Device returned NACK command=0x50 property=0x9')],
    ['0x60', new Error('Device returned NACK command=0x60 property=0x9')],
    ['0x70', NACK_GENERIC_DEBUG],
  ])('recognises NACK opcode %s on the debug property', (_opcode, raised) => {
    expect(classifyPpgLedTestFailure(raised, { hardwarePpgSupport: true }).reason).toBe(
      'ppg-comms',
    );
  });

  it('does not treat a NACK on another property as a PPG verdict', () => {
    const err = classifyPpgLedTestFailure(
      new Error('Device returned NACK command=0x70 property=0x4'),
      { hardwarePpgSupport: true },
    );

    expect(err.reason).toBe('unknown');
  });

  it('separates a link timeout from a PPG verdict', () => {
    const err = classifyPpgLedTestFailure(TIMEOUT, { hardwarePpgSupport: true });

    expect(err.reason).toBe('no-response');
    expect(err.operatorMessage).toMatch(/not a verdict on the PPG LEDs/i);
  });

  it('classifies anything else as unknown, preserving the message', () => {
    const err = classifyPpgLedTestFailure(new Error('GATT operation failed'), {
      hardwarePpgSupport: true,
    });

    expect(err.reason).toBe('unknown');
    expect(err.operatorMessage).toMatch(/GATT operation failed/);
  });

  it('handles a non-Error rejection', () => {
    const err = classifyPpgLedTestFailure('something broke', { hardwarePpgSupport: null });

    expect(err.reason).toBe('unknown');
    expect(err.operatorMessage).toMatch(/something broke/);
  });

  it('is identifiable through the exported type guard', () => {
    expect(
      isVerisensePpgLedTestError(
        classifyPpgLedTestFailure(NACK_GENERIC_DEBUG, { hardwarePpgSupport: true }),
      ),
    ).toBe(true);
    expect(isVerisensePpgLedTestError(new Error('plain'))).toBe(false);
  });
});

describe('resolveHardwarePpgSupport', () => {
  it('reports PPG hardware from the production-config revision', () => {
    // SR68 Pulse+ and SR62 GSR+ both carry a MAX86xxx.
    expect(resolveHardwarePpgSupport({ revHwMajor: 68, revHwMinor: 9 })).toBe(true);
    expect(resolveHardwarePpgSupport({ revHwMajor: 62, revHwMinor: 1 })).toBe(true);
  });

  it('reports no PPG on IMU hardware', () => {
    expect(resolveHardwarePpgSupport({ revHwMajor: 61, revHwMinor: 5 })).toBe(false);
    expect(resolveHardwarePpgSupport({ revHwMajor: 61, revHwMinor: 1 })).toBe(false);
  });

  it('returns null rather than guessing when the revision is unusable', () => {
    expect(resolveHardwarePpgSupport(null)).toBeNull();
    expect(resolveHardwarePpgSupport(undefined)).toBeNull();
    expect(resolveHardwarePpgSupport({})).toBeNull();
    // An erased production config reads back as 0xFF.
    expect(resolveHardwarePpgSupport({ revHwMajor: 0xff, revHwMinor: 0xff })).toBeNull();
    expect(resolveHardwarePpgSupport({ revHwMajor: 0, revHwMinor: 0 })).toBeNull();
  });

  it('assumes PPG on unknown development hardware, so a NACK still fails loud', () => {
    // getVerisenseHardwareSensorSupport reports every block present for SR64
    // and any unrecognised major, so a wedged bus is not written off as
    // "this board has no PPG".
    expect(resolveHardwarePpgSupport({ revHwMajor: 64, revHwMinor: 1 })).toBe(true);
  });
});
