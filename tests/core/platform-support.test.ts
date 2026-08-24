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

/**
 * Run `fn` with `globalThis.navigator` replaced (or removed, when `value` is
 * undefined), then restore exactly what was there.
 *
 * Assignment is not enough: in this environment `globalThis.navigator` is a
 * getter-only property, so `globalThis.navigator = x` throws
 * "Cannot set property navigator of #<Object> which has only a getter". An
 * earlier version restored by assignment and only passed because a preceding
 * test had already deleted the getter - the suite was order-dependent and each
 * of these tests failed when run alone. Save the descriptor, define over it,
 * put it back.
 */
function withGlobalNavigator<T>(value: unknown | undefined, fn: () => T): T {
  const g = globalThis as { navigator?: unknown };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    if (value === undefined) delete g.navigator;
    else Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
    return fn();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete g.navigator;
  }
}

describe('describePlatformSupport', () => {
  it('reads capabilities off navigator, not the user-agent', () => {
    const s = describePlatformSupport(desktop());
    expect(s.webSerial).toBe(true);
    expect(s.webBluetooth).toBe(true);
    expect(s.serialBluetoothOnly).toBe(false);
  });

  it('reports nothing available for an empty navigator', () => {
    const s = describePlatformSupport({});
    expect(s.webSerial).toBe(false);
    expect(s.webBluetooth).toBe(false);
    // Must not claim a platform it cannot identify.
    expect(s.isAndroid).toBe(false);
    expect(s.isIOS).toBe(false);
  });

  it('survives no global navigator at all (Node, React Native)', () => {
    /* Passing {} does NOT cover this: readNavigator returns any supplied object
     * before it ever consults globalThis, so the no-global path needs the global
     * genuinely removed. */
    withGlobalNavigator(undefined, () => {
      const s = describePlatformSupport();
      expect(s.webSerial).toBe(false);
      expect(s.webBluetooth).toBe(false);
      expect(s.isAndroid).toBe(false);
      expect(s.isIOS).toBe(false);
      // And the advice path must still produce words rather than throwing.
      expect(transportAdvice(s, 'wiredSerial')).toBeTruthy();
    });
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

  it('never promises BLE as a substitute for classic Bluetooth on iOS', () => {
    /* A classic-only Shimmer3 (RN42 has no BLE radio) cannot be reached from iOS
     * by any route, so the advice must not send that user chasing BLE. */
    for (const nav of [iosSafari(), iosBluefy()]) {
      const msg = transportAdvice(describePlatformSupport(nav), 'classicBluetooth');
      expect(msg).toMatch(/A sensor that also supports BLE/);
      expect(msg).toMatch(/classic-Bluetooth-only sensor cannot be used from iOS/);
    }
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

  it('is frozen at every level, not just the outer object', () => {
    // Object.freeze is shallow: freezing only the wrapper would still let a JS
    // caller push into arrays that every other caller shares.
    expect(Object.isFrozen(SHIMMER3_SPP_SERIAL_OPTIONS)).toBe(true);
    expect(Object.isFrozen(SHIMMER3_SPP_SERIAL_OPTIONS.filters)).toBe(true);
    expect(Object.isFrozen(SHIMMER3_SPP_SERIAL_OPTIONS.filters[0])).toBe(true);
    expect(Object.isFrozen(SHIMMER3_SPP_SERIAL_OPTIONS.allowedBluetoothServiceClassIds)).toBe(true);
  });

  it('spreads cleanly with extra per-call-site options', () => {
    const opts = { ...SHIMMER3_SPP_SERIAL_OPTIONS, bufferSize: 64 * 1024 };
    expect(opts.bufferSize).toBe(65536);
    expect(opts.kind).toBe('rfcomm');
    expect(opts.filters).toEqual([{ bluetoothServiceClassId: SHIMMER3_SPP_UUID }]);
  });
});

/*
 * The advice a WebSerialTransport produces when Web Serial is missing depends on
 * how it was configured. Classifying that from the truthiness of the allow-list
 * alone is wrong in two directions, so it is pinned here: the message a user sees
 * on iOS differs in kind, not just wording, between a wired dock and classic
 * Bluetooth.
 */
describe('WebSerialTransport advice when Web Serial is absent', () => {
  const SPP = '00001101-0000-1000-8000-00805f9b34fb';
  const withoutSerial = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)',
    maxTouchPoints: 5,
  };

  async function messageFor(opts: Record<string, unknown>): Promise<string> {
    const { WebSerialTransport } = await import('../../src/core/transport/WebSerialTransport.js');
    return withGlobalNavigator(withoutSerial, async () => {
      const t = new WebSerialTransport(opts as never);
      try {
        await t.connect();
        throw new Error('expected connect() to reject');
      } catch (e) {
        return (e as Error).message;
      }
    });
  }

  it('calls it classic Bluetooth when a service class is allowed', async () => {
    const msg = await messageFor({ allowedBluetoothServiceClassIds: [SPP] });
    expect(msg).toMatch(/Classic Bluetooth cannot be reached from iOS/);
  });

  it('does NOT call an empty allow-list Bluetooth', async () => {
    // [] is truthy, so a truthiness test would misclassify this as Bluetooth.
    const msg = await messageFor({ allowedBluetoothServiceClassIds: [] });
    expect(msg).toMatch(/wired dock/);
  });

  it('recognises a Bluetooth filter even with no allow-list', async () => {
    // The half-configured case: filter set, permission missing.
    const msg = await messageFor({ filters: [{ bluetoothServiceClassId: SPP }] });
    expect(msg).toMatch(/Classic Bluetooth cannot be reached from iOS/);
  });

  it('calls a plain USB filter a wired port', async () => {
    const msg = await messageFor({ filters: [{ usbVendorId: 0x1915 }] });
    expect(msg).toMatch(/wired dock/);
  });
});

describe('advice never prescribes a link the device may not have', () => {
  /*
   * TransportNeed is device-agnostic, so no message may assume a fallback radio
   * exists. Two sensors make this concrete: a classic-only Shimmer3 (RN42, no
   * BLE) and a Verisense (wired USB serial + BLE, no RFCOMM at all). Advice that
   * prescribes rather than qualifies will be wrong for one of them.
   */
  it('does not tell an Android wired-serial caller to use classic Bluetooth', () => {
    const s = describePlatformSupport({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/138.0 Mobile',
      serial: {},
      bluetooth: {},
      maxTouchPoints: 5,
    });
    const msg = transportAdvice(s, 'wiredSerial');
    // Qualified, not prescribed - a Verisense has no RFCOMM to fall back to.
    expect(msg).toMatch(/A sensor that supports classic Bluetooth/);
    expect(msg).not.toMatch(/Pair the sensor over classic Bluetooth instead/);
  });

  it('qualifies every cross-link suggestion it makes', () => {
    const cases: Array<[NavigatorLike, 'ble' | 'classicBluetooth' | 'wiredSerial']> = [
      [
        { userAgent: UA.androidChrome, serial: {}, bluetooth: {}, maxTouchPoints: 5 },
        'wiredSerial',
      ],
      [{ userAgent: UA.iphoneSafari, maxTouchPoints: 5 }, 'classicBluetooth'],
      [{ userAgent: UA.iphoneSafari, maxTouchPoints: 5, bluetooth: {} }, 'classicBluetooth'],
      [{ userAgent: UA.iphoneSafari, maxTouchPoints: 5 }, 'wiredSerial'],
    ];
    for (const [nav, need] of cases) {
      const msg = transportAdvice(describePlatformSupport(nav), need);
      // "instead" alone is fine; an unqualified imperative is not.
      expect(msg).not.toMatch(/^(Pair|Connect|Use) the sensor over/);
    }
  });
});
