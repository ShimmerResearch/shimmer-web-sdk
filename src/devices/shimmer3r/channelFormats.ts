/**
 * Channel format descriptor for a single Shimmer3 / Shimmer3R data channel.
 */
export interface ChannelFormat {
  /** Human-readable signal name stored in ObjectCluster fields. */
  name: string;
  /** Encoding format: i16, u16, i24, u24, i12*, u8. */
  fmt: 'i16' | 'u16' | 'i24' | 'u24' | 'i12*' | 'u8';
  /** Byte order for multi-byte values. */
  endian: 'le' | 'be';
  /** Number of bytes this channel occupies in the packet. */
  sizeBytes: number;
}

/**
 * Which hardware family a channel list came from.
 *
 * The channel ID byte is *not* self-describing: the same ID can mean a
 * different signal, and occupy a different number of bytes, on the two
 * generations. See {@link resolveChannelFormat}.
 */
export type ShimmerGeneration = 'shimmer3' | 'shimmer3r';

/** `ShimmerVerDetails.HW_ID` values that map onto a {@link ShimmerGeneration}. */
const HW_ID_SHIMMER_3 = 3;
const HW_ID_SHIMMER_3R = 10;

/**
 * Map a DEVICE_VERSION_RESPONSE hardware id onto a generation, or `null` when
 * the id is unknown/absent (the caller then has to pick a default and say so —
 * see `Shimmer3RClient.generation`).
 */
export function generationFromHardwareVersion(
  hardwareVersion: number | null | undefined,
): ShimmerGeneration | null {
  if (hardwareVersion === HW_ID_SHIMMER_3) return 'shimmer3';
  if (hardwareVersion === HW_ID_SHIMMER_3R) return 'shimmer3r';
  return null;
}

/**
 * Mapping from channel ID byte to its format descriptor, for the channels
 * whose name, width and encoding are **identical on Shimmer3 and Shimmer3R**.
 * Channel IDs are reported in the INQUIRY_RSP payload.
 *
 * This is the base layer of a two-layer table. Prefer
 * {@link channelFormatsFor} or {@link resolveChannelFormat}, which apply the
 * per-generation layer on top — a lookup straight into this map silently
 * misses every channel in {@link CHANNEL_FORMAT_OVERRIDES}, including the
 * pressure/temperature pair whose *width* differs between the generations.
 *
 * Two entries are kept generation-independent for API stability even though
 * the firmware names them differently on each platform:
 *
 * - `0x12` → `PPG`. The firmware calls it `INTERNAL_ADC_13` on a Shimmer3 and
 *   `INTERNAL_ADC_1` on a Shimmer3R (`shimmer_sensing.h:107-122`); it is the
 *   internal ADC line the optical front end sits on, and `PPG` is the name
 *   this SDK has always emitted for it. Width and encoding are the same on
 *   both, so nothing decodes wrongly — only the label is platform-neutral.
 * - `0x14`-`0x16` → `HG_ACCEL_*`. The firmware calls these `X/Y/Z_ALT_ACCEL`.
 */
export const CHANNEL_FORMATS: Readonly<Record<number, ChannelFormat>> = Object.freeze({
  0x00: { name: 'LN_ACCEL_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x01: { name: 'LN_ACCEL_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x02: { name: 'LN_ACCEL_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  // Battery is a 12-bit ADC reading right-aligned in two little-endian bytes,
  // so `u16` decodes it losslessly and can never invent a negative value. (The
  // Java driver types it `i16` on a Shimmer3 and `u12` on a Shimmer3R, and the
  // SD-log path ported that `i16` verbatim — see the HARDWARE-VERIFY note on
  // `sdlog/channels.ts` 0x03. Both agree with `u16` over the 0-4095 range the
  // ADC can actually produce.)
  0x03: { name: 'BATTERY', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x04: { name: 'WR_ACCEL_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x05: { name: 'WR_ACCEL_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x06: { name: 'WR_ACCEL_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x14: { name: 'HG_ACCEL_X', fmt: 'i12*', endian: 'le', sizeBytes: 2 },
  0x15: { name: 'HG_ACCEL_Y', fmt: 'i12*', endian: 'le', sizeBytes: 2 },
  0x16: { name: 'HG_ACCEL_Z', fmt: 'i12*', endian: 'le', sizeBytes: 2 },
  0x17: { name: 'ALT_MAG_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x18: { name: 'ALT_MAG_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x19: { name: 'ALT_MAG_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x0a: { name: 'GYRO_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x0b: { name: 'GYRO_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x0c: { name: 'GYRO_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x07: { name: 'MAG_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x08: { name: 'MAG_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x09: { name: 'MAG_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x1d: { name: 'Exg1_Status', fmt: 'u8', endian: 'le', sizeBytes: 1 },
  0x20: { name: 'Exg2_Status', fmt: 'u8', endian: 'le', sizeBytes: 1 },
  0x1e: { name: 'Exg1_CH1_24Bit', fmt: 'i24', endian: 'be', sizeBytes: 3 },
  0x1f: { name: 'Exg1_CH2_24Bit', fmt: 'i24', endian: 'be', sizeBytes: 3 },
  0x21: { name: 'Exg2_CH1_24Bit', fmt: 'i24', endian: 'be', sizeBytes: 3 },
  0x22: { name: 'Exg2_CH2_24Bit', fmt: 'i24', endian: 'be', sizeBytes: 3 },
  0x23: { name: 'Exg1_CH1_16Bit', fmt: 'i16', endian: 'be', sizeBytes: 2 },
  0x24: { name: 'Exg1_CH2_16Bit', fmt: 'i16', endian: 'be', sizeBytes: 2 },
  0x25: { name: 'Exg2_CH1_16Bit', fmt: 'i16', endian: 'be', sizeBytes: 2 },
  0x26: { name: 'Exg2_CH2_16Bit', fmt: 'i16', endian: 'be', sizeBytes: 2 },
  0x12: { name: 'PPG', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x1c: { name: 'GSR', fmt: 'u16', endian: 'le', sizeBytes: 2 },
});

/** Shimmer3-only layer of {@link CHANNEL_FORMAT_OVERRIDES}. */
const SHIMMER3_CHANNEL_FORMATS: Readonly<Record<number, ChannelFormat>> = Object.freeze({
  0x0d: { name: 'EXT_EXP_ADC_A7', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x0e: { name: 'EXT_EXP_ADC_A6', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x0f: { name: 'EXT_EXP_ADC_A15', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x10: { name: 'INT_EXP_ADC_A1', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x11: { name: 'INT_EXP_ADC_A12', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x13: { name: 'INT_EXP_ADC_A14', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x1a: { name: 'TEMPERATURE', fmt: 'u16', endian: 'be', sizeBytes: 2 },
  0x1b: { name: 'PRESSURE', fmt: 'u24', endian: 'be', sizeBytes: 3 },
  0x27: { name: 'BRIDGE_AMP_HIGH', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x28: { name: 'BRIDGE_AMP_LOW', fmt: 'u16', endian: 'le', sizeBytes: 2 },
});

/** Shimmer3R-only layer of {@link CHANNEL_FORMAT_OVERRIDES}. */
const SHIMMER3R_CHANNEL_FORMATS: Readonly<Record<number, ChannelFormat>> = Object.freeze({
  0x0d: { name: 'EXT_ADC_0', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x0e: { name: 'EXT_ADC_1', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x0f: { name: 'EXT_ADC_2', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x10: { name: 'INT_ADC_3', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x11: { name: 'INT_ADC_0', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x13: { name: 'INT_ADC_2', fmt: 'u16', endian: 'le', sizeBytes: 2 },
  0x1a: { name: 'TEMPERATURE', fmt: 'u24', endian: 'le', sizeBytes: 3 },
  0x1b: { name: 'PRESSURE', fmt: 'u24', endian: 'le', sizeBytes: 3 },
});

/**
 * Per-generation channel table, layered over {@link CHANNEL_FORMATS}.
 *
 * Two kinds of entry live here, and only one of them is cosmetic:
 *
 * 1. **The ADC block, `0x0D`-`0x13`.** The IDs are reused with different
 *    meanings on the two platforms — `shimmer_sensing.h:107-122` defines
 *    `EXTERNAL_ADC_7/6/15` and `INTERNAL_ADC_1/12/13/14` under
 *    `#elif defined(SHIMMER3)` and `EXTERNAL_ADC_0/1/2` +
 *    `INTERNAL_ADC_3/0/1/2` under `#if defined(SHIMMER3R)`. All are 2 bytes
 *    little-endian on both, so picking the wrong platform costs a wrong
 *    *label*, not a wrong number.
 * 2. **`0x1A` BMP_TEMPERATURE and `0x1B` BMP_PRESSURE.** These differ in
 *    **width and byte order**, which is what makes the table generation-aware
 *    rather than merely generation-labelled:
 *
 *    - Shimmer3 carries a BMP180/BMP280 read over I²C, MSB first:
 *      2 big-endian bytes of temperature followed by 3 big-endian bytes of
 *      pressure (`LogAndStream_Shimmer3/i2c.c:389-394` emits
 *      `BMP_TEMPERATURE` then `BMP_PRESSURE` and advances `sensing.dataLen`
 *      by `BMPX80_PACKET_SIZE`, which `Shimmer_Driver/BMPX80/bmpX80.h:103-105`
 *      defines as `BMPX80_TEMP_BUFF_SIZE 0x02 + BMPX80_PRESS_BUFF_SIZE 0x03`).
 *    - Shimmer3R carries a BMP390/BMP581 read over SPI, LSB first: 3
 *      little-endian bytes each, **pressure first**
 *      (`LogAndStream_Shimmer3R/Core/Src/spi.c:739-756`, the
 *      `#if defined(SHIMMER3R)` arm, `sensing.dataLen += 3` twice).
 *
 *    So enabling the stock pressure sensor makes a Shimmer3 packet 1 byte and
 *    a Shimmer3R packet 2 bytes longer than a 2-bytes-per-channel assumption
 *    predicts, and every channel after pressure decodes from the wrong offset.
 *    The emission *order* of the pair is also reversed between the two
 *    generations, which is why a host must always take the channel order from
 *    the inquiry response rather than from a fixed list of its own.
 * 3. **`0x27`/`0x28` STRAIN_HIGH/STRAIN_LOW.** Shimmer3-only: the bridge
 *    amplifier is an expansion board with no Shimmer3R equivalent, so these
 *    are deliberately absent from the `shimmer3r` table and a Shimmer3R
 *    reporting them is reported as an unknown channel rather than guessed at.
 *
 * Names follow the SD-log channel tables in `devices/sdlog/channels.ts` so the
 * streamed and logged copies of the same signal carry the same label. The one
 * exception is the BMP pair: the SD-log header names the exact part
 * (`TEMPERATURE_BMP390`, `PRESSURE_BMP280`) because it records it, whereas the
 * inquiry response does not say which sensor is fitted, so the streaming names
 * stay unqualified.
 *
 * The ADC block's Shimmer3R names are the firmware's logical indices
 * (`EXTERNAL_ADC_0`…), which is what `devices/sdlog/channels.ts` already uses.
 * The Java driver instead names the same channels after the STM32 ADC lines
 * they sit on — `ExtAdc9`/`ExtAdc11`/`ExtAdc12`, `IntAdc17`/`IntAdc10`/
 * `IntAdc16` (`Configuration.java:594-601`, a second block of constants for the
 * same ID values) — so a Shimmer3R CSV from the Java tools labels these columns
 * differently. Same channel, same bytes, different vocabulary.
 *
 * HARDWARE-VERIFY: every width and byte order here is read out of the firmware
 * sources cited above and pinned by unit tests, but no packet from a real sensor
 * with pressure/temperature enabled has been decoded yet, on either generation.
 * The endianness in particular is inferred from the sensors' register order
 * (BMP180/BMP280 burst MSB first over I²C; BMP390/BMP581 LSB first over SPI)
 * and agrees with the Java driver's `u16r`/`u24r` vs `u24` type strings.
 */
export const CHANNEL_FORMAT_OVERRIDES: Readonly<
  Record<ShimmerGeneration, Readonly<Record<number, ChannelFormat>>>
> = Object.freeze({
  shimmer3: SHIMMER3_CHANNEL_FORMATS,
  shimmer3r: SHIMMER3R_CHANNEL_FORMATS,
});

const RESOLVED: Record<ShimmerGeneration, Readonly<Record<number, ChannelFormat>>> = {
  shimmer3: Object.freeze({ ...CHANNEL_FORMATS, ...CHANNEL_FORMAT_OVERRIDES.shimmer3 }),
  shimmer3r: Object.freeze({ ...CHANNEL_FORMATS, ...CHANNEL_FORMAT_OVERRIDES.shimmer3r }),
};

/**
 * The complete channel table for one hardware generation: every entry of
 * {@link CHANNEL_FORMATS} with {@link CHANNEL_FORMAT_OVERRIDES} applied on top.
 *
 * Frozen and pre-built, so this is a lookup rather than a merge per call.
 */
export function channelFormatsFor(
  generation: ShimmerGeneration,
): Readonly<Record<number, ChannelFormat>> {
  return RESOLVED[generation];
}

/**
 * Resolve one channel ID for one generation, or `undefined` when this SDK has
 * no description for it.
 *
 * `undefined` is the honest answer and callers must treat it as one: a channel
 * whose width is unknown makes the offset of every channel *after* it in the
 * packet unknown too, because the packet carries no per-channel length. Never
 * substitute a guessed width silently — see how
 * `Shimmer3RClient._buildSchemaFromChannels` and `buildShimmer3Schema` flag it.
 */
export function resolveChannelFormat(
  id: number,
  generation: ShimmerGeneration,
): ChannelFormat | undefined {
  return RESOLVED[generation][id];
}

/**
 * True when this channel ID is described differently on the two generations, by
 * label, by layout, or by existing on only one of them.
 *
 * This is the broad question, and a true answer is **not** on its own a reason
 * to distrust a frame: across most of the ADC block the difference is the
 * channel's *name* only. Use {@link channelLayoutDiffersByGeneration} for the
 * narrower question of whether the bytes would actually be misread.
 */
export function isGenerationSensitiveChannel(id: number): boolean {
  return (
    CHANNEL_FORMAT_OVERRIDES.shimmer3[id] !== undefined ||
    CHANNEL_FORMAT_OVERRIDES.shimmer3r[id] !== undefined
  );
}

/**
 * True when assuming the wrong generation for this channel ID would **misread**
 * the bytes rather than merely mislabel them: the width, the byte order, or
 * whether the channel exists at all differs between the two generations.
 *
 * This is the predicate that gates `StreamSchema.trusted`, and it is
 * deliberately narrower than {@link isGenerationSensitiveChannel}:
 *
 * - `0x1A`/`0x1B` qualify — 2 big-endian bytes then 3 on a Shimmer3 versus 3
 *   little-endian bytes each on a Shimmer3R, emitted in the opposite order.
 * - The Shimmer3-only `0x27`/`0x28` qualify, because they resolve to nothing at
 *   all on a Shimmer3R, so assuming the wrong way either invents a width or
 *   loses one.
 * - The ADC block `0x0D`-`0x13` does **not** qualify: `u16`, little-endian, 2
 *   bytes on both generations, so guessing wrong costs a column heading rather
 *   than a number.
 *
 * Compares the *resolved* formats, not the override layers, so a channel that
 * one generation overrides back to the same layout as the shared
 * {@link CHANNEL_FORMATS} entry is correctly reported as layout-identical.
 */
export function channelLayoutDiffersByGeneration(id: number): boolean {
  const s3 = resolveChannelFormat(id, 'shimmer3');
  const s3r = resolveChannelFormat(id, 'shimmer3r');
  if (s3 === undefined && s3r === undefined) return false;
  if (s3 === undefined || s3r === undefined) return true;
  return s3.fmt !== s3r.fmt || s3.endian !== s3r.endian || s3.sizeBytes !== s3r.sizeBytes;
}

/**
 * The width assumed for a channel ID this SDK cannot describe.
 *
 * Two bytes is the commonest width by far, so it is the least-bad guess and it
 * keeps a packet with one unfamiliar channel decodable instead of undecodable.
 * It is only ever a guess, though: when a schema uses it, the schema is marked
 * untrustworthy (`StreamSchema.trusted === false`, the offending IDs listed in
 * `unknownChannelIds`) and every field from the guess onwards is marked
 * `offsetTrusted: false`. A host seeing that should treat those fields as
 * unusable and update the SDK, not publish the numbers.
 */
export const UNKNOWN_CHANNEL_ASSUMED_BYTES = 2;
