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

## Device and radio matrix — check the reference, don't infer

Which radio a board carries is **not** a single revision cutoff. It tracks the sensor generation, the
gates differ per board ID (SR31 / SR38 / SR47 / SR48 / SR49 each run their own major/minor scheme),
and assembly variants of the same PCB are distinguished by programming a higher minor revision — so
a revision number only means something alongside its board ID.

The reference is
[`SHIMMER3_BOARD_REVISIONS.md`](https://github.com/ShimmerResearch/log-and-stream-common/blob/main/docs/SHIMMER3_BOARD_REVISIONS.md)
in `log-and-stream-common`, itself derived from `Shimmer_PCBREV_INDEX.xlsx`. Read it before changing
anything transport-related. In outline only: first and second generation boards carry an **RN42**
(Classic Bluetooth, no BLE radio at all), third generation moved to the dual-mode **RN4678**, and
fourth generation (Shimmer3R) uses a **Vela IF820**. Board identity is `SR<board id>-<major>-<minor>`,
held in the expansion-board EEPROM and read at runtime via `ShimBrd_getDaughtCardId()`.

What actually matters for this SDK: `Shimmer3Client` has **no built-in BLE transport** and needs an
injected transport whichever radio is in play. Never infer a board's capability from its model name
or from a revision number alone.

## Consumers vendor `dist/`, they don't npm-install it

`verisense-device-console` and `webBLEDemos` each hold a copied `vendor/` build. After changing the
SDK, bump the version and run `../sync-all-vendors.ps1` from the workspace root — it builds here and
delegates to each consumer's own `sync-local-sdk.ps1`. Never hand-copy `dist/` files into a consumer;
the sync scripts also stamp `sdk-source.json`, which the consumer UIs display.
