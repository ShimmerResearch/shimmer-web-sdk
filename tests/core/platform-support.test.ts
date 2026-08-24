import { describe, it, expect } from 'vitest';
import {
  describePlatformSupport,
  transportAvailability,
  transportAdvice,
  type NavigatorLike,
} from '../../src/core/platformSupport.js';
import {
  SHIMMER3_SPP_SERIAL_OPTIONS,
  SHIMMER3_SPP_UUID,
} from '../../src/devices/shimmer3/constants.js';

/* Real user-agent strings. The point of injecting a NavigatorLike is that these
 * can be asserted without a browser — the reason this logic belongs in the SDK
 * rather than copy-pasted into each demo page, where it was untestable. */
const UA = {
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Mobile Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadModern:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  ipadLegacy:
    'Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 CriOS/126.0 Mobile/15E148 Safari/604.1',
};

/** Desktop Chrome: both APIs, no touch. */
const desktop = (): NavigatorLike => ({
  userAgent: UA.windowsChrome,
  maxTouchPoints: 0,
  serial: {},
  bluetooth: {},
});
/** Android Chrome 138+: both APIs present, but serial serves RFCOMM only. */
const android = (): NavigatorLike => ({
  userAgent: UA.androidChrome,
  maxTouchPoints: 5,
  serial: {},
  bluetooth: {},
});
/** iOS Safari: neither API. */
const iosSafari = (): NavigatorLike => ({ userAgent: UA.iphoneSafari, maxTouchPoints: 5 });
/** Bluefy / WebBLE on iOS: BLE only, via a bundled stack. */
const iosBluefy = (): NavigatorLike => ({
  userAgent: UA.iphoneSafari,
  maxTouchPoints: 5,
  bluetooth: {},
});

describe('describePlatformSupport', () => {
  it('reads capabilities off navigator, not the user-agent', () => {
    const s = describePlatformSupport(desktop());
    expect(s.webSerial).toBe(true);
    expect(s.webBluetooth).toBe(true);
    expect(s.serialBluetoothOnly).toBe(false);
  });

  it('reports nothing available with no navigator at all (Node, React Native)', () => {
    const s = describePlatformSupport({});
    expect(s.webSerial).toBe(false);
    expect(s.webBluetooth).toBe(false);
    // Must not throw, and must not claim a platform it cannot identify.
    expect(s.isAndroid).toBe(false);
    expect(s.isIOS).toBe(false);
  });

  it.each([
    ['iPhone Safari', UA.iphoneSafari, 5, true],
    ['iPad on iPadOS 13+ (reports itself as Macintosh)', UA.ipadModern, 5, true],
    ['iPad legacy UA', UA.ipadLegacy, 5, true],
    ['Chrome on iOS (CriOS)', UA.chromeIos, 5, true],
    ['macOS desktop Safari', UA.macSafari, 0, false],
    ['macOS desktop Chrome', UA.macChrome, 0, false],
    ['Windows touch laptop', UA.windowsChrome, 10, false],
    ['Android Chrome', UA.androidChrome, 5, false],
  ])('isIOS for %s', (_name, userAgent, maxTouchPoints, expected) => {
    expect(describePlatformSupport({ userAgent, maxTouchPoints }).isIOS).toBe(expected);
  });

  it('distinguishes an iPad from a Mac only by touch points', () => {
    // Same UA string, opposite verdicts - the whole reason maxTouchPoints is read.
    expect(describePlatformSupport({ userAgent: UA.ipadModern, maxTouchPoints: 5 }).isIOS).toBe(
      true,
    );
    expect(describePlatformSupport({ userAgent: UA.ipadModern, maxTouchPoints: 0 }).isIOS).toBe(
      false,
    );
  });

  it('flags Android Web Serial as Bluetooth-only', () => {
    expect(describePlatformSupport(android()).serialBluetoothOnly).toBe(true);
    expect(describePlatformSupport(desktop()).serialBluetoothOnly).toBe(false);
  });

  it('does not flag Bluetooth-only when Web Serial is absent entirely', () => {
    // No serial API means there is no restriction to describe, only an absence.
    const s = describePlatformSupport({ userAgent: UA.androidChrome, bluetooth: {} });
    expect(s.isAndroid).toBe(true);
    expect(s.serialBluetoothOnly).toBe(false);
  });

  it('prefers userAgentData.platform over the UA string for Android', () => {
    const s = describePlatformSupport({
      userAgentData: { platform: 'Android' },
      userAgent: 'anything at all',
      serial: {},
    });
    expect(s.isAndroid).toBe(true);
  });
});

describe('transportAvailability', () => {
  it('offers everything on desktop', () => {
    const s = describePlatformSupport(desktop());
    expect(transportAvailability(s, 'ble')).toBe('available');
    expect(transportAvailability(s, 'classicBluetooth')).toBe('available');
    expect(transportAvailability(s, 'wiredSerial')).toBe('available');
  });

  it('is the crux on Android: classic BT works, wired is only unlikely', () => {
    const s = describePlatformSupport(android());
    expect(transportAvailability(s, 'ble')).toBe('available');
    expect(transportAvailability(s, 'classicBluetooth')).toBe('available');
    // NOT 'unavailable' - a hard disable would lock out devices that do gain
    // wired support, and feature detection cannot tell them apart.
    expect(transportAvailability(s, 'wiredSerial')).toBe('unlikely');
  });

  it('offers nothing on iOS Safari', () => {
    const s = describePlatformSupport(iosSafari());
    expect(transportAvailability(s, 'ble')).toBe('unavailable');
    expect(transportAvailability(s, 'classicBluetooth')).toBe('unavailable');
    expect(transportAvailability(s, 'wiredSerial')).toBe('unavailable');
  });

  it('offers BLE only inside Bluefy/WebBLE', () => {
    const s = describePlatformSupport(iosBluefy());
    expect(transportAvailability(s, 'ble')).toBe('available');
    expect(transportAvailability(s, 'classicBluetooth')).toBe('unavailable');
  });
});

describe('transportAdvice', () => {
  it('says nothing when a link simply works', () => {
    const s = describePlatformSupport(desktop());
    expect(transportAdvice(s, 'ble')).toBeNull();
    expect(transportAdvice(s, 'classicBluetooth')).toBeNull();
    expect(transportAdvice(s, 'wiredSerial')).toBeNull();
  });

  it('tells Android users to pair first, since the picker is empty until they do', () => {
    const msg = transportAdvice(describePlatformSupport(android()), 'classicBluetooth');
    expect(msg).toMatch(/Android Settings/);
    // Must not send a phone user to a desktop - the bug this module exists to fix.
    expect(msg).not.toMatch(/desktop/i);
  });

  it('warns rather than forbids for a wired dock on Android', () => {
    const msg = transportAdvice(describePlatformSupport(android()), 'wiredSerial');
    expect(msg).toMatch(/most likely find nothing/);
  });

  it('never suggests a desktop browser to an iOS user', () => {
    const s = describePlatformSupport(iosSafari());
    for (const need of ['ble', 'classicBluetooth', 'wiredSerial'] as const) {
      expect(transportAdvice(s, need)).not.toMatch(/desktop/i);
    }
  });

  it('recommends Bluefy on iOS Safari but not to someone already in Bluefy', () => {
    const safari = transportAdvice(describePlatformSupport(iosSafari()), 'classicBluetooth');
    expect(safari).toMatch(/Bluefy/);

    const bluefy = transportAdvice(describePlatformSupport(iosBluefy()), 'classicBluetooth');
    // Telling a Bluefy user to install Bluefy is the wrong advice; point at BLE.
    expect(bluefy).not.toMatch(/Bluefy/);
    expect(bluefy).toMatch(/BLE/);
  });

  it('explains that iOS classic Bluetooth is impossible, not merely missing', () => {
    const msg = transportAdvice(describePlatformSupport(iosSafari()), 'classicBluetooth');
    expect(msg).toMatch(/MFi/);
  });

  it('mentions Android as a valid option when Web Serial is absent on desktop', () => {
    // A browser without Web Serial (e.g. desktop Firefox before 151).
    const s = describePlatformSupport({ userAgent: UA.windowsChrome, maxTouchPoints: 0 });
    expect(transportAdvice(s, 'classicBluetooth')).toMatch(/Android/);
  });
});

describe('SHIMMER3_SPP_SERIAL_OPTIONS', () => {
  it('carries BOTH Bluetooth fields - the permission and the filter', () => {
    // allowedBluetoothServiceClassIds only permits Bluetooth ports to appear;
    // filters is what narrows the picker. With the permission alone the picker
    // lists every serial port and paired device, which is unusable.
    expect(SHIMMER3_SPP_SERIAL_OPTIONS.allowedBluetoothServiceClassIds).toEqual([
      SHIMMER3_SPP_UUID,
    ]);
    expect(SHIMMER3_SPP_SERIAL_OPTIONS.filters).toEqual([
      { bluetoothServiceClassId: SHIMMER3_SPP_UUID },
    ]);
    expect(SHIMMER3_SPP_SERIAL_OPTIONS.kind).toBe('rfcomm');
  });

  it('is frozen, so a call site cannot mutate the shared default', () => {
    expect(Object.isFrozen(SHIMMER3_SPP_SERIAL_OPTIONS)).toBe(true);
  });

  it('spreads cleanly with extra per-call-site options', () => {
    const opts = { ...SHIMMER3_SPP_SERIAL_OPTIONS, bufferSize: 64 * 1024 };
    expect(opts.bufferSize).toBe(65536);
    expect(opts.kind).toBe('rfcomm');
    expect(opts.filters).toEqual([{ bluetoothServiceClassId: SHIMMER3_SPP_UUID }]);
  });
});
