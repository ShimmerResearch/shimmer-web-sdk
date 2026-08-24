/**
 * Which link types this browser can actually reach, and what to tell the user
 * when it cannot.
 *
 * Every consumer of this SDK was hand-writing the same advice — "Web Serial not
 * supported, use Chrome/Edge on desktop" — in its own words, in six places
 * across three repos. All six were wrong in the same way once Chrome shipped Web
 * Serial on Android, so the knowledge lives here once instead.
 *
 * The split this module insists on:
 *
 * - **Gate on capability.** `webSerial` / `webBluetooth` are `in navigator`
 *   checks. A missing API is a fact.
 * - **Message on platform.** `isAndroid` / `isIOS` come from the user-agent, and
 *   are used only to choose which words to show. A UA string is a guess, and
 *   guesses must never decide what a user is allowed to click.
 *
 * The awkward case that shaped the API is Android. Chrome 138+ implements Web
 * Serial there, but deliberately only for Bluetooth RFCOMM port emulation —
 * wired ports are a separate feature still rolling out. So `'serial' in
 * navigator` is `true` while the dock is unreachable, and no amount of feature
 * detection can tell the two apart. That is why {@link transportAvailability}
 * returns three states rather than a boolean: `'unlikely'` is the honest answer
 * for a wired port on Android, and it maps to "leave the button enabled and warn"
 * rather than "disable", so devices that do gain wired support are not locked out.
 *
 * iOS is the opposite shape — a harder "no" than an unimplemented API. Every iOS
 * browser is WebKit, which ships neither API, and iOS exposes no
 * classic-Bluetooth serial access to third-party apps at any layer: Core
 * Bluetooth is BLE-only, and classic profiles such as SPP require MFi licensing.
 * So classic Bluetooth there is impossible rather than merely absent, and no
 * future browser release changes that. BLE via a browser that bundles its own
 * stack (Bluefy, WebBLE) is the ceiling.
 */

/**
 * The parts of `navigator` this module reads. Injectable so the logic is
 * testable without a browser — the reason this belongs in the SDK rather than
 * being copy-pasted into pages, where it could never be unit-tested.
 */
export interface NavigatorLike {
  userAgent?: string;
  userAgentData?: { platform?: string };
  maxTouchPoints?: number;
  serial?: unknown;
  bluetooth?: unknown;
}

/** A link the caller wants to offer, independent of how it is implemented. */
export type TransportNeed = 'ble' | 'classicBluetooth' | 'wiredSerial';

/**
 * How likely a {@link TransportNeed} is to work here.
 *
 * - `available` — the API is present and unrestricted for this need.
 * - `unlikely` — the API is present but probably cannot serve this need. Keep the
 *   control enabled and warn; a hard disable would lock out the devices where it
 *   does work.
 * - `unavailable` — the API is absent. Disable the control.
 */
export type Availability = 'available' | 'unlikely' | 'unavailable';

export interface PlatformSupport {
  /** `'serial' in navigator`. Capability, safe to gate on. */
  readonly webSerial: boolean;
  /** `'bluetooth' in navigator`. Capability, safe to gate on. */
  readonly webBluetooth: boolean;
  /** UA hint. Advice only — never gate on this. */
  readonly isAndroid: boolean;
  /** UA hint. Advice only — never gate on this. */
  readonly isIOS: boolean;
  /**
   * Web Serial is present but expected to expose Bluetooth RFCOMM ports only,
   * so a wired dock will not appear in the picker. True on Android.
   */
  readonly serialBluetoothOnly: boolean;
}

function readNavigator(nav?: NavigatorLike): NavigatorLike {
  if (nav) return nav;
  const g = globalThis as { navigator?: NavigatorLike };
  return g.navigator ?? {};
}

/**
 * Snapshot what this browser can reach. Call once and pass the result around;
 * nothing here changes during a page's lifetime.
 *
 * Safe outside a browser — with no `navigator` every capability reads `false`,
 * so a Node or React Native caller gets "nothing available" rather than a throw.
 */
export function describePlatformSupport(nav?: NavigatorLike): PlatformSupport {
  const n = readNavigator(nav);
  const ua = n.userAgent ?? '';
  const isAndroid = /Android/i.test(n.userAgentData?.platform || ua);
  /*
   * iPadOS 13+ reports itself as "Macintosh" to look like a desktop, so the UA
   * alone cannot separate an iPad from a Mac — the touch-point count is what
   * does. Requiring more than one point keeps desktop macOS out, including a Mac
   * with a stray touch-capable peripheral.
   */
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Mac/.test(ua) && (n.maxTouchPoints ?? 0) > 1);
  const webSerial = 'serial' in n && n.serial !== undefined;
  return {
    webSerial,
    webBluetooth: 'bluetooth' in n && n.bluetooth !== undefined,
    isAndroid,
    isIOS,
    serialBluetoothOnly: webSerial && isAndroid,
  };
}

/**
 * Whether to offer `need` here — see {@link Availability} for how to map the
 * three states onto a control's enabled state.
 */
export function transportAvailability(support: PlatformSupport, need: TransportNeed): Availability {
  if (need === 'ble') return support.webBluetooth ? 'available' : 'unavailable';
  if (!support.webSerial) return 'unavailable';
  /*
   * Both remaining needs ride Web Serial, and on Android it serves only one of
   * them: a paired sensor's RFCOMM port is exactly what it exposes, while a
   * wired dock is the feature that has not arrived.
   */
  if (need === 'wiredSerial' && support.serialBluetoothOnly) return 'unlikely';
  return 'available';
}

/**
 * What to tell the user about `need` on this platform, or `null` when there is
 * nothing worth saying (the API is present and unrestricted).
 *
 * Returning `null` on the happy path is deliberate: it lets a caller write
 * `const msg = transportAdvice(...); if (msg) log(msg);` without first working
 * out whether this platform is interesting.
 */
export function transportAdvice(support: PlatformSupport, need: TransportNeed): string | null {
  const availability = transportAvailability(support, need);

  if (need === 'ble') {
    if (availability === 'available') return null;
    return support.isIOS
      ? 'Web Bluetooth is not available on iOS — every iOS browser uses WebKit, which does not implement it. Bluefy or WebBLE (App Store) bundle their own BLE stack and can run this page.'
      : 'Web Bluetooth is not available in this browser. Use Chrome or Edge — desktop or Android — over HTTPS or on localhost.';
  }

  if (availability === 'unavailable') {
    if (support.isIOS) {
      /*
       * On iOS the only route is BLE, so the advice depends on whether this
       * browser has it. If Web Bluetooth is present we are inside Bluefy or
       * WebBLE already, and recommending them would be telling the user to
       * install what they are using.
       */
      const route = support.webBluetooth
        ? 'Connect over BLE instead.'
        : 'Bluefy or WebBLE (App Store) bundle their own BLE stack and can run this page.';
      return need === 'classicBluetooth'
        ? `Classic Bluetooth cannot be reached from iOS at all: iOS gives apps no classic-Bluetooth serial access (Core Bluetooth is BLE-only, and SPP requires MFi licensing). ${route}`
        : `Web Serial is not available on iOS — WebKit does not implement it, so a wired dock cannot be opened. ${route}`;
    }
    return need === 'classicBluetooth'
      ? 'Web Serial is not available in this browser, so classic Bluetooth cannot be used. Use Chrome or Edge on desktop, or Chrome 138+ on Android, over HTTPS or on localhost.'
      : 'Web Serial is not available in this browser, so the USB/dock connection cannot be used. Use Chrome or Edge on desktop, over HTTPS or on localhost.';
  }

  if (availability === 'unlikely') {
    /* Only reachable for a wired port on Android — see serialBluetoothOnly. */
    return 'Android Chrome exposes Web Serial for paired Bluetooth devices only, so a wired USB/dock connection will most likely find nothing (wired serial support is still rolling out). Pair the sensor over classic Bluetooth instead.';
  }

  /*
   * Classic Bluetooth works here, but on Android the picker is empty until the
   * sensor is paired in system settings — which reads as a bug unless said up
   * front. Worth a note even though nothing is wrong.
   */
  if (need === 'classicBluetooth' && support.isAndroid) {
    return 'Pair the sensor in Android Settings → Bluetooth first: Android Chrome exposes Web Serial for paired Bluetooth devices only, so the picker stays empty until it is paired.';
  }
  return null;
}
