# @shimmerresearch/shimmer-web-sdk

Web Bluetooth and Web Serial SDK for Shimmer sensor devices.

## Supported Devices

| Device                  | Class                | Transport                                |
| ----------------------- | -------------------- | ---------------------------------------- |
| Shimmer3R               | `Shimmer3RClient`    | Web Bluetooth                            |
| Shimmer3 (classic BT)   | `Shimmer3Client`     | RFCOMM/SPP (injected transport only)     |
| Shimmer in dock/Base    | `WiredShimmerClient` | Dock FTDI UART (injected transport only) |
| Verisense (IMU, Pulse+) | `VerisenseBleDevice` | Web Bluetooth, Web Serial                |

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

### Classic-Bluetooth Shimmer3 (`Shimmer3Client`)

The classic (pre-3R) Shimmer3 speaks the same LiteProtocol but over an **RFCOMM/SPP
byte stream** rather than BLE. Because Web Bluetooth cannot open an RFCOMM socket,
classic Shimmer3 is **impossible in a browser** — `Shimmer3Client` therefore
_requires_ an injected transport and `connect()` throws without one. A platform
that can open SPP (e.g. a React Native Android module calling
`createRfcommSocketToServiceRecord`, SPP UUID `SHIMMER3_SPP_UUID`) supplies the
transport; the transport should report `capabilities.framed = false` since RFCOMM
has no message boundaries.

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
