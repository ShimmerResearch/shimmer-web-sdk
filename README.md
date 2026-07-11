# @shimmerresearch/shimmer-web-sdk

Web Bluetooth and Web Serial SDK for Shimmer sensor devices.

## Supported Devices

| Device                  | Class                | Transport                            |
| ----------------------- | -------------------- | ------------------------------------ |
| Shimmer3R               | `Shimmer3RClient`    | Web Bluetooth                        |
| Shimmer3 (classic BT)   | `Shimmer3Client`     | RFCOMM/SPP (injected transport only) |
| Verisense (IMU, Pulse+) | `VerisenseBleDevice` | Web Bluetooth, Web Serial            |

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
