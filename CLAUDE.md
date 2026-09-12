# shimmer-web-sdk

`@shimmerresearch/shimmer-web-sdk` — Web Bluetooth / Web Serial SDK for Shimmer devices.
TypeScript, bundled by rollup to ESM + CJS + `.d.ts`. Published to GitHub Packages.

## Commands
```
npm run build       # rollup -> dist/  (what consumers vendor)
npm test            # vitest run
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src tests
npm run format      # prettier --write .
```
CI is `ci.yml`; `format-on-commit.yml` applies prettier automatically, `cut-release.yml` handles releases.

## The `HARDWARE-VERIFY:` convention
Source and docs carry `HARDWARE-VERIFY:` markers flagging behaviour that was derived from protocol
docs or firmware source but **never exercised against real hardware**. Treat them as load-bearing:
- Don't delete one without actually testing on the device it names.
- Add one when you implement something you could not verify physically.

## Device and radio matrix — get this right before changing transports
The README's device table is required reading. The distinction that catches people:
Shimmer3 boards up to expansion-board rev 5 carry an **RN42** (Classic Bluetooth only, no BLE radio
at all); rev 6+ carry an **RN4678** (dual-mode). `Shimmer3Client` has **no built-in BLE transport**
and requires an injected transport either way. A Shimmer3R is different again — native nRF52 BLE.

## Consumers vendor `dist/`, they don't npm-install it
`verisense-device-console` and `webBLEDemos` each hold a copied `vendor/` build. After changing the
SDK, bump the version and run `../sync-all-vendors.ps1` from the workspace root — it builds here and
delegates to each consumer's own `sync-local-sdk.ps1`. Never hand-copy `dist/` files into a consumer;
the sync scripts also stamp `sdk-source.json`, which the consumer UIs display.
