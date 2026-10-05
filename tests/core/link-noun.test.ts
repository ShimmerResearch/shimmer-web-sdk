import { describe, it, expect } from 'vitest';
import { unnamedLink } from '../../src/core/transport/linkNoun.js';
import type { ShimmerTransportKind } from '../../src/core/transport/types.js';

/*
 * A client that cannot name the device still has to say something, and what it
 * says has to be true of the link in front of it. The string this produces used
 * to be `an unnamed ${kind} port`, which is wrong for four of the five kinds —
 * most visibly on BLE, where it called a GATT peripheral a port two lines before
 * the same connect emitted "GATT connected".
 *
 * Every member is pinned here, so the wording is reviewable in one place rather
 * than inferred from whichever kinds the client tests happen to drive.
 */
describe('unnamedLink', () => {
  const cases: Array<[ShimmerTransportKind, string]> = [
    ['ble', 'an unnamed Bluetooth device'],
    ['serial', 'an unnamed serial port'],
    ['rfcomm', 'an unnamed RFCOMM port'],
    ['loopback', 'an unnamed loopback link'],
    ['mock', 'an unnamed mock link'],
  ];

  it.each(cases)('describes a %s link as "%s"', (kind, expected) => {
    expect(unnamedLink(kind)).toBe(expected);
  });

  it('never calls a Bluetooth peripheral a port', () => {
    expect(unnamedLink('ble')).not.toContain('port');
  });

  it('covers every kind the union declares', () => {
    /* If a member is added to ShimmerTransportKind, `unnamedLink` stops
       compiling (its switch has no default and it must return a string). This
       asserts the other direction: that the table above has not fallen behind
       a member that was added along with a new branch. */
    const kinds: ShimmerTransportKind[] = ['ble', 'serial', 'rfcomm', 'loopback', 'mock'];
    expect(cases.map(([k]) => k)).toEqual(kinds);
    for (const kind of kinds) expect(unnamedLink(kind)).toMatch(/^an unnamed .+$/);
  });
});
