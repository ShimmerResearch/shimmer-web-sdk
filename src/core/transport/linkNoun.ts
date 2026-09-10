import type { ShimmerTransportKind } from './types.js';

/**
 * How to describe a link that supplied no device name, in the reader's own terms.
 *
 * A client that cannot name the device still has to say something, and what it
 * says has to be true of the link in front of it. `an unnamed ${kind} port` is
 * not: a GATT peripheral is not a port, and neither is a loopback. Printing it
 * anyway is the same defect as announcing "GATT connected" on an RFCOMM link —
 * a log that misreports the mechanism costs more than one with less detail.
 *
 * Deliberately a `switch` with no `default`: the repo compiles under `strict`,
 * so a new {@link ShimmerTransportKind} member leaves a path that returns
 * `undefined` and fails to compile here. That is the point — the alternative is
 * a template literal, which accepts any new member silently and starts printing
 * nonsense.
 *
 * Not re-exported from `./index.js`, and so not part of the public API: the
 * wording is a client-side presentation detail, not a contract.
 */
export function unnamedLink(kind: ShimmerTransportKind): string {
  switch (kind) {
    case 'ble':
      return 'an unnamed Bluetooth device';
    case 'serial':
      return 'an unnamed serial port';
    case 'rfcomm':
      return 'an unnamed RFCOMM port';
    case 'loopback':
    case 'mock':
      return `an unnamed ${kind} link`;
  }
}
