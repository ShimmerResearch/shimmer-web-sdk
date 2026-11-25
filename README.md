# @shimmerresearch/shimmer-web-sdk

Web Bluetooth and Web Serial SDK for Shimmer sensor devices.

## Supported Devices

| Device                             | Class                | Radio / port                 | Links this SDK can drive                                       |
| ---------------------------------- | -------------------- | ---------------------------- | -------------------------------------------------------------- |
| Shimmer3R                          | `Shimmer3RClient`    | CYW20820 (BLE + SPP) + USB-C | BLE, Classic Bluetooth (SPP)                                   |
| Shimmer3, RN4678 (SR31-6-0 onward) | `Shimmer3Client`     | RN4678 (dual-mode)           | Classic Bluetooth (SPP); BLE possible in principle — see below |
| Shimmer3, RN42 (earlier boards)    | `Shimmer3Client`     | RN42 (classic only)          | Classic Bluetooth (SPP)                                        |
| Shimmer3R over USB-C               | `WiredShimmerClient` | USB-C CDC                    | wired serial (dock protocol, not LiteProtocol)                 |
| Shimmer3/3R in a BasicDock or Base | `WiredShimmerClient` | Dock FTDI UART               | wired serial (injected transport only)                         |
| SmartDock multi-slot base          | `SmartDockClient`    | Dock FTDI UART               | wired serial                                                   |
| Verisense (IMU, Pulse+)            | `VerisenseBleDevice` | nRF52 (BLE) + USB            | BLE, wired serial                                              |

**Which radio a Shimmer3 has matters.** Early boards carry an **RN42**, which is
Classic Bluetooth (BR/EDR) only — there is no BLE radio on them at all, so no
browser can reach one except through a paired SPP port. Later boards carry an
**RN4678**, which is dual-mode.

Which of the two a given unit has is **not** a single revision cutoff. It tracks
the sensor generation, and the revision gates differ per board ID — SR31, SR38,
SR47, SR48 and SR49 each run their own major/minor scheme, and assembly variants
of one PCB are encoded as a higher minor revision, so a bare revision number
means nothing without its board ID. Check
[`SHIMMER3_BOARD_REVISIONS.md`](https://github.com/ShimmerResearch/log-and-stream-common/blob/main/docs/SHIMMER3_BOARD_REVISIONS.md)
rather than inferring capability from a model name or revision alone.

At runtime the LogAndStream firmware picks the radio from two EEPROM bits at
start-up (`ShimBt_startCommon`, log-and-stream-common `Comms/shimmer_bt_uart.c`),
and a unit with no EEPROM at all is forced to Classic Bluetooth precisely because
that is the RN42 fleet.

BLE on an RN4678 is real but **slow** — the module carries the LiteProtocol
over its transparent-UART service, and throughput is a small fraction of what
SPP or a Shimmer3R's CYW20820 BLE gives, which is why Classic Bluetooth
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
| Classic Bluetooth (SPP) | Web **Serial** | `WebSerialTransport` + `SHIMMER3_SPP_SERIAL_OPTIONS` | Shimmer3 **and** Shimmer3R, identically: pairing exposes the sensor as a virtual COM port and Web Serial opens it. Byte stream, no framing. |
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

| Browser                                 | Web Bluetooth (BLE)                               | Web Serial (Classic BT, dock) | Directory picker (SD download) |
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

| Host                  | BLE                  | Classic Bluetooth (SPP)                                     | Wired USB / dock                             |
| --------------------- | -------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| Windows 10 / 11       | yes                  | yes — pair, then the sensor is a `COMx` port                | yes                                          |
| macOS                 | yes                  | yes — pair, then `/dev/cu.*-SPPDev`                         | yes                                          |
| Linux                 | yes, with BlueZ      | yes — pair and bind an `rfcomm` node                        | yes                                          |
| Android (Chrome 138+) | yes                  | yes, once paired — **see the LE-bond trap below**           | unlikely — wired serial is still rolling out |
| ChromeOS              | yes                  | yes, once paired                                            | yes                                          |
| iOS / iPadOS          | Bluefy / WebBLE only | **impossible** — no third-party classic access at any layer | no                                           |

Three of those cells need more than a word:

- **Android, Classic Bluetooth.** The picker lists paired devices by their
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
- **iOS, Classic Bluetooth.** Not "not yet": Core Bluetooth is BLE-only and
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
    // Every channel carries a raw count and, where a conversion exists, a
    // calibrated value with its unit. Ask for the one you want.
    const gz = oc.get('GYRO_Z', 'cal'); // { value: 12.4, unit: 'deg/s' }
    const batt = oc.get('BATTERY', 'cal'); // { value: 3841.2, unit: 'mV' }
    const t = oc.get('Timestamp_Unix', 'cal')?.value; // epoch ms, once anchored
    const when = t == null ? '(unanchored)' : new Date(t).toISOString();
    console.log(when, gz?.value, gz?.unit, batt?.value);
  };

  document.getElementById('btnConnect').addEventListener('click', async () => {
    await client.connect();
    await client.getRtcTime(); // one reading pins the whole session to a wall clock
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

## Calibrated Streaming

Every channel a Shimmer3 or Shimmer3R streams reaches `onStreamFrame` twice: as
a raw converter count, and — where a conversion exists — as a calibrated value
carrying its unit. `oc.get(name, 'raw' | 'cal')` picks one; `oc.fields` walks
them all.

| Family                       | Unit                             | Notes                                                                                                                               |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Inertial (6 triples)         | `m/(s^2)`, `deg/s`, `local_flux` | Uses the device's own calibration once `applyCalibDump()` or `readCalibration()` has run; the range's factory seed otherwise        |
| Battery                      | `mV`                             | ADC millivolts × 2, the board's divider                                                                                             |
| External / internal ADC, PPG | `mV`                             | `raw × 3000 / 4095` — 12-bit at 3.0 V on **both** generations                                                                       |
| Bridge amplifier HIGH / LOW  | `mV`                             | Shimmer3 with an SR49 board                                                                                                         |
| ExG CH1 / CH2, both chips    | `mV`                             | From the chip's own reference and PGA gain; 16-bit mode is bits 22:7 of the 24-bit conversion, so its divisor carries a factor of 2 |
| ExG status                   | `no_units`                       | The lead-off register, relayed untouched                                                                                            |
| GSR                          | `uS`                             | Plus `GSR_RESISTANCE` in `kOhms` and `GSR_RANGE`, both calibrated-only                                                              |
| Pressure / temperature       | `kPa`, `Degrees Celsius`         | Needs `readPressureCalibration()` first; a BMP581 self-compensates and needs nothing                                                |
| `TIMESTAMP`                  | `ticks` raw, `ms` calibrated     | Unwrapped, not zeroed at stream start — the Java driver's convention                                                                |
| `Timestamp_Unix`             | `ms`                             | Epoch milliseconds, present once the timeline is anchored                                                                           |

Three rules worth knowing before reading the numbers:

- **A channel with no conversion gets no `'cal'` field at all**, rather than a
  copy of the raw count. A raw-only column is honest; one claiming a
  calibration it does not have is not.
- **Pressure and temperature are raw-only until the coefficients are fetched.**
  `readPressureCalibration()` returns `null` rather than throwing when the
  firmware predates the command, and says so through `onStatus`.
- **The device's inertial calibration is adopted explicitly.** `readCalibDump()`
  hands back a dump for inspection; `applyCalibDump(dump)` is what makes the
  stream use it. Which numbers are in force, per group and per range, is what
  `calibrationInfo` reports.
- **A Shimmer3 may still hold the pre-2025 default LN accel calibration.**
  Firmware before February 2025 wrote offset 2253 and sensitivity 92 as its
  own record, and that reads about 17 % high, because every Shimmer3 runs the
  KXTC9-2050 at 3.0 V. The SDK keeps using the record, so a host's output does
  not change under a user on an update. Instead it says so once per connection
  through `onStatus`, and marks the group `staleDefault` in `calibrationInfo`.
  The SD decoder does the same per session, in `header.warnings` and
  `header.calibration`. `isStaleKxtc9DefaultCalibration` is the rule, for a
  host that reads a record itself. Recalibrating in Consensys clears it.
- **The gyro offset can move while you stream.** With derived-sensor bit 29
  (`GYRO_ON_THE_FLY_CAL`) set, the SDK runs the Java driver's on-the-fly
  offset calibration, as Consensys does. Whenever the last round(fs) samples
  are still (every calibrated axis has a standard deviation under 1.2 deg/s),
  their raw mean becomes the gyro offset from the next sample on.
  `Shimmer3RClient` takes the bit from the configuration it reads or writes. On
  `Shimmer3Client` a host sets `gyroOnTheFlyCal` itself.
  `calibrationInfo.gyroOnTheFly` says whether it is enabled and whether an
  estimate is in force. The SD decoder does the same per file, from the header,
  and reports it on the gyro entry of `header.calibration`.

`client.timelineState` says how absolute time was fixed: `rwc-aligned` (exact,
Shimmer3R — its packet timestamp is the low 24 bits of the same counter
`GET_RWC` returns), `rwc-estimated` (Shimmer3, from the request round trip, with
the uncertainty stated), or `host` (no device clock; the Consensys method).

The same unwrap also has to tell a pair of packets delivered out of order from
a genuine roll-over, and the two look identical in the counter alone — a step
backwards. What separates them is size, so the timeline is told the sampling
rate at stream start and sizes its **reorder window** at eight sample periods.
A packet that late is placed where it was taken; anything further back is a
roll-over. `timelineState.reorderWindowTicks` reports the window in force. A
host driving `StreamTimeline` itself passes `samplingRateHz`, or calls
`setSamplingRateHz`, to get the same treatment; without a rate the window falls
back to an eighth of the counter's range, which catches reorders but misreads a
dropout of 1.75–2.0 s on the 16-bit counter as one.

`oc.timestampValid` says whether a frame's timestamp means anything. Firmware
stamps a packet when the sample tick starts it, so a counter field of exactly
`0x000000` is a record it published without stamping — LogAndStream
v1.00.x–1.01.003 could do that under SD write back-pressure. Read as a
roll-over, one such packet puts every later sample a clean 512 s late. The
timeline rejects it instead: the frame still arrives, with its real sensor
values and `timestampValid` false, and its `TIMESTAMP` fields repeat the
previous frame's. Drop those frames if you need a true time axis. A genuine wrap
onto zero is unaffected — its predecessor is at the top of the range — and the
16-bit counter older firmware uses, whose whole range is 2 s, keeps its existing
behaviour.

`devices/calibration/streamChannels.ts` is the single table behind all of it, so
the two platforms cannot drift apart on a formula, and
`devices/shimmer3/sensorRules.ts` answers the configuration-side question of
which sensors can be enabled together and which need the expansion rail.

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
the RFCOMM stream splits or coalesces them. That includes the status a Shimmer3
sends unasked when it is docked or undocked, or when the button starts or stops
a recording. That status is reported through `onDeviceStatus`, and
`getStatus()` and `getBattery()` request the status and battery readings on
demand.

#### A classic link left quiet answers late

A classic link that has carried nothing for a while answers its next command
late: about 1.8 s after 10-20 s of quiet, on a Shimmer3 and a Shimmer3R alike
(Windows; measured by `shimmer-host-core`). BLE does not slow down this way.
`Shimmer3RClient` follows the rule the Java driver and `shimmer-host-core` do:

- **A keep-alive.** Once a byte-stream link (any `WebSerialTransport`, or a
  transport with `capabilities.framed = false`) has been quiet for
  `idleKeepAliveMs`, 5 s by default, the client reads the device's status
  (GET_STATUS). Until it knows how long a status reply is, it reads the hardware
  and firmware versions instead, and caches them as `readDeviceVersion()` and
  `readFwVersion()` would. It sends nothing alongside another command, and a
  command issued while it is in flight waits for it. It pauses while streaming,
  while the sensor logs to its SD card, and during an SD transfer, the data-rate
  test, a factory test or a Bluetooth module update. It stops when the link
  ends. It writes nothing to `onStatus`, and reports a status on
  `onDeviceStatus` only when it differs from the last one the link reported.
  Set `idleKeepAliveMs: 0` (option or property) to turn it off.
- **A 2 s ACK wait.** On a byte-stream link every command waits at least
  `BYTE_STREAM_LINK.MIN_ACK_WAIT_MS` (2000 ms) for its ACK, whatever its own
  timeout. That covers a command sent while the keep-alive is off or paused.

`Shimmer3Client` has no keep-alive yet; its ACK wait is 2000 ms
(`SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS`).

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
- **Battery semantics.** Voltage (ADC → V via the shared U12 calibration, then
  the divider) and the 4th-order charge-% polynomial are ported exactly, but the
  charging-status byte values (`0xC0`/`0x40`/`0x80`/`0x00`/`0xFF`) and the
  percentage curve should be sanity-checked against a docked device across
  charge states. Note this path keeps Java's ×1.988 divider, where the streamed
  `BATTERY` channel uses the firmware's own ×2 — 0.6% apart. The charge-%
  polynomial was fitted against the 1.988 figure, so changing it here would move
  the reported percentage; the two are deliberately not unified until a docked
  device has been measured.
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
ignoring unrelated / partial lines (resync).

**A base can refuse commands at random, so a command is sent again.** On 24 Nov
2026 a Base6 answered most slot changes with an `E` within 20 ms, and left others
unanswered, through a power cycle; sent again every 2 s, each got through within
6 tries. Its firmware keeps only the last UART byte received, so a byte that
arrives while its main loop is busy is lost. The same base later refused one
select 8 times in a row. So each command is sent up to **15** times
(`SMARTDOCK_DEFAULTS.CMD_RETRY_ATTEMPTS`), **2 s** after each try that fails
(`CMD_RETRY_INTERVAL_MS`):

- A try fails on an `E`, on no answer in time, or, for a slot change, on an answer
  naming another slot (a slot, for `SDD$`). That answer may be a late one to an
  earlier command, so it is not taken.
- The answer asked for still counts if it arrives between tries, and the command
  is not sent again. Anything else between tries, an `E` included, is dropped.
- The call ends with one result: the answer, or the last try's failure. When the
  last try names another slot, `activeSlot` is the slot it named.
- Losing the link, or calling `disconnect()`, ends the command at once, and every
  call queued behind it, without sending anything more.

The Java driver sends each command once, so Consensys fails on such a base. The
cost is time when the base will not answer: a query refused on every try fails
after 28 s, and unanswered after 43 s; a slot change unanswered, after 178 s. Each
try that fails is reported through `onStatus`. A host probing a port that may not
be a base can pass `commandTries` (and `timeouts.retryIntervalMs`) to fail
sooner, at the risk of taking a refusing base for no base.

**Hardware-verify items** (need a real Base-6 / Base-15 to confirm):

- **Slot-change timing.** The 10 s slot-change timeout and 1500 ms without-SD
  settle delay are ported as-is. On 25 Nov 2026 both were enough on both bases
  this client ran on, with idle Shimmer3s on v1.01.009 and v1.01.010. Every
  select was answered inside the 10 s, and every per-slot call passed after the
  settle: an identify, a status read and an InfoMem read of each slot, each
  after its own select. The status read is tried once and never failed.
  Identify's first read, the MAC, is tried twice, and the run records don't say
  whether it ever needed the second. Still to measure: how long a select takes
  to be answered, and how soon after routing the per-Shimmer UART is usable,
  which may be well under 1500 ms.
- **Sending again.** Tries 2 s apart are what got every command through on the
  bench Base6 that refused them, sent from the HIL harness. The harness went
  from 8 tries to 15 after one select was refused 8 times in a row. This client
  ran the rule from Node on 25 Nov 2026, on that Base6 and on a Base15 (both
  firmware 0.1.0), three runs on each: `getDockInfo`, `getSlotOccupancy`, an
  identify, status and InfoMem read of each docked Shimmer3 (four on the Base6;
  six on the Base15, slots 14 and 15 included), and `disconnectAllSlots`, all
  passing. In each run the first try of `SDQ$`, `SDP,01$` and `SDD$` was cut
  short a byte and refused with `E`, and the first `SDV$` was sent without its
  `$` and left unanswered; each was taken on the second try. Not yet seen on a
  base: two or more failed tries in a row, and `SDC,NN$`.
- **Occupancy semantics.** Occupancy is decoded from the `SDQ$` → `Q,<bitmap>`
  reply (one ASCII `0`/`1` per slot, index 0 → slot 1). The auto-notify `S,<map>`
  push and the **prototype-board slot remap** (`remapSlotsSmartDockToUi`, only
  BASE15U firmware ≤ 1.0.0.5) are deliberately **not** implemented. On 25 Nov
  2026 the decoding was right on both bases this client ran on: the Base6
  reported slots 1-4 and the Base15 slots 1, 3, 4, 6, 14 and 15, exactly where
  the Shimmer3s were docked, and identify found a unit in each. The Java
  remaps only a Base15 whose version reply gives firmware identifier 1 and
  version 0.0.0-0.0.5 (`SmartDockUart.java:818-823`). That Base15 reports
  identifier 1 and version 0.1.0 (1.0.1.0), outside the range, and needed no
  remap. Still to confirm: that no production base runs firmware in the remap
  range.
- **Base6-vs-15 detection.** `getDockInfo` derives family + slot count from the
  version reply's hardware-version field (`BASE_HARDWARE_IDS`: 1 → base15, 2 →
  base6), where the Java driver takes the slot count from the **USB device
  descriptor**. On 25 Nov 2026 the version byte alone was right on both bases
  this client ran on, each on firmware 0.1.0: the bench Base6 (`V,2,1,0,1,0`)
  came back base6 with 6 slots, and a Base15 (hardware 1) base15 with 15, its
  occupancy reaching slots 14 and 15. Still to confirm: that other base
  firmware versions and board revisions report the same hardware byte. A byte
  the SDK does not know gives `unknown` with 0 slots, and the host then has
  only the occupancy-bitmap length to go on.
- **Two-port assumption.** Real hardware presents the base control UART and the
  per-Shimmer UART as two separate serial ports (`SmartDock.java:226-229`). On
  25 Nov 2026 that held on both bases this client ran on, from Node on Windows:
  base commands went to one port, and each docked Shimmer's identify, status
  and InfoMem reads to the other (COM11 and COM14 for the bench Base6). The
  runner was told which port was which. Still to confirm: how the two ports
  enumerate through Web Serial in a browser and on macOS or Linux, and how a
  host tells them apart without being told.

## Factory Self-Test (Shimmer3 / Shimmer3R)

`runFactoryTest` asks the sensor to run the suite its firmware runs on the
production line, and returns the report it prints. It is available on
`Shimmer3RClient` (BLE and Classic Bluetooth) and on `WiredShimmerClient`
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

## Shimmer3R Bluetooth Module Update (IF820 OTA)

The Shimmer3R's Bluetooth module (Ezurio Vela IF820, an Infineon CYW20820)
is updated over BLE through Infineon's OTA firmware upgrade service: the same
protocol `WsOtaUpgrade.exe` uses. The Shimmer3R's own MCU cannot reflash it,
so a host does it directly, on the BLE connection it already has open.

```ts
import {
  Shimmer3RClient,
  if820OtaSensorSupport,
  isIf820UpdateAvailable,
} from '@shimmerresearch/shimmer-web-sdk';

const client = new Shimmer3RClient(); // requests the OTA services in optionalServices
await client.connect();
const hw = await client.readDeviceVersion();
const fw = await client.readFwVersion();
const sensor = {
  hardwareVersion: hw.hardwareVersion,
  firmwareId: fw.fwId,
  major: fw.major,
  minor: fw.minor,
  internal: fw.patch,
};
const current = await client.readBtModuleVersion();
if (if820OtaSensorSupport(sensor).supported && isIf820UpdateAvailable(current, '1.4.18.18')) {
  const image = await (await fetch('firmware/if820/module.ota.bin')).arrayBuffer();
  await client.updateBtModuleFirmware(image, {
    onProgress: ({ currentBytes, totalBytes }) => console.log(currentBytes / totalBytes),
  });
  // The module resets onto the new image and the link drops. Reconnect without
  // a picker by handing the same BluetoothDevice to a new WebBluetoothTransport.
}
```

- **Shimmer3R on LogAndStream v1.01.022 or later only.** That release is the
  first to recover by itself once the module restarts on its new image, and
  to repair the SPP MTU an update leaves broken on v1.4.18.x.
  `if820OtaSensorSupport` says whether a sensor qualifies, with a message to
  show when it does not, and `updateBtModuleFirmware` refuses any other
  sensor.
- **One update per device at a time.** A second update on the same device,
  from any client or a direct `runIf820OtaUpdate`, is refused until the first
  has finished, including any connect, reconnect or write it gave up on but
  which may still be running on the link. A failed update whose command
  answer timed out leaves the link dropped; reconnect before trying again.
- **BLE only.** A Classic Bluetooth or USB link cannot reach the module's GATT
  service.
- **The OTA services must be granted at connect time.** `Shimmer3RClient`
  requests them by default. A host that builds its own `requestDevice` options
  must include `client.requestedOptionalServices()`, or the update cannot run
  without a second device picker.
- **512-byte writes first, 63 if the link stalls.** Whether the module accepts
  large writes depends on the packet airtime the two radios agreed, which a
  page cannot see. A stalled first write makes the update drop and re-open
  the link (no picker) and continue at 63 bytes, so expect one disconnect
  during the update in that case; `onRetry` reports it. Through
  `updateBtModuleFirmware` that reconnect goes through the client's own
  transport, so the client is fully connected again afterwards; a host
  calling `runIf820OtaUpdate` with its own transport on the link passes a
  `reconnect` that does the same.
- **Interruption is safe.** The module switches images only after it has
  verified the whole image's CRC-32, so a dropped link or a cancel leaves the
  old firmware running, and the update can be run again. The one exception
  is the VERIFY itself: once it is written the module may already be
  switching, so a cancel then is ignored, and a failure after it says the
  new firmware may have been accepted (reconnect and read the version).
- **Never arm reboot-on-disconnect for it.** Rebooting the MCU when the
  link drops after VERIFY cuts the module's power while it is still switching
  images, and it comes back on the old one. LogAndStream v1.01.022 and later
  reboot the MCU themselves once the module is back, so the new version is
  reported after reconnecting.

`runIf820OtaUpdate(device, image, opts)` is the same flow without a client,
for any object that has the `BluetoothDevice`'s `gatt` server. Run end to end
on a Shimmer3R from Chrome; the stalled-link fallback (reconnect, then 63-byte
writes) is not yet hardware-verified under Web Bluetooth: `HARDWARE-VERIFY:`.

## Reconnecting After a Dropped Link

A sensor that walks out of range, or is switched off, drops the link. The
browser's pickers appear only when a page asks for a new device
(`requestDevice()`, `requestPort()`), so a page that kept what it was given
reconnects with no picker and no click:

- **BLE:** a new `WebBluetoothTransport` with `device:` set to the same
  `BluetoothDevice` reconnects through `device.gatt.connect()`.
- **Classic Bluetooth:** a new `WebSerialTransport` with `port:` set to the
  same `SerialPort` reopens it, which brings the RFCOMM link up again. Keep
  the port when connecting: the transport lets go of it on disconnect.

`startAutoReconnect` runs the tries; the caller says what one try is.

```ts
import {
  Shimmer3RClient,
  WebBluetoothTransport,
  SHIMMER3R_DEFAULTS,
  planStreamResume,
  startAutoReconnect,
} from '@shimmerresearch/shimmer-web-sdk';

client.onDisconnect = () => {
  // Fired only for a drop the page did not ask for, never by disconnect().
  const before = { streaming: wasStreaming, sdLogging: wasLogging };
  const device = keptDevice;
  const handle = startAutoReconnect({
    attempt: async () => {
      client = new Shimmer3RClient({
        transport: new WebBluetoothTransport({
          serviceUUID: SHIMMER3R_DEFAULTS.SERVICE_UUID,
          writeCharUUID: SHIMMER3R_DEFAULTS.CHAR_RX_UUID,
          notifyCharUUID: SHIMMER3R_DEFAULTS.CHAR_TX_UUID,
          device, // no picker
          defaultWriteWithResponse: true,
        }),
      });
      await client.connect();
    },
    abandon: () => device.gatt?.disconnect(), // ends a connect stuck pending
    onAttemptFailed: ({ nextDelayMs }) => show(`retrying in ${nextDelayMs} ms`),
  });
  cancelButton.onclick = () => handle.cancel();
  handle.done.then(async ({ outcome }) => {
    if (outcome !== 'connected') return;
    const action = planStreamResume(before, await client.getStatus());
    if (action === 'start-streaming') await client.startStreaming();
    if (action === 'start-streaming-and-logging') await client.startStreamingAndLogging();
  });
};
```

- **Every try has a deadline** (`attemptTimeoutMs`, 30 s). On Windows a
  `gatt.connect()` to a sensor that is out of range, or whose bond the PC holds
  stale, can stay pending forever (DEV-845). An overrun try is abandoned: its
  `signal` aborts and `abandon` is called. If it succeeds anyway, `abandon` is
  called again with `late: true`, so the link it opened can be closed.
- **The waits grow:** 1 s before the first try, then 2, 4, 8 and 15 s at most
  (`initialDelayMs`, `retryDelayMs`, `backoffFactor`, `maxDelayMs`). It keeps
  going until cancelled unless `maxAttempts` or `maxDurationMs` is set.
  `reconnectDelayMs` and `nextReconnectDelayMs` give the schedule on their own.
- **`cancel()` is immediate.** It abandons a try in progress without waiting
  for it, and `done` resolves `'cancelled'`.
- **What to send once back is `planStreamResume`'s answer.** On a lost link
  the firmware stops the stream and leaves an SD log running, so a stream with
  a log comes back as a plain stream while the log is still running, and as a
  stream and log only once the status says the log ended too. With no status
  it never starts a second log on a guess.
- **Data sent while the link was down is lost.** The firmware does not buffer
  it for the host; an SD log, if one was running, has it.
- **Not across a page reload.** The device or port object is gone then, and
  getting it back without a picker needs `navigator.bluetooth.getDevices()`,
  which Chrome still keeps behind a flag.

`HARDWARE-VERIFY:` the loop and the resume rule are tested against fakes and
the firmware source; reconnecting a real sensor over BLE and Classic Bluetooth
from Chrome has not been run yet.

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
    units.ts                    ← CHANNEL_UNITS — the Java driver's unit strings
    StreamTimeline.ts           ← counter unwrap + wall-clock anchoring
    transport/                  ← pluggable byte-pipe layer
      types.ts                  ← ShimmerTransport interface + capabilities
      WebBluetoothTransport.ts  ← Web Bluetooth GATT transport (default web)
      WebSerialTransport.ts     ← Web Serial (USB) transport
      LoopbackTransport.ts      ← in-memory transport for tests
  devices/
    calibration/
      streamChannels.ts         ← the one per-channel conversion table
      gyroOnTheFly.ts           ← gyro on-the-fly offset re-estimation (bit 29)
      gsr.ts                    ← GSR µS / kΩ / range, shared by both clients
      sensorIds.ts              ← SC_SENSOR ids, dump → per-group calibration
    pressure/                   ← Bosch BMP180 / 280 / 390 / 581 compensation
      response.ts               ← the 0xA7 reply, coefficient parsers
      compensate.ts             ← raw registers → kPa and °C
    exg/
      registers.ts              ← ADS1292R register codec
      calibration.ts            ← reference voltage and PGA gain → mV factor
    shimmer3/
      Shimmer3Client.ts         ← classic Bluetooth / unframed byte stream
      sensorRules.ts            ← conflicts, expansion power, board gating
      protocol.ts               ← control-message framing, firmware gates
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
