/**
 * Verisense logged-data (flash-page) decoder.
 *
 * Turns the raw bytes produced by {@link VerisenseBleDevice.transferLoggedData}
 * — a concatenation of flash "payload" pages exactly as the device streams them
 * during a data sync — into decoded per-sensor samples, offline and without
 * hardware.
 *
 * ---------------------------------------------------------------------------
 * WHAT A FLASH PAGE IS (and how it differs from a live BLE stream frame)
 * ---------------------------------------------------------------------------
 * A live BLE stream frame carries a SINGLE bare data block:
 *   `[sensorId(1)][tick u24 LE(3)][sensor FIFO bytes…]` (+ a 2-byte CRC-16
 *   trailer stripped by the stream scanner). See VerisenseClient
 *   `_handleStreamingPayload` and `scanStreamFrame`.
 *
 * A logged flash page is a CONTAINER that wraps one-or-more of those very same
 * data blocks with a page header, a page footer, and a single page CRC. It is
 * the byte-for-byte record the firmware persists to flash and replays over the
 * DATA property during sync (`VerisenseClient._handleLoggedPayload` pushes each
 * whole page into the transfer result). All multi-byte header/footer fields are
 * little-endian.
 *
 *   Page layout (Java reference: PayloadDetails.parsePayload,
 *   PayloadContentsDetailsV8orAbove, AsmBinaryFileConstants):
 *
 *     0                      u16  PAYLOAD_INDEX
 *     2                      u16  PAYLOAD_LENGTH   (= config bytes + ram-block bytes)
 *     4                      …    PAYLOAD_CONFIG    (core 2 B; +4 B FW ver +
 *                                                    extended bytes when the
 *                                                    "extended config" bit is set)
 *     4+configLen            …    RAM BLOCK: repeated data blocks, each
 *                                    [sensorId(1)][tick u24 LE(3)][FIFO bytes(blockSize)]
 *     …                      …    PAGE FOOTER (see {@link loggedFooterLength})
 *     total-2                u16  PAYLOAD_CRC        (CRC-16/CCITT-FALSE over the
 *                                                    preceding total-2 bytes)
 *
 *   total page span = PAYLOAD_LENGTH + 6 (index 2 + length 2 + CRC 2).
 *
 * So the *sample* framing inside each block is IDENTICAL to a live stream
 * payload, which is why this decoder REUSES the existing per-sensor
 * `Sensor*.parsePayload` decoders and `SensorBase` timestamp logic unchanged —
 * it only adds the container (page split, CRC, block iteration, footer) that
 * streaming does not have.
 *
 * ---------------------------------------------------------------------------
 * @remarks HARDWARE-VERIFY — seams that could not be pinned down without a real
 * flash capture (see README "Logged-data decoder — verification status"):
 *
 *  1. **Per-block size is NOT stored in the page.** The firmware writes a full
 *     FIFO drain whose length is derived from the operational config (FIFO
 *     watermark × bytes-per-sample), so the decoder must recompute it. ADC (192)
 *     and LIS2DW12 (192) are fixed constants in the Java reference and are
 *     HIGH-confidence; LSM6DS3 (FIFO threshold × 2) and PPG (channels × samples)
 *     are config-derived and MEDIUM/LOW-confidence. Any datablock size can be
 *     forced via `options.blockSizes`.
 *  2. **Second-generation sensor ids (LSM6DSV=6, VD6283=7, MAX32674=8,
 *     MLX90632=9)** have NO logged-format reference in the Java sources; their
 *     flash datablock id and block size are unknown. They are decoded only when
 *     an explicit `blockSizes[id]` is supplied; otherwise the page is reported,
 *     not guessed.
 *  3. **PPG sample endianness**: the Java flash reference decodes MAX869xx PPG
 *     as 24-bit BIG-endian, whereas the SDK's live `SensorPPG` (MAX86176) uses
 *     little-endian. This decoder reuses the SDK decoder (little-endian) as the
 *     authority for SDK hardware; verify against a capture.
 *  4. **Payload-config length and footer length depend on the firmware payload-
 *     design version.** Defaults target design v8+ with the extended config
 *     present and footer design v9 (RTC minutes+ticks+temp+batt); override with
 *     `payloadConfigLength` / `payloadDesignVersion` if a capture disagrees.
 *  5. **Absolute RTC anchoring / minute back-fill** across blocks (Java
 *     `backfillDataBlockRwcTimestamps`) is NOT reproduced; per-sample times are
 *     the same tick-based relative times the live path produces, plus the raw
 *     page-footer RTC is exposed for callers that need absolute wall-clock.
 *  6. **Payload-design v1–v7** (bare single-sensor pages, optional 1-byte SPI
 *     header per FIFO block) and **ZLIB/XZ compression** are NOT decoded; such
 *     pages are counted and reported, never guessed.
 */

import { SensorBase } from './sensors/SensorBase.js';
import { SensorADC } from './sensors/SensorADC.js';
import { SensorLIS2DW12 } from './sensors/SensorLIS2DW12.js';
import { SensorLSM6DS3 } from './sensors/SensorLSM6DS3.js';
import { SensorLSM6DSV } from './sensors/SensorLSM6DSV.js';
import { SensorPPG } from './sensors/SensorPPG.js';
import { SensorVD6283 } from './sensors/SensorVD6283.js';
import { SensorMAX32674 } from './sensors/SensorMAX32674.js';
import { SensorMLX90632 } from './sensors/SensorMLX90632.js';
import { crc16_ccitt_false, u16le_at, u24le, i16le } from './protocolUtils.js';
import { OP_IDX } from './constants.js';
import type { CalibrationSet } from './calibration.js';

// ---------------------------------------------------------------------------
// Container constants (Java: AsmBinaryFileConstants.BYTE_COUNT)
// ---------------------------------------------------------------------------

/** Bytes of the page index field at the very start of a page. */
export const LOGGED_PAYLOAD_INDEX_BYTES = 2;
/** Bytes of the page length field. */
export const LOGGED_PAYLOAD_LENGTH_BYTES = 2;
/** Bytes of the trailing page CRC-16. */
export const LOGGED_PAYLOAD_CRC_BYTES = 2;
/** Fixed overhead around the declared PAYLOAD_LENGTH: index(2)+length(2)+crc(2). */
export const LOGGED_PAGE_FIXED_OVERHEAD =
  LOGGED_PAYLOAD_INDEX_BYTES + LOGGED_PAYLOAD_LENGTH_BYTES + LOGGED_PAYLOAD_CRC_BYTES;

/** Core (always-present) payload-config bytes. */
export const LOGGED_PAYLOAD_CONFIG_CORE_BYTES = 2;
/** FW-version bytes present when the extended-config bit is set. */
export const LOGGED_PAYLOAD_CONFIG_FWVER_BYTES = 4;
/** The "extended payload config" bit in PAYLOAD_CONFIG0 (Java: 0x01 << 4). */
export const LOGGED_EXTENDED_CONFIG_BIT = 0x10;

/** Per-data-block header inside the ram block: sensorId(1) + tick u24(3). */
export const LOGGED_DATABLOCK_HEADER_BYTES = 1 + 3;

/**
 * Fixed FIFO block byte sizes from the Java reference (HIGH confidence).
 * - ADC (battery/GSR share one fixed buffer): SensorBattVoltageVerisense.ADC_BYTE_BUFFER_SIZE
 * - LIS2DW12: SensorLIS2DW12.FIFO_SIZE_IN_CHIP
 */
export const LOGGED_ADC_BLOCK_BYTES = 192;
export const LOGGED_LIS2DW12_BLOCK_BYTES = 192;

/** Ticks per second of the Verisense clock (shared with {@link SensorBase.CLOCK_FREQ}). */
export const LOGGED_TICKS_PER_SECOND = SensorBase.CLOCK_FREQ;

/**
 * Flash datablock sensor ids (Java: DataBlockDetails.DATABLOCK_SENSOR_ID ordinals).
 * Ids 1–4 coincide with the SDK stream sensor ids for ADC/LIS2DW12/LSM6DS3/PPG.
 */
export const LOGGED_DATABLOCK_SENSOR_ID = Object.freeze({
  NONE: 0,
  ADC: 1,
  ACCEL_1: 2, // LIS2DW12
  GYRO_ACCEL2: 3, // LSM6DS3 (first-gen)
  PPG: 4,
  BIOZ: 5,
});

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DecodedLoggedSensor {
  /** Datablock/stream sensor id byte. */
  sensorId: number;
  /** Human-readable label. */
  label: string;
  /** Decoded samples (shape identical to the live-stream `parsePayload` output for this sensor). */
  samples: unknown[];
  /** Number of samples decoded for this sensor. */
  samplesDecoded: number;
  /** Number of data blocks contributed to this sensor. */
  blocks: number;
}

export interface DecodedLoggedFooter {
  /** Page index (from the page header). */
  payloadIndex: number;
  /** RTC minutes counter from the footer, or null when not present for the design version. */
  rtcMinutes: number | null;
  /** RTC ticks from the footer, or null when not present. */
  rtcTicks: number | null;
  /**
   * Absolute end-of-page real-world-clock time in milliseconds since the RTC
   * epoch, from `(minutes*60 + ticks/32768)*1000`, or null when unavailable.
   * @remarks HARDWARE-VERIFY — per-sample RTC back-fill is not applied.
   */
  rtcEndMillis: number | null;
  /** Raw uncalibrated temperature word (int16), or null. */
  temperatureRaw: number | null;
  /** Raw battery voltage word (uint12), or null. */
  batteryRaw: number | null;
}

export interface DecodeVerisenseLoggedDataOptions {
  /**
   * Operational config blob (as read from the device / a template). Drives
   * per-sensor channel enables, sampling rates and — critically — the
   * config-derived FIFO block sizes for LSM6DS3/PPG. Strongly recommended;
   * without it the decoder falls back to sensor defaults and fixed block sizes.
   */
  operationalConfig?: Uint8Array | number[] | null;
  /** Per-device calibration set (see {@link parseCalibrationBlob}). */
  calibration?: CalibrationSet | null;
  /** Apply calibration to decoded samples. Default true when a calibration set is supplied. */
  applyCalibration?: boolean;
  /**
   * Hardware identifier forwarded to the ADC decoder (battery/GSR scaling).
   * Default 'VERISENSE_PULSE_PLUS'.
   */
  hardwareIdentifier?: string;
  /**
   * Explicit per-datablock-sensor-id FIFO block byte sizes. Overrides the
   * built-in resolver — the escape hatch for hardware-verified sizes and for
   * second-generation sensor ids the Java reference does not cover.
   */
  blockSizes?: Partial<Record<number, number>>;
  /**
   * Number of payload-config bytes following the index+length header. When
   * omitted it is auto-detected from the extended-config bit + payload design
   * version. @remarks HARDWARE-VERIFY.
   */
  payloadConfigLength?: number;
  /**
   * Firmware payload-design version (8, 9, 10, 11, 12…). Selects the footer
   * layout and the auto-detected extended-config length. Default 9.
   * @remarks HARDWARE-VERIFY.
   */
  payloadDesignVersion?: number;
}

export interface DecodeVerisenseLoggedDataResult {
  /** Decoded samples grouped by sensor id. */
  sensors: Record<number, DecodedLoggedSensor>;
  /** Total decoded samples across all sensors. */
  samplesDecoded: number;
  /** Number of pages found (including bad/partial ones). */
  pagesTotal: number;
  /** Pages whose CRC did not validate (counted, never decoded). */
  pagesBad: number;
  /** Pages skipped because a datablock could not be sized/advanced. */
  pagesWithSkippedRecords: number;
  /** Data blocks that could not be decoded (unknown/unsizable sensor id, or size overrun). */
  recordsSkipped: number;
  /**
   * Bytes inside a page's data region that the block walk did not attribute to a
   * block (i.e. the walk did not land exactly on the footer boundary). A non-zero
   * value is a strong signal that `payloadDesignVersion` / `payloadConfigLength`
   * is wrong for this capture — the decoder surfaces it instead of silently
   * mis-decoding the tail. @remarks HARDWARE-VERIFY.
   */
  bytesUnattributed: number;
  /** A trailing page shorter than its declared length (truncated capture). */
  truncatedTrailingPage: boolean;
  /** Bytes left over after the last complete page (0 unless truncated). */
  trailingByteCount: number;
  /** Per-page footer info (temperature / battery / RTC), one entry per CRC-valid page. */
  footers: DecodedLoggedFooter[];
  /** Gaps in the page payload-index sequence (dropped pages / device resets). */
  payloadIndexGaps: LoggedPayloadIndexGap[];
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/**
 * Extended payload-config byte count for a payload-design version, mirroring
 * Java `PayloadContentsDetails.calculateExtendedPayloadConfigBytesSize` (the
 * cumulative per-version additions). Excludes the 4 FW-version bytes.
 */
export function loggedExtendedConfigBytes(payloadDesignVersion: number): number {
  const v = payloadDesignVersion;
  let n = 0;
  if (v >= 2) n += 1;
  if (v >= 3) n += 4;
  if (v >= 4) n += 5;
  if (v >= 5) n += 1;
  if (v >= 6) n += 2;
  if (v >= 7) n += 1;
  if (v >= 8) n += 4;
  if (v >= 12) n += 1;
  return n;
}

/**
 * Total payload-config length (bytes after the index+length header, before the
 * ram block). `extended=false` returns just the 2 core bytes.
 */
export function loggedPayloadConfigLength(payloadDesignVersion: number, extended: boolean): number {
  if (!extended) return LOGGED_PAYLOAD_CONFIG_CORE_BYTES;
  return (
    LOGGED_PAYLOAD_CONFIG_CORE_BYTES +
    LOGGED_PAYLOAD_CONFIG_FWVER_BYTES +
    loggedExtendedConfigBytes(payloadDesignVersion)
  );
}

/**
 * Page-footer length (bytes between the last data block and the page CRC),
 * mirroring Java `BYTE_COUNT.PAYLOAD_CONTENTS_FOOTER_*`:
 *  - v8            → minutes(4) + temp(2) + batt(2)          = 8
 *  - v9 (or <8)    → minutes(4) + ticks(3) + temp(2) + batt(2) = 11
 *  - v10+          → +uC minutes(4) + uC ticks(3)            = 18
 */
export function loggedFooterLength(payloadDesignVersion: number): number {
  if (payloadDesignVersion === 8) return 4 + 2 + 2;
  if (payloadDesignVersion >= 10) return 4 + 3 + 2 + 2 + 4 + 3;
  return 4 + 3 + 2 + 2;
}

/** Whether the footer for this design carries RTC ticks (i.e. not the v8-only footer). */
function footerHasTicks(payloadDesignVersion: number): boolean {
  return payloadDesignVersion !== 8;
}

/**
 * Resolve the FIFO block byte size for a flash datablock sensor id.
 *
 * @returns the block size in bytes, or null when it cannot be determined (the
 *   caller then reports the page rather than guessing).
 * @remarks HARDWARE-VERIFY — see module header seams (1) and (2).
 */
export function resolveLoggedBlockSize(
  sensorId: number,
  opConfig: Uint8Array | null,
  overrides?: Partial<Record<number, number>>,
): number | null {
  if (overrides && Number.isFinite(overrides[sensorId] as number)) {
    return overrides[sensorId] as number;
  }
  switch (sensorId) {
    case LOGGED_DATABLOCK_SENSOR_ID.ADC:
      return LOGGED_ADC_BLOCK_BYTES; // fixed ADC buffer (HIGH confidence)
    case LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1:
      return LOGGED_LIS2DW12_BLOCK_BYTES; // FIFO_SIZE_IN_CHIP (HIGH confidence)
    case LOGGED_DATABLOCK_SENSOR_ID.GYRO_ACCEL2: {
      // Java: SensorLSM6DS3.getFifoByteSizeInChip() = getFifoSizeInChip()*2,
      // where fifoSizeInChip = FTH_LSB | ((FTH_MSB & 0x0f) << 8) from the op
      // config. @remarks HARDWARE-VERIFY.
      if (!opConfig) return null;
      const lsb = opConfig[OP_IDX.GYRO_ACCEL2_CFG_0] ?? 0;
      const msb = (opConfig[OP_IDX.GYRO_ACCEL2_CFG_1] ?? 0) & 0x0f;
      const fifoSizeInChip = (lsb | (msb << 8)) >>> 0;
      const bytes = fifoSizeInChip * 2;
      return bytes > 0 ? bytes : null;
    }
    // PPG (4) and second-generation ids (6–9): the Java reference gives no
    // reliable flash block size, so require an explicit override.
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Page splitting
// ---------------------------------------------------------------------------

export interface LoggedPageSpan {
  /** Page index from the header. */
  payloadIndex: number;
  /** Declared PAYLOAD_LENGTH field value. */
  payloadLength: number;
  /** The whole page bytes (index … CRC inclusive). */
  bytes: Uint8Array;
}

export interface LoggedPageSplit {
  pages: LoggedPageSpan[];
  /** True when the final page's declared length exceeds the bytes available. */
  truncatedTrailingPage: boolean;
  /** Count of leftover bytes after the last complete page. */
  trailingByteCount: number;
}

/**
 * Split a concatenation of flash pages (the SDK `transferLoggedData` result) at
 * the per-page length field. Pure; never throws on a truncated tail.
 */
export function splitVerisenseLoggedPages(bytes: Uint8Array): LoggedPageSplit {
  const pages: LoggedPageSpan[] = [];
  let offset = 0;
  let truncatedTrailingPage = false;

  while (offset + LOGGED_PAGE_FIXED_OVERHEAD <= bytes.length) {
    const payloadIndex = u16le_at(bytes, offset);
    const payloadLength = u16le_at(bytes, offset + LOGGED_PAYLOAD_INDEX_BYTES);

    // Guard mirrors Java PayloadDetails: index==length==0xFFFF marks erased/bad flash.
    if (payloadIndex === 0xffff && payloadLength === 0xffff) {
      truncatedTrailingPage = false;
      break;
    }

    const totalSpan = payloadLength + LOGGED_PAGE_FIXED_OVERHEAD;
    if (offset + totalSpan > bytes.length) {
      // Declared page runs past the buffer end: truncated capture.
      truncatedTrailingPage = true;
      break;
    }

    pages.push({
      payloadIndex,
      payloadLength,
      bytes: bytes.subarray(offset, offset + totalSpan),
    });
    offset += totalSpan;
  }

  return {
    pages,
    truncatedTrailingPage,
    trailingByteCount: Math.max(0, bytes.length - offset),
  };
}

/** A discontinuity in the monotonic payload-index sequence between two
 * consecutive pages (a dropped page during sync, or a device reset). */
export interface LoggedPayloadIndexGap {
  /** Payload index of the page immediately before the gap. */
  afterPayloadIndex: number;
  /** Payload index of the page immediately after the gap. */
  nextPayloadIndex: number;
  /** Number of missing payload indices (>= 1). */
  missing: number;
}

/**
 * Report gaps in the payload-index sequence of split pages. Payload indices are
 * expected to increase by exactly 1 per page; any larger step is a gap (dropped
 * pages) and any non-increasing step is flagged as a reset/wrap (`missing: 0`).
 */
export function findLoggedPayloadIndexGaps(
  pages: ReadonlyArray<Pick<LoggedPageSpan, 'payloadIndex'>>,
): LoggedPayloadIndexGap[] {
  const gaps: LoggedPayloadIndexGap[] = [];
  for (let i = 1; i < pages.length; i++) {
    const prev = pages[i - 1].payloadIndex;
    const cur = pages[i].payloadIndex;
    if (cur > prev + 1) {
      gaps.push({ afterPayloadIndex: prev, nextPayloadIndex: cur, missing: cur - prev - 1 });
    } else if (cur <= prev) {
      gaps.push({ afterPayloadIndex: prev, nextPayloadIndex: cur, missing: 0 });
    }
  }
  return gaps;
}

/** Verify a page's trailing CRC-16 (reuses {@link crc16_ccitt_false}). */
export function verifyLoggedPageCrc(page: Uint8Array): boolean {
  if (page.length < LOGGED_PAYLOAD_CRC_BYTES + 1) return false;
  const crcAt = page.length - LOGGED_PAYLOAD_CRC_BYTES;
  const claimed = (page[crcAt] | (page[crcAt + 1] << 8)) >>> 0;
  const calc = crc16_ccitt_false(page.subarray(0, crcAt));
  return calc === claimed;
}

// ---------------------------------------------------------------------------
// Sensor bank + config wiring
// ---------------------------------------------------------------------------

function buildSensorBank(opts: DecodeVerisenseLoggedDataOptions): Record<number, SensorBase> {
  const adc = new SensorADC();
  adc.setHardwareIdentifier(opts.hardwareIdentifier ?? 'VERISENSE_PULSE_PLUS');
  const bank: Record<number, SensorBase> = {
    1: adc,
    2: new SensorLIS2DW12(),
    3: new SensorLSM6DS3(),
    4: new SensorPPG(),
    6: new SensorLSM6DSV(),
    7: new SensorVD6283(),
    8: new SensorMAX32674(),
    9: new SensorMLX90632(),
  };

  const op =
    opts.operationalConfig == null
      ? null
      : opts.operationalConfig instanceof Uint8Array
        ? opts.operationalConfig
        : new Uint8Array(opts.operationalConfig);

  if (op) {
    for (const s of Object.values(bank)) {
      try {
        s.applyOperationalConfig(op);
      } catch {
        /* leave sensor at defaults if a field is missing */
      }
    }
  }

  const applyCal = opts.applyCalibration ?? opts.calibration != null;
  if (applyCal && opts.calibration) {
    for (const s of Object.values(bank)) {
      try {
        s.applyCalibration(opts.calibration);
      } catch {
        /* ignore sensors without calibration */
      }
    }
  } else if (opts.applyCalibration === false) {
    for (const s of Object.values(bank)) s.applyCalibration(null);
  }

  return bank;
}

const SENSOR_LABELS: Record<number, string> = {
  1: 'ADC (GSR/Battery)',
  2: 'LIS2DW12 Accel',
  3: 'LSM6DS3 Gyro/Accel',
  4: 'PPG',
  5: 'BIOZ',
  6: 'LSM6DSV Gyro/Accel/Mag',
  7: 'VD6283 Ambient Light',
  8: 'MAX32674 Algo',
  9: 'MLX90632 Skin Temp',
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Decode assembled Verisense logged-data bytes into per-sensor samples.
 *
 * Pure and transport-agnostic (browser/Node safe — no `navigator`/DOM). Reuses
 * the existing `Sensor*.parsePayload` decoders, calibration and `SensorBase`
 * timestamp logic; it only adds the flash-page container handling.
 *
 * @param bytes   Concatenated flash pages, e.g. `new Uint8Array(await result.blob.arrayBuffer())`.
 * @param options See {@link DecodeVerisenseLoggedDataOptions}.
 */
export function decodeVerisenseLoggedData(
  bytes: Uint8Array,
  options: DecodeVerisenseLoggedDataOptions = {},
): DecodeVerisenseLoggedDataResult {
  const payloadDesignVersion = options.payloadDesignVersion ?? 9;
  const footerLen = loggedFooterLength(payloadDesignVersion);
  const hasTicks = footerHasTicks(payloadDesignVersion);

  const op =
    options.operationalConfig == null
      ? null
      : options.operationalConfig instanceof Uint8Array
        ? options.operationalConfig
        : new Uint8Array(options.operationalConfig);

  const bank = buildSensorBank(options);
  const sensors: Record<number, DecodedLoggedSensor> = {};
  const footers: DecodedLoggedFooter[] = [];

  let samplesDecoded = 0;
  let pagesBad = 0;
  let recordsSkipped = 0;
  let pagesWithSkippedRecords = 0;
  let bytesUnattributed = 0;

  const split = splitVerisenseLoggedPages(bytes);

  for (const page of split.pages) {
    if (!verifyLoggedPageCrc(page.bytes)) {
      pagesBad += 1;
      continue;
    }

    // Detect extended config from PAYLOAD_CONFIG0 (first config byte).
    const configStart = LOGGED_PAYLOAD_INDEX_BYTES + LOGGED_PAYLOAD_LENGTH_BYTES;
    const config0 = page.bytes[configStart] ?? 0;
    const extended = (config0 & LOGGED_EXTENDED_CONFIG_BIT) !== 0;
    const configLen =
      options.payloadConfigLength ?? loggedPayloadConfigLength(payloadDesignVersion, extended);

    const dataStart = configStart + configLen;
    // Data blocks occupy everything up to the footer, which precedes the CRC.
    const dataEnd = page.bytes.length - LOGGED_PAYLOAD_CRC_BYTES - footerLen;

    let pageSkipped = false;
    if (dataEnd >= dataStart) {
      let cursor = dataStart;
      while (cursor + LOGGED_DATABLOCK_HEADER_BYTES <= dataEnd) {
        const sensorId = page.bytes[cursor];
        const tick = u24le(page.bytes, cursor + 1);
        const blockSize = resolveLoggedBlockSize(sensorId, op, options.blockSizes);

        if (blockSize == null || blockSize <= 0) {
          // Cannot size this block → cannot safely advance within the page.
          recordsSkipped += 1;
          pageSkipped = true;
          break;
        }

        const bodyStart = cursor + LOGGED_DATABLOCK_HEADER_BYTES;
        const bodyEnd = bodyStart + blockSize;
        if (bodyEnd > dataEnd) {
          // Declared block overruns the data region → size mismatch; do not guess.
          recordsSkipped += 1;
          pageSkipped = true;
          break;
        }

        const sensor = bank[sensorId];
        if (!sensor) {
          recordsSkipped += 1;
          cursor = bodyEnd;
          continue;
        }

        const body = page.bytes.subarray(bodyStart, bodyEnd);
        let decoded: unknown[];
        try {
          decoded = sensor.parsePayload(body) as unknown[];
        } catch {
          recordsSkipped += 1;
          cursor = bodyEnd;
          continue;
        }

        // Reuse the live-stream timestamp reconstruction: the u24 tick is the
        // end-of-block sample tick, exactly as in _handleStreamingPayload.
        let withTime: unknown[] = decoded;
        if (Array.isArray(decoded) && decoded.length > 0) {
          const tsInfo = sensor.getTimestampUnwrappedMillis(tick, 0);
          const tsArray = sensor.computeSampleTimestamps(decoded, {
            tsLastSampleMillis: tsInfo.shimmerMillis,
            systemTsLastSampleMillis: 0,
            systemOffsetFirstTime: tsInfo.systemOffsetFirstTime,
          });
          withTime = decoded.map((s, i) => ({ ...(s as object), timestamps: tsArray[i] }));
        }

        const entry = (sensors[sensorId] ??= {
          sensorId,
          label: SENSOR_LABELS[sensorId] ?? `Sensor ${sensorId}`,
          samples: [],
          samplesDecoded: 0,
          blocks: 0,
        });
        for (const s of withTime) entry.samples.push(s);
        entry.samplesDecoded += withTime.length;
        entry.blocks += 1;
        samplesDecoded += withTime.length;

        cursor = bodyEnd;
      }

      // Anti-guess boundary check: a clean walk must land exactly on the footer
      // boundary. Any shortfall means the resolved footer/config length is wrong
      // for this capture; count the tail rather than mis-decode it.
      if (!pageSkipped && cursor < dataEnd) {
        bytesUnattributed += dataEnd - cursor;
        pageSkipped = true;
      }
    }

    if (pageSkipped) pagesWithSkippedRecords += 1;

    footers.push(
      parseFooter(page.bytes, dataEnd, hasTicks, payloadDesignVersion, page.payloadIndex),
    );
  }

  return {
    sensors,
    samplesDecoded,
    pagesTotal: split.pages.length,
    pagesBad,
    pagesWithSkippedRecords,
    recordsSkipped,
    bytesUnattributed,
    truncatedTrailingPage: split.truncatedTrailingPage,
    trailingByteCount: split.trailingByteCount,
    footers,
    payloadIndexGaps: findLoggedPayloadIndexGaps(split.pages),
  };
}

/** Parse the page footer (RTC minutes/ticks + temperature + battery). */
function parseFooter(
  page: Uint8Array,
  footerStart: number,
  hasTicks: boolean,
  payloadDesignVersion: number,
  payloadIndex: number,
): DecodedLoggedFooter {
  const footer: DecodedLoggedFooter = {
    payloadIndex,
    rtcMinutes: null,
    rtcTicks: null,
    rtcEndMillis: null,
    temperatureRaw: null,
    batteryRaw: null,
  };
  if (footerStart < 0 || footerStart + loggedFooterLength(payloadDesignVersion) > page.length) {
    return footer;
  }

  let p = footerStart;
  // RTC minutes: 4-byte LE.
  footer.rtcMinutes =
    (page[p] | (page[p + 1] << 8) | (page[p + 2] << 16) | (page[p + 3] << 24)) >>> 0;
  p += 4;
  if (hasTicks) {
    footer.rtcTicks = u24le(page, p);
    p += 3;
  }
  footer.temperatureRaw = i16le(page, p);
  p += 2;
  footer.batteryRaw = u16le_at(page, p) & 0x0fff;

  if (footer.rtcMinutes != null) {
    const ticks = footer.rtcTicks ?? 0;
    footer.rtcEndMillis = (footer.rtcMinutes * 60 + ticks / LOGGED_TICKS_PER_SECOND) * 1000;
  }
  return footer;
}
