# @shimmerresearch/web-ble

Web Bluetooth SDK for Shimmer sensor devices.

## Supported Devices

| Device | Class | Transport |
|---|---|---|
| Shimmer3R | `Shimmer3RClient` | Web Bluetooth |
| Verisense (Pulse Plus, GSR Plus) | `VerisenseBleDevice` | Web Bluetooth, Web Serial |

## Quick Start

### Shimmer3R

```html
<script type="module">
  import { Shimmer3RClient, SensorBitmapShimmer3 } from './dist/shimmer-ble.esm.js';

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
  import { VerisenseBleDevice } from './dist/shimmer-ble.esm.js';

  const v = new VerisenseBleDevice({ hardwareIdentifier: 'VERISENSE_PULSE_PLUS' });
  v.on('streamPacket', (pkt) => console.log(pkt.sensorId, pkt.decoded));

  document.getElementById('btnConnect').addEventListener('click', async () => {
    await v.connect();
    await v.startStreaming();
  });
</script>
```

## Building

```bash
npm install
npm run build    # produces dist/shimmer-ble.esm.js, .umd.js, .d.ts
```

## Testing

```bash
npm test         # Vitest — runs without a browser
```

## Publishing to GitHub Packages

This package is configured for GitHub Packages (`@shimmerresearch` scope).  
Publishing is automated by `.github/workflows/publish-github-packages.yml` and runs on:

- Release published
- Manual workflow dispatch

To publish, create a GitHub release for the tag/version you want to publish.

## Package Layout

```
src/
  index.ts                     ← barrel: re-exports all public API
  core/
    types.ts                   ← shared interfaces (IShimmerClient, SensorField…)
    ObjectCluster.ts            ← sensor data frame container
    BaseShimmerClient.ts        ← abstract base class
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
        SensorGSR.ts            ← GSR decoder (id=1)
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

MIT
