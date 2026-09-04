# @shimmerresearch/shimmer-web-sdk

Web Bluetooth and Web Serial SDK for Shimmer sensor devices.

## Supported Devices

| Device                             | Class                | Radio / port                 | Links this SDK can drive                                       |
| ---------------------------------- | -------------------- | ---------------------------- | -------------------------------------------------------------- |
| Shimmer3R                          | `Shimmer3RClient`    | nRF52 (BLE) + RN4678 + USB-C | BLE, classic Bluetooth (SPP)                                   |
| Shimmer3, RN4678 (SR31-6-0 onward) | `Shimmer3Client`     | RN4678 (dual-mode)           | classic Bluetooth (SPP); BLE possible in principle — see below |
| Shimmer3, RN42 (earlier boards)    | `Shimmer3Client`     | RN42 (classic only)          | classic Bluetooth (SPP)                                        |
| Shimmer3R over USB-C               | `WiredShimmerClient` | USB-C CDC                    | wired serial (dock protocol, not LiteProtocol)                 |
| Shimmer3/3R in a BasicDock or Base | `WiredShimmerClient` | Dock FTDI UART               | wired serial (injected transport only)                         |
| SmartDock multi-slot base          | `SmartDockClient`    | Dock FTDI UART               | wired serial                                                   |
| Verisense (IMU, Pulse+)            | `VerisenseBleDevice` | nRF52 (BLE) + USB            | BLE, wired serial                                              |

**Which radio a Shimmer3 has matters.** Boards up to expansion-board revision 5
carry an **RN42**, which is classic Bluetooth (BR/EDR) only — there is no BLE
radio on them at all, so no browser can reach one except through a paired SPP
port. Revision 6 and later carry an **RN4678**, which is dual-mode: the
LogAndStream firmware picks the radio from two EEPROM bits at start-up
(`ShimBt_startCommon`, log-and-stream-common `Comms/shimmer_bt_uart.c`), and a
unit with no EEPROM at all is forced to classic Bluetooth precisely because
that is the RN42 fleet.

BLE on an RN4678 is real but **slow** — the module carries the LiteProtocol
over its transparent-UART service, and throughput is a small fraction of what
SPP or a Shimmer3R's native nRF52 BLE gives, which is why classic Bluetooth
stayed the streaming link for the Shimmer3. This SDK has **no built-in BLE
transport for a Shimmer3**: `Shimmer3Client` requires an injected transport
whichever radio is in play, so an RN4678 BLE link is a matter of writing a
transport over the module's transparent-UART characteristics and handing it in.
HARDWARE-VERIFY: nothing here has been run against an RN4678 in BLE mode.

## Link Types

The same physical link looks different from a browser's point of view, and the
device table above collapses that. Spelled out — this is the distinction the
table used to blur:

| Link                    | Browser API    | Transport                                            | Notes                                                                                                                                       |
| ----------------------- | -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| BLE                     | Web Bluetooth  | `WebBluetoothTransport` (built by `connect()`)       | Shimmer3R and Verisense. Nordic UART service; notification boundaries preserved.                                                            |
| classic Bluetooth (SPP) | Web **Serial** | `WebSerialTransport` + `SHIMMER3_SPP_SERIAL_OPTIONS` | Shimmer3 **and** Shimmer3R, identically: pairing exposes the sensor as a virtual COM port and Web Serial opens it. Byte stream, no framing. |
| wired USB / dock        | Web Serial     | `WebSerialTransport` (no Bluetooth options)          | A different protocol — `$`-header dock packets, not LiteProtocol. No streaming.                                                             |

Two consequences worth stating, because both have caused confusion:

- **Classic Bluetooth is Web Serial, on every device.** A Shimmer3R's classic
  link is opened exactly the way a Shimmer3's is: same API, same transport,
  same `SHIMMER3_SPP_SERIAL_OPTIONS`, same requirement that the host has
  already paired the sensor. What differs between the two devices is only which
  _other_ links they also have.
- **"Web Serial" on a Shimmer3R means one of two unrelated things.** Over a
  paired Bluetooth port it is the LiteProtocol and `Shimmer3RClient`; over the
  USB-C cable it is the dock protocol and `WiredShimmerClient`. Same API, same
  picker, different client and different command set.

## Browser Support

Everything here rests on two Chromium-only APIs, and both need a **secure
context** — HTTPS, or `localhost` for development.

| Browser                                 | Web Bluetooth (BLE)                               | Web Serial (classic BT, dock) | Directory picker (SD download) |
| --------------------------------------- | ------------------------------------------------- | ----------------------------- | ------------------------------ |
| Chrome / Edge, desktop                  | yes                                               | yes (89+)                     | yes                            |
| Chrome, Android                         | yes                                               | 138+, **RFCOMM only**         | no (`showSaveFilePicker` only) |
| Opera / Brave / other Chromium, desktop | usually — Brave keeps Web Bluetooth behind a flag | usually                       | usually                        |
| Firefox, any platform                   | no                                                | no                            | no                             |
| Safari, macOS                           | no                                                | no                            | no                             |
| Any browser on iOS / iPadOS             | no — all WebKit                                   | no                            | no                             |
| Bluefy / WebBLE (iOS)                   | yes — bundles its own BLE stack                   | no                            | no                             |

Do not re-derive this table in a page. `describePlatformSupport()` reports the
two capabilities as booleans that are safe to gate a control on,
`transportAvailability()` turns them into a three-state answer per link, and
`transportAdvice()` returns the sentence to show the user. The Android row in
particular is **not** detectable by feature test, which is the whole reason
that module exists.

## OS Support

Per link, since that is where the differences actually fall:

| Host                  | BLE                  | classic Bluetooth (SPP)                                     | Wired USB / dock                             |
| --------------------- | -------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| Windows 10 / 11       | yes                  | yes — pair, then the sensor is a `COMx` port                | yes                                          |
| macOS                 | yes                  | yes — pair, then `/dev/cu.*-SPPDev`                         | yes                                          |
| Linux                 | yes, with BlueZ      | yes — pair and bind an `rfcomm` node                        | yes                                          |
| Android (Chrome 138+) | yes                  | yes, once paired — **see the LE-bond trap below**           | unlikely — wired serial is still rolling out |
| ChromeOS              | yes                  | yes, once paired                                            | yes                                          |
| iOS / iPadOS          | Bluefy / WebBLE only | **impossible** — no third-party classic access at any layer | no                                           |

Three of those cells need more than a word:

- **Android, classic Bluetooth.** The picker lists paired devices by their
  cached classic service records, so a sensor has to be paired in system
  settings first. A dual-mode sensor advertising both radios invites Android to
  create an **LE** bond instead, which satisfies the user while leaving no
  BR/EDR link key and therefore no SPP record — the sensor is then simply
  absent from the picker. Confirmed on hardware with
  `dumpsys bluetooth_manager`. The fix: disable the sensor's BLE radio, unpair,
  pair again, then re-enable BLE. The classic bond survives, so it is once per
  phone, not once per session. `transportAdvice()` returns this as prose.
- **Android, wired.** `navigator.serial` is present and callable, but Chrome
  implements it there for Bluetooth RFCOMM port emulation only, so a dock will
  not appear in the picker. No feature test separates the two cases, which is
  why `transportAvailability()` answers `'unlikely'` rather than
  `'unavailable'` — the control stays enabled so devices that do gain wired
  support are not locked out.
- **iOS, classic Bluetooth.** Not "not yet": Core Bluetooth is BLE-only and
  classic profiles such as SPP need MFi licensing, so no browser release can
  change it. A classic-only Shimmer3 — the whole RN42 fleet — cannot be reached
  from iOS by any route.

SD-card download additionally needs `showDirectoryPicker`, which is
Chromium-desktop only, so the SD browser is unavailable on Android even where
the link itself works perfectly well.

## Quick Start

### Shimmer3R

```html
<script type="module">
  import { Shimmer3RClient, SensorBitmapShimmer3 } from './dist/shimmer-web-sdk.esm.js';

  const client = new Shimmer3RClient({ timestampFmt: 'u24', debug: true });

  client.onStatus = (msg) => console.log('[status]', msg);
  client.onStreamFrame = (oc) => {
    const gz = oc.get('GYRO_Z', 'raw')?.value;
    console.log('GYRO_Z =', gz);
  };

  document.getElementById('btnConnect').addEventListener('click', async () => {
    await client.connect();
    await client.setSamplingRate(51.2);
    await client.setSensors(SensorBitmapShimmer3.SENSOR_GYRO | SensorBitmapShimmer3.SENSOR_A_ACCEL);
    await client.startStreaming();
  });
</script>
```

### Verisense

```html
<script type="module">
  import { VerisenseBleDevice } from './dist/shimmer-web-sdk.esm.js';

  const v = new VerisenseBleDevice({ hardwareIdentifier: 'VERISENSE_PULSE_PLUS' });
  v.on('streamPacket', (pkt) => console.log(pkt.sensorId, pkt.decoded));

  document.getElementById('btnConnect').addEventListener('click', async () => {
    await v.connect();
    await v.startStreaming();
  });
</script>
```

## Pluggable Transports

The device clients are transport-agnostic. Each client talks to its device through
a `ShimmerTransport` — a raw byte pipe (`connect` / `disconnect` / `write` /
`onNotify` / `onDisconnect`) that does no protocol interpretation and preserves
notification chunk boundaries. In a browser nothing changes: `Shimmer3RClient`
builds a `WebBluetoothTransport` and `VerisenseBleDevice` builds a
`WebBluetoothTransport` (or a `WebSerialTransport` via `connectSerial()`)
automatically when you call `connect()`.

To run the clients elsewhere (React Native / `react-native-ble-plx`, Bluetooth
Classic) or in tests, inject your own transport:

```ts
import { Shimmer3RClient, LoopbackTransport } from '@shimmerresearch/shimmer-web-sdk';

// Constructor option …
const client = new Shimmer3RClient({ transport: myTransport });
// … or connect() parameter:
await client.connect(myTransport);
```

Implement `ShimmerTransport` for a new platform: map `write` to the write
characteristic, deliver each inbound notification verbatim to the `onNotify`
callback (never merge or re-split chunks), and fire `onDisconnect` on link loss.
`LoopbackTransport` is an in-memory implementation used by the test suites.

### Classic Bluetooth (`Shimmer3Client`, and `Shimmer3RClient` too)

The classic (pre-3R) Shimmer3 speaks the same LiteProtocol but over an **RFCOMM/SPP
byte stream** rather than BLE. Web Bluetooth cannot open an RFCOMM socket, so
`Shimmer3Client` _requires_ an injected transport and `connect()` throws without
one — but a browser can still reach the device. Pairing a Shimmer over classic
Bluetooth makes the OS expose it as a **virtual COM port** (Windows `COMx`,
macOS `/dev/cu.*-SPPDev`), and Web Serial can open that port, so
`WebSerialTransport` is a working SPP transport.

Everything in this section applies to a **Shimmer3R's classic link as well**:
its RN4678 is reached the same way, with the same options, and the client is
then `Shimmer3RClient` over the same `WebSerialTransport` rather than over Web
Bluetooth. The one difference is that `Shimmer3RClient` can also build its own
BLE transport, so unlike `Shimmer3Client` it does not _require_ one to be
injected.

```ts
import {
  Shimmer3Client,
  WebSerialTransport,
  SHIMMER3_SPP_UUID,
} from '@shimmerresearch/shimmer-web-sdk';

const client = new Shimmer3Client({
  transport: new WebSerialTransport({
    // BOTH are needed, and they do different jobs:
    //   allowedBluetoothServiceClassIds *permits* Bluetooth ports to be
    //     surfaced at all — Chrome hides them otherwise;
    //   filters *narrows* the picker to that service class.
    // With the permission alone the picker lists every COM port and every
    // paired Bluetooth device.
    filters: [{ bluetoothServiceClassId: SHIMMER3_SPP_UUID }],
    allowedBluetoothServiceClassIds: [SHIMMER3_SPP_UUID],
    kind: 'rfcomm',
  }),
});
await client.connect();
```

The sensor must already be paired with the host (the page cannot do that), and
`open()` is what brings the RFCOMM link up — so it blocks, and eventually fails,
when the sensor is asleep or out of range. `WebSerialTransport` bounds that with
`openTimeoutMs` (15 s by default).

On a non-browser platform, anything that can open SPP (e.g. a React Native
Android module calling `createRfcommSocketToServiceRecord` with
`SHIMMER3_SPP_UUID`) works equally well. Either way the transport should report
`capabilities.framed = false`, since RFCOMM has no message boundaries.

```ts
import { Shimmer3Client, SensorBitmapShimmer3 } from '@shimmerresearch/shimmer-web-sdk';

const client = new Shimmer3Client({ transport: rfcommTransport }); // required
client.onStatus = (m) => console.log(m);

await client.connect(); // handshake: flush buffer → HW version → FW version
await client.setSamplingRate(51.2);
await client.setSensors(SensorBitmapShimmer3.SENSOR_GYRO);
await client.setGSRRange(2);
await client.startStreaming();
```

Unlike the BLE clients, `Shimmer3Client` runs a **byte-stream parser**: inbound
bytes are accumulated and complete LiteProtocol messages are extracted with a
length-aware framer, so ACKs and responses are recovered correctly no matter how
the RFCOMM stream splits or coalesces them.

### Wired / dock UART (`WiredShimmerClient`)

> **Verification status: code-complete, pending hardware.** The protocol is
> ported byte-for-byte from the Java driver and covered by unit tests with
> hand-derived fixtures (the CRC is cross-checked against the Java `ShimmerCrc`
> run directly), but it has **not yet been exercised against a physical dock**.
> See _Hardware-verify items_ below.

A Shimmer sitting in a **BasicDock / Base** is reachable over the dock's FTDI
**UART** (host↔device). This is a completely different protocol from the
Bluetooth LiteProtocol above — `$`-header packets addressed by _component_ +
_property_, with a length byte, payload and a Shimmer-specific CRC (seed
`0xB0CA`). `WiredShimmerClient` is phase **D1** of dock support: **identify,
status, and property-level config** for a single docked device. It does **not**
cover mass-storage/SD, firmware flashing, or the multi-slot Base state machine
(later phases), and the dock protocol has no streaming.

Transport injection is **required** (a docked Shimmer is only reachable over the
wired link, so there is no browser default and `connect()` throws without one).
Supply a serial `ShimmerTransport` reporting `capabilities.framed = false`;
configure the port at `UART_DOCK_BAUD_RATE` (115200, 8N1, no flow control).

```ts
import { WiredShimmerClient, UART_PROP } from '@shimmerresearch/shimmer-web-sdk';

const client = new WiredShimmerClient({ transport: dockSerialTransport }); // required
client.onStatus = (m) => console.log(m);

await client.connect();
const id = await client.identify(); // { mac, hardwareVersion, firmwareVersion, expansionBoard }
const status = await client.getStatus(); // { voltage, percentage, chargingStatus, adcValue }

// Property-level config (READ / WRITE a single component+property):
const range = await client.getConfig(UART_PROP.GSR.RANGE);
await client.setConfig(UART_PROP.GSR.RANGE, new Uint8Array([2]));

// Low-level InfoMem escape hatch (raw bytes; layout not interpreted in D1):
const infomem = await client.readInfoMem(0, 128);
```

Like `Shimmer3Client`, the dock link is an **unframed byte stream**, so the
client accumulates inbound bytes and extracts complete packets with a
length-aware parser (`wiredPacketLength`), robust to packets split, dribbled or
coalesced arbitrarily. A packet whose CRC fails triggers a single-byte resync,
and device error responses (`BAD_CMD` / `BAD_ARG` / `BAD_CRC`) reject with their
reason.

**Config surface.** The wired protocol exposes discrete config commands via the
Java `mListOfUartCommandsConfig` list (surfaced as `UART_CONFIG_COMMANDS`,
same order). These are **GQ-oriented** enable/rate/range/divider properties; for
a Shimmer3/3R the app's real configuration model (enabled sensors, sampling
rate, sensor ranges) lives in **InfoMem**, not in these per-property commands.
D1 therefore exposes both: the property-level `getConfig`/`setConfig`/
`getConfigAll` for the discrete commands the firmware implements, and a raw
`readInfoMem`/`writeInfoMem` escape hatch for the InfoMem-backed config — but it
does **not** port the InfoMem layout (that maps InfoMem bytes ↔ the app config
model and is a later phase).

**Hardware-verify items** (need a real dock to confirm):

- **Init/timing.** The 500 ms per-request response timeout (Java
  `SERIAL_PORT_TIMEOUT`) and the 2× MAC-read retry are ported as-is; real dock
  latency may warrant tuning. Whether the FTDI port needs DTR/RTS asserted or a
  settle delay after open is transport-level and not yet exercised.
- **VER payload width.** The parser accepts both the 7-byte (1-byte HW version)
  and 8-byte (2-byte HW version) layouts; which a given docked firmware returns
  needs confirming on hardware.
- **Battery semantics.** Voltage (ADC → V via the shared U12 calibration ×1.988
  divider) and the 4th-order charge-% polynomial are ported exactly, but the
  charging-status byte values (`0xC0`/`0x40`/`0x80`/`0x00`/`0xFF`) and the
  percentage curve should be sanity-checked against a docked device across
  charge states.
- **Expansion-board / MAC byte order.** MAC is emitted in device byte order
  (first 6 payload bytes, no reversal, per the Java); the daughter-card ID is
  read as `[boardId, boardRev, specialRev]`. Confirm against known hardware.

### SmartDock multi-slot base (`SmartDockClient`)

> **Verification status: code-complete, pending hardware.** The SmartDock base
> protocol is ported from the Java driver (`SmartDockUart` /
> `SmartDockUartListener`) and covered by unit tests driving a scripted
> multi-slot base over `LoopbackTransport`, but it has **not yet been exercised
> against a physical Base-6 / Base-15.** See _Hardware-verify items_ below.

Phase **D2** adds **SmartDock** multi-slot bases (Base-6 = 6 slots, Base-15 = 15
slots) on top of D1. A SmartDock has **two** channels over (two) FTDI serial
ports:

1. a **base control** channel speaking short **ASCII** `SDx$` commands
   (`\r\n`-terminated replies) — read version, query occupancy, switch the
   _active_ slot; and
2. a **per-Shimmer** UART channel onto which the base routes the active slot,
   spoken with the D1 binary `$`-header protocol.

Multi-slot support is therefore _select a slot on the base channel, then talk to
the docked Shimmer on the per-Shimmer channel_. `SmartDockClient` **composes**
(does not duplicate) `WiredShimmerClient` for the per-Shimmer half. **Scope is
READ-ONLY**: dock info, occupancy, slot select, per-slot identify/status. No
config writes, no SD/mass-storage (the `SDC` with-SD-access connect exists in the
oracle but is not driven), no bootloader/flashing.

```ts
import { SmartDockClient } from '@shimmerresearch/shimmer-web-sdk';

// baseSerial and shimmerSerial are two distinct serial ShimmerTransports
// (capabilities.framed = false), one per FTDI port the base exposes.
const dock = new SmartDockClient({ transport: baseSerial, shimmerTransport: shimmerSerial });
await dock.connect();

const info = await dock.getDockInfo(); // { hardwareType: 'base15', firmwareVersion, slotCount: 15 }
const slots = await dock.getSlotOccupancy(); // [{ slot: 1, occupied: true }, { slot: 2, occupied: false }, ...]

// Select a slot then reuse the D1 per-Shimmer protocol against it:
const id = await dock.identifyDockedShimmer(1); // { mac, hardwareVersion, firmwareVersion, expansionBoard }
const st = await dock.getDockedShimmerStatus(1); // { voltage, percentage, chargingStatus, adcValue }
```

Slot selection issues `SDP,NN$`, awaits the `P,NN` confirmation with the ported
**~10 s** slot-change timeout (`SMARTDOCK_RESPONSE_TIMEOUT_SLOT_CHANGE`), verifies
the returned slot matches, then waits the ported **1500 ms** without-SD settle
delay (`SLOT_CHANGEOVER_DELAY_WITHOUT_SD_CARD`) before the per-Shimmer UART is
usable. Normal base-command reads use the ported **1000 ms** timeout
(`SMARTDOCK_RESPONSE_TIMEOUT`). Like D1, the base UART is an unframed byte
stream, so the client accumulates bytes and extracts `\r\n`-terminated lines,
ignoring unrelated / partial lines (resync); an `E` line rejects with an error.

**Hardware-verify items** (need a real Base-6 / Base-15 to confirm):

- **Slot-change timing.** The 10 s slot-change timeout and 1500 ms without-SD
  settle delay are ported as-is; real base latency (especially how long the
  per-Shimmer UART takes to become usable after routing) needs measuring.
- **Occupancy semantics.** Occupancy is decoded from the `SDQ$` → `Q,<bitmap>`
  reply (one ASCII `0`/`1` per slot, index 0 → slot 1). The auto-notify `S,<map>`
  push and the **prototype-board slot remap** (`remapSlotsSmartDockToUi`, only
  BASE15U firmware ≤ 1.0.0.5) are deliberately **not** implemented — confirm no
  production base needs the remap.
- **Base6-vs-15 detection.** `getDockInfo` derives family + slot count from the
  version reply's hardware-version field (`BASE_HARDWARE_IDS`: 1 → base15, 2 →
  base6). In the Java driver the slot count actually comes from the **USB device
  descriptor**, not the version byte — verify the version byte alone is
  sufficient, or fall back to the occupancy-bitmap length.
- **Two-port assumption.** Real hardware presents the base control UART and the
  per-Shimmer UART as two separate serial ports (`SmartDock.java:226-229`);
  confirm the port enumeration / which is which on the target platform.

## Factory Self-Test (Shimmer3 / Shimmer3R)

`runFactoryTest` asks the sensor to run the suite its firmware runs on the
production line, and returns the report it prints. It is available on
`Shimmer3RClient` (BLE and classic Bluetooth) and on `WiredShimmerClient`
(dock UART, and a Shimmer3R's USB-C port).

```js
import {
  SHIMMER3_FACTORY_TEST_TYPE,
  SHIMMER3_FACTORY_TEST_TYPES,
  parseShimmerFactoryTestReport,
} from '@shimmerresearch/shimmer-web-sdk';

// SHIMMER3_FACTORY_TEST_TYPES describes all four suites — label, expected
// duration, default timeout, and whether that suite prints a verdict at all.
const report = await client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, {
  onLine: (line) => console.log(line), // shown as it prints, not at the end
});

const parsed = parseShimmerFactoryTestReport(report);
console.log(parsed.overall.result, parsed.overall.failedTestNames);
```

Three things make this command unlike the others in this SDK, and a host has
to be built for them:

- **The report is raw text on the same link.** The firmware acknowledges the
  command and then prints, with no opcode, no length and no CRC. The client
  diverts those bytes ahead of its framer for the duration; nothing else needs
  to know.
- **Nothing else may be sent meanwhile.** The firmware's main loop is blocked
  for the whole suite — up to about seventy seconds for the LED-state
  walk-through — so every other command rejects with a `FactoryTestError` whose
  `reason` is `busy` until the run ends.
- **There is no abort command.** `opts.signal` stops the client listening; the
  sensor keeps printing to its own end. The run therefore enters a `draining`
  state, and the link is only free once `whenFactoryTestIdle()` resolves:

```js
const ctl = new AbortController();
const run = client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.LED_STATES, {
  signal: ctl.signal,
});
ctl.abort();
await run.catch(() => {}); // rejects at once…
await client.whenFactoryTestIdle(); // …but the sensor is still printing
```

`factoryTestState` and `onFactoryTestStateChange` report `idle` / `running` /
`draining`, which is what a user interface needs to keep its own gating honest.
The firmware refuses the command outright while the sensor is streaming or
recording (`reason: 'nack'`).

`parseShimmerFactoryTestReport` reads both families: Shimmer3R reports carry
`S3R_TEST_00NN` ids, Shimmer3 reports carry none at all and are named from
their line content. `parseVerisenseFactoryTestReport` shares the same core and
returns the same shape.

### Red LED

`toggleLed()` flips the firmware's red-LED override — the "which sensor is
this one" aid, which holds the lower LED solid red above the sensor's own
indications. The firmware never clears the flag, so it survives a disconnect
until it is toggled again or the sensor loses power. Because the command is a
toggle with no "set", `setRedLed(on)` reads status bit 7 either side of it,
writes nothing when the LED is already as asked, and throws rather than
reporting success if the sensor's flag does not follow. Bluetooth only: the
dock protocol has no LED command.

## Building

```bash
npm install
npm run build    # produces dist/shimmer-web-sdk.esm.js, .umd.js, .d.ts
```

### Build Helper Script (for consumer repos)

Consumer repos can call this SDK-owned helper to keep build logic centralized:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-local-sdk.ps1
```

First run only (installs dependencies):

```powershell
powershell -ExecutionPolicy Bypass -File .\build-local-sdk.ps1 -InstallDeps
```

Build from a specific tag version (for example `v0.1.7`) without switching your current checkout:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-local-sdk.ps1 -Version 0.1.7
```

Build from the latest `v*` tag:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-local-sdk.ps1 -Latest
```

## Testing

```bash
npm test         # Vitest — runs without a browser
```

## Publishing to GitHub Packages

This package is configured for GitHub Packages (`@shimmerresearch` scope).  
Release, tag, and package publishing are automated by `.github/workflows/cut-release.yml`.

To cut a new release using npm-standard versioning:

1. Run `.github/workflows/cut-release.yml`.
2. Choose `major`, `minor`, or `patch`.
3. The workflow bumps `package.json`/`package-lock.json`, publishes to GitHub Packages, pushes the `vX.Y.Z` tag, and creates a GitHub Release.

## Automatic Formatting

Formatting is automated on each push by `.github/workflows/format-on-commit.yml` using Prettier.

- Run locally: `npm run format`
- Check formatting only: `npm run format:check`

## Package Layout

```
src/
  index.ts                     ← barrel: re-exports all public API
  core/
    types.ts                   ← shared interfaces (IShimmerClient, SensorField…)
    ObjectCluster.ts            ← sensor data frame container
    BaseShimmerClient.ts        ← abstract base class
    transport/                  ← pluggable byte-pipe layer
      types.ts                  ← ShimmerTransport interface + capabilities
      WebBluetoothTransport.ts  ← Web Bluetooth GATT transport (default web)
      WebSerialTransport.ts     ← Web Serial (USB) transport
      LoopbackTransport.ts      ← in-memory transport for tests
  devices/
    shimmer3r/
      Shimmer3RClient.ts        ← main BLE client class
      constants.ts              ← opcodes, UUIDs, defaults
      channelFormats.ts         ← channel ID → format map
      SensorBitmap.ts           ← sensor enable bitmasks
      calibration.ts            ← GSR / ExG / ADC calibration math
      protocol.ts               ← byte-level helpers (u16le, sign24…)
    verisense/
      VerisenseClient.ts        ← main BLE + Serial client class
      constants.ts              ← NUS UUIDs, opcodes, OP_IDX offsets
      protocol.ts               ← CRC-16, packet framing, config helpers
      sensors/
        SensorBase.ts           ← timestamp unwrap + extrapolation
        SensorADC.ts            ← ADC/GSR + battery decoder (id=1)
        SensorLIS2DW12.ts       ← LIS2DW12 accelerometer (id=2)
        SensorLSM6DS3.ts        ← LSM6DS3 gyro+accel (id=3)
        SensorPPG.ts            ← PPG decoder (id=4)

tests/
  shimmer3r/
    calibration.test.ts
    protocol.test.ts
  verisense/
    crc.test.ts
    sensors.test.ts
```

## License

BSD-3-Clause (see `LICENSE`).
