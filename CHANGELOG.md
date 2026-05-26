# Changelog

All notable changes to `@shimmerresearch/shimmer-web-sdk` will be documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial TypeScript SDK structure migrated from `ShimmerAPI/shimmer3r.js` and `Verisense/verisense.js`.
- `Shimmer3RClient` — typed BLE client for the Shimmer3R platform.
- `VerisenseBleDevice` — typed BLE + Web Serial client for the Verisense platform.
- `ObjectCluster` — shared typed data-frame container.
- `BaseShimmerClient` — abstract base class implementing `IShimmerClient`.
- `SensorBitmapShimmer3` — sensor enable bitmask constants.
- `CHANNEL_FORMATS` — mapping from Shimmer3R channel ID to format descriptor.
- Sensor decoders: `SensorGSR`, `SensorLIS2DW12`, `SensorLSM6DS3`, `SensorPPG`.
- Calibration utilities: `calibrateGsrDataToResistanceFromAmplifierEq`, `nudgeGsrResistance`, `getOversamplingRatioADS1292R`.
- CRC-16/CCITT-FALSE implementation in `protocol.ts`.
- Rollup build producing `dist/shimmer-web-sdk.esm.js`, `dist/shimmer-web-sdk.umd.js`, `dist/shimmer-web-sdk.d.ts`.
- Vitest unit tests for calibration, protocol helpers, CRC, and sensor decoders.
