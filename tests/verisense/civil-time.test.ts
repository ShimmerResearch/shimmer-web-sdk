import { describe, it, expect } from 'vitest';
import {
  utcToLocalCivilMillis,
  localCivilUnixSecondsNow,
  formatVerisenseUnixAndHuman,
} from '../../src/devices/verisense/protocolUtils.js';

// The Verisense RWC time-sync contract: the device clock holds the base
// station's LOCAL civil time (unix + local tz offset), not UTC. See DEV-900.

describe('utcToLocalCivilMillis', () => {
  it('applies the timezone offset in effect at the given instant', () => {
    const utc = Date.UTC(2026, 6, 18, 23, 54, 23); // 2026-07-18 23:54:23 UTC
    const expectedOffsetMin = -new Date(utc).getTimezoneOffset();
    expect(utcToLocalCivilMillis(utc) - utc).toBe(expectedOffsetMin * 60_000);
  });

  it('round-trips hour-of-day to the host wall clock', () => {
    // Whatever the host timezone, the civil value rendered via the UTC
    // accessors must equal the wall-clock reading of the same instant.
    const utc = Date.UTC(2026, 0, 15, 12, 0, 0);
    const civil = new Date(utcToLocalCivilMillis(utc));
    const wall = new Date(utc);
    expect(civil.getUTCHours()).toBe(wall.getHours());
    expect(civil.getUTCMinutes()).toBe(wall.getMinutes());
    expect(civil.getUTCDate()).toBe(wall.getDate());
  });

  it('is a no-op only when the host offset is zero', () => {
    const utc = Date.UTC(2026, 6, 1);
    const offsetMin = new Date(utc).getTimezoneOffset();
    if (offsetMin === 0) {
      expect(utcToLocalCivilMillis(utc)).toBe(utc);
    } else {
      expect(utcToLocalCivilMillis(utc)).not.toBe(utc);
    }
  });
});

describe('localCivilUnixSecondsNow', () => {
  it('matches utcToLocalCivilMillis(now) to within a couple of seconds', () => {
    const secs = localCivilUnixSecondsNow();
    const expected = Math.floor(utcToLocalCivilMillis(Date.now()) / 1000);
    expect(Math.abs(secs - expected)).toBeLessThanOrEqual(2);
  });
});

describe('formatVerisenseUnixAndHuman (civil-domain rendering)', () => {
  it('renders the raw value verbatim (UTC accessors), not host-local shifted', () => {
    // 2026-07-18 23:54:23 in the civil domain must display as 23:54:23
    // regardless of the machine timezone running this test.
    const civilUnix = Date.UTC(2026, 6, 18, 23, 54, 23) / 1000;
    expect(formatVerisenseUnixAndHuman(civilUnix).human).toBe('2026-07-18 23:54:23');
  });

  it('keeps the invalid/epoch/implausible guards', () => {
    expect(formatVerisenseUnixAndHuman(NaN).human).toBe('invalid');
    expect(formatVerisenseUnixAndHuman(0).human).toBe('1970-01-01 00:00:00 (epoch)');
    expect(formatVerisenseUnixAndHuman(5e9).human).toBe('not-valid');
  });
});
