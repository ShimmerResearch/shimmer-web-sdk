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

## Verisense logged-data (flash-page) decoder

`VerisenseBleDevice.transferLoggedData()` downloads the device's logged session as
raw flash "payload" pages. `decodeVerisenseLoggedData()` turns those bytes into
decoded per-sensor samples **offline**, with no hardware and no browser:

```ts
import { VerisenseBleDevice, decodeVerisenseLoggedData } from '@shimmerresearch/shimmer-web-sdk';

const v = new VerisenseBleDevice();
await v.connect();
await v.readCalibrationParsed(); // optional: per-device calibration
const result = await v.transferLoggedData(); // { blob, bytesWritten, ... }
const bytes = new Uint8Array(await result.blob.arrayBuffer());

const decoded = decodeVerisenseLoggedData(bytes, {
  operationalConfig: v.operationalConfig ?? undefined, // enables/rates + FIFO block sizes
  calibration: v.getCalibration(), // apply per-device calibration
});

console.log(
  decoded.samplesDecoded,
  'samples across',
  Object.keys(decoded.sensors).length,
  'sensors',
);
console.log(
  'pages',
  decoded.pagesTotal,
  'bad',
  decoded.pagesBad,
  'skipped',
  decoded.recordsSkipped,
);
// decoded.sensors[2].samples → LIS2DW12 samples ({ raw, cal, timestamps })
```

A logged flash page is a **container** — a page header (index + length + config),
one-or-more data blocks, a footer (RTC/temperature/battery), and a page CRC. Each
data block's sample framing (`[sensorId][tick u24 LE][FIFO bytes]`) is **identical
to a live BLE stream payload**, so the decoder reuses the same `Sensor*.parsePayload`
decoders, calibration and `SensorBase` timestamp logic — it only adds the container
handling. Bad-CRC, unsizable, and truncated pages are **counted and reported, never
guessed** (`pagesBad`, `recordsSkipped`, `truncatedTrailingPage`).

### Logged-data decoder — verification status

⚠️ **The logged-data decoder has NOT yet been validated against a real hardware
flash capture.** The page/data-block layout was reconstructed from the Java
reference (`PayloadDetails`, `PayloadContentsDetailsV8orAbove`, `DataBlockDetails`,
`AsmBinaryFileConstants`) and the SDK's own live-stream decoders, and is unit-tested
by round-tripping fixtures built to that layout. The following seams (tagged
`@remarks HARDWARE-VERIFY` in `loggedData.ts`) must be confirmed against a capture:

| Seam                                                               | Confidence | What a capture must confirm                                                    |
| ------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------ |
| ADC / LIS2DW12 block size = 192 B                                  | High       | Fixed FIFO buffer sizes hold on-flash                                          |
| LSM6DS3 block size (FIFO threshold × 2, from op config)            | Medium     | Byte size matches the configured FIFO watermark                                |
| PPG block size                                                     | Low        | Derivation from channels × samples (supply `blockSizes[4]`)                    |
| 2nd-gen ids (LSM6DSV 6, VD6283 7, MAX32674 8, MLX90632 9)          | Unknown    | Their flash datablock id + block size (no Java reference; supply `blockSizes`) |
| PPG sample endianness                                              | Medium     | LE (SDK live decoder) vs BE (Java flash reference)                             |
| Payload-config / footer length per firmware payload-design version | Medium     | `payloadConfigLength` / `payloadDesignVersion` defaults                        |
| Absolute per-sample RTC (minute back-fill)                         | N/A        | Only relative tick timing + raw footer RTC are produced today                  |
| Payload-design v1–v7 and ZLIB/XZ-compressed pages                  | N/A        | Not decoded — reported as skipped                                              |

Any block size and the config/footer lengths can be overridden via the
`decodeVerisenseLoggedData` options once verified.

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
