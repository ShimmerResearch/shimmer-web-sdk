import { describe, it, expect } from 'vitest';
import {
  interpretShimmer3InquiryResponse,
  buildShimmer3Schema,
  parseShimmer3DeviceVersionResponse,
  parseShimmer3FwVersionResponse,
  shimmer3UsesThreeByteTimestamp,
  shimmer3ControlMessageLength,
  deriveShimmer3FirmwareVersionCode,
  shimmer3SupportsExg,
  FW_ID,
  ACK,
  NACK,
  NEED_MORE,
  RESYNC,
} from '../../src/devices/shimmer3/protocol.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { SensorBitmapShimmer3 } from '../../src/devices/shimmer3r/SensorBitmap.js';

// A realistic classic-Shimmer3 INQUIRY_RESPONSE, constructed from the Java layout
// (ShimmerObject#interpretInqResponse, HW_ID.SHIMMER_3 branch — opcode-inclusive):
//   [0]    0x02 INQUIRY_RESPONSE
//   [1..2] rate divisor LE16 = 0x0280 = 640  -> 32768/640 = 51.2 Hz
//   [3..6] config word LE32 = 0x05000000     -> expPower bit24=1, gsrRange bits25-27=2
//   [7]    numChannels = 3
//   [8]    bufferSize  = 1
//   [9..]  channel IDs 0x0a/0x0b/0x0c = GYRO X/Y/Z
const INQ_RSP = OPCODES.INQUIRY_RESPONSE; // 0x02
const INQUIRY_MSG = [INQ_RSP, 0x80, 0x02, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x0a, 0x0b, 0x0c];

describe('interpretShimmer3InquiryResponse (Shimmer3 4-byte-config layout)', () => {
  it('decodes rate, config bits, channels and schema', () => {
    const info = interpretShimmer3InquiryResponse(new Uint8Array(INQUIRY_MSG), 'u24');
    expect(info.adcRaw).toBe(640);
    expect(info.samplingRateHz).toBeCloseTo(51.2, 5);
    expect(info.configByte0).toBe(0x05000000);
    expect(info.internalExpPower).toBe(1);
    expect(info.gsrRange).toBe(2);
    expect(info.numChannels).toBe(3);
    expect(info.bufferSize).toBe(1);
    expect(info.channelIds).toEqual([0x0a, 0x0b, 0x0c]);
    expect(info.schema.enabledSensors).toBe(SensorBitmapShimmer3.SENSOR_GYRO);
    // frame = 1 (preamble) + 3 (u24 ts) + 3*2 (gyro) = 10 bytes
    expect(info.schema.frameBytes).toBe(10);
  });

  it('accepts a body without the leading opcode', () => {
    const info = interpretShimmer3InquiryResponse(new Uint8Array(INQUIRY_MSG.slice(1)), 'u24');
    expect(info.channelIds).toEqual([0x0a, 0x0b, 0x0c]);
    expect(info.samplingRateHz).toBeCloseTo(51.2, 5);
  });

  it('does NOT match the Shimmer3R layout (config width differs)', () => {
    // If the same bytes were parsed as Shimmer3R (7-byte config, numCh at [10]),
    // the channel list would be wrong — this pins the layout difference.
    const info = interpretShimmer3InquiryResponse(new Uint8Array(INQUIRY_MSG), 'u24');
    // numChannels is read from index 7 (=3), not index 10 (=0x0a).
    expect(info.numChannels).toBe(3);
  });
});

describe('buildShimmer3Schema', () => {
  it('maps GSR + accel channels and sizes a u16 frame', () => {
    // LN accel X/Y/Z (0x00-0x02) + GSR (0x1c), u16 timestamp
    const schema = buildShimmer3Schema([0x00, 0x01, 0x02, 0x1c], 'u16');
    expect(schema.timestampFmt).toBe('u16');
    // 1 preamble + 2 ts + 3*2 accel + 2 gsr = 11
    expect(schema.frameBytes).toBe(11);
    expect(schema.enabledSensors).toBe(
      SensorBitmapShimmer3.SENSOR_A_ACCEL | SensorBitmapShimmer3.SENSOR_GSR,
    );
    expect(schema.fields.map((f) => f.name)).toContain('GSR');
  });

  it('is fixed to the Shimmer3 generation — never assumed, never in doubt', () => {
    const schema = buildShimmer3Schema([0x00, 0x1c], 'u24');
    expect(schema.generation).toBe('shimmer3');
    expect(schema.generationAssumed).toBe(false);
    expect(schema.trusted).toBe(true);
    expect(schema.unknownChannelIds).toEqual([]);
  });

  // The corruption this whole change is about, on the classic path. BMPX80 over
  // I2C: BMP_TEMPERATURE is 2 big-endian bytes and BMP_PRESSURE 3
  // (bmpX80.h:103-105, BMPX80_PACKET_SIZE = 0x02 + 0x03), emitted in that order
  // (i2c.c:389-394). A 2-bytes-per-unknown-channel assumption makes the packet
  // one byte shorter than the firmware's and shifts everything after pressure.
  it('sizes the BMPX80 pressure pair the way the firmware packs it', () => {
    const schema = buildShimmer3Schema([0x1a, 0x1b, 0x1c], 'u24');
    expect(schema.fields.map((f) => [f.name, f.fmt, f.endian, f.sizeBytes])).toEqual([
      ['TEMPERATURE', 'u16', 'be', 2],
      ['PRESSURE', 'u24', 'be', 3],
      ['GSR', 'u16', 'le', 2],
    ]);
    // 1 preamble + 3 ts + 2 + 3 + 2 = 11. The old fallback said 10.
    expect(schema.frameBytes).toBe(11);
    expect(schema.frameBytes).not.toBe(10);
    expect(schema.enabledSensors).toBe(
      SensorBitmapShimmer3.SENSOR_PRESSURE | SensorBitmapShimmer3.SENSOR_GSR,
    );
  });

  it('names the Shimmer3 expansion ADC lines, not the Shimmer3R ones', () => {
    const schema = buildShimmer3Schema([0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13], 'u24');
    expect(schema.fields.map((f) => f.name)).toEqual([
      'EXT_EXP_ADC_A7',
      'EXT_EXP_ADC_A6',
      'EXT_EXP_ADC_A15',
      'INT_EXP_ADC_A1',
      'INT_EXP_ADC_A12',
      'INT_EXP_ADC_A14',
    ]);
    expect(schema.frameBytes).toBe(4 + 6 * 2);
  });

  it('describes battery, alt mag and the bridge amplifier', () => {
    const schema = buildShimmer3Schema([0x03, 0x17, 0x18, 0x19, 0x27, 0x28], 'u24');
    expect(schema.fields.map((f) => f.name)).toEqual([
      'BATTERY',
      'ALT_MAG_X',
      'ALT_MAG_Y',
      'ALT_MAG_Z',
      'BRIDGE_AMP_HIGH',
      'BRIDGE_AMP_LOW',
    ]);
    expect(schema.enabledSensors).toBe(
      SensorBitmapShimmer3.SENSOR_VBATT |
        SensorBitmapShimmer3.SENSOR_MAG_ALT |
        SensorBitmapShimmer3.SENSOR_BRIDGE_AMP,
    );
  });

  it('is loud about a channel ID it cannot describe, and says which fields to distrust', () => {
    const problems: string[] = [];
    const schema = buildShimmer3Schema([0x00, 0x3f, 0x1c], 'u24', (m) => problems.push(m));
    expect(schema.trusted).toBe(false);
    expect(schema.unknownChannelIds).toEqual([0x3f]);
    expect(schema.fields.map((f) => [f.name, f.offsetTrusted])).toEqual([
      ['LN_ACCEL_X', true],
      ['CH_3F', true],
      ['GSR', false],
    ]);
    expect(schema.fields[1].assumed).toBe(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('0x3F');
  });

  it('threads the problem sink through the inquiry decoder', () => {
    const problems: string[] = [];
    // Same layout as INQUIRY_MSG but with an undescribed channel in the list.
    const msg = [INQ_RSP, 0x80, 0x02, 0, 0, 0, 0, 0x02, 0x01, 0x0a, 0x3f];
    const info = interpretShimmer3InquiryResponse(new Uint8Array(msg), 'u24', (m) =>
      problems.push(m),
    );
    expect(info.schema.trusted).toBe(false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('0x3F');
  });
});

describe('handshake response decoders', () => {
  it('parses DEVICE_VERSION_RESPONSE (HW version)', () => {
    expect(parseShimmer3DeviceVersionResponse(new Uint8Array([0x25, 3])).hardwareVersion).toBe(3);
    // opcode-stripped form
    expect(parseShimmer3DeviceVersionResponse(new Uint8Array([10])).hardwareVersion).toBe(10);
  });

  it('parses FW_VERSION_RESPONSE (LE id/major, byte minor/internal)', () => {
    // LogAndStream 0.15.4: id=3 (LE16), major=0 (LE16), minor=15, internal=4
    const fw = parseShimmer3FwVersionResponse(new Uint8Array([0x2f, 3, 0, 0, 0, 15, 4]));
    expect(fw.firmwareIdentifier).toBe(FW_ID.LOGANDSTREAM);
    expect(fw.major).toBe(0);
    expect(fw.minor).toBe(15);
    expect(fw.internal).toBe(4);
  });
});

describe('shimmer3UsesThreeByteTimestamp (fwCode>=6 threshold)', () => {
  it('LogAndStream >= 0.5.4 uses u24, older uses u16', () => {
    expect(
      shimmer3UsesThreeByteTimestamp({
        firmwareIdentifier: FW_ID.LOGANDSTREAM,
        major: 0,
        minor: 15,
        internal: 0,
      }),
    ).toBe(true);
    expect(
      shimmer3UsesThreeByteTimestamp({
        firmwareIdentifier: FW_ID.LOGANDSTREAM,
        major: 0,
        minor: 5,
        internal: 4,
      }),
    ).toBe(true);
    expect(
      shimmer3UsesThreeByteTimestamp({
        firmwareIdentifier: FW_ID.LOGANDSTREAM,
        major: 0,
        minor: 5,
        internal: 3,
      }),
    ).toBe(false);
  });

  it('BtStream threshold is 0.7.3', () => {
    expect(
      shimmer3UsesThreeByteTimestamp({
        firmwareIdentifier: FW_ID.BTSTREAM,
        major: 0,
        minor: 7,
        internal: 3,
      }),
    ).toBe(true);
    expect(
      shimmer3UsesThreeByteTimestamp({
        firmwareIdentifier: FW_ID.BTSTREAM,
        major: 0,
        minor: 7,
        internal: 2,
      }),
    ).toBe(false);
  });
});

describe('shimmer3ControlMessageLength (unframed-stream framing primitive)', () => {
  it('ACK / NACK are single-byte messages', () => {
    expect(shimmer3ControlMessageLength(new Uint8Array([ACK]))).toBe(1);
    expect(shimmer3ControlMessageLength(new Uint8Array([NACK]))).toBe(1);
  });

  it('fixed-length responses report opcode + payload length', () => {
    expect(shimmer3ControlMessageLength(new Uint8Array([OPCODES.DEVICE_VERSION_RESPONSE]))).toBe(2);
    expect(shimmer3ControlMessageLength(new Uint8Array([OPCODES.FW_VERSION_RESPONSE]))).toBe(7);
    expect(shimmer3ControlMessageLength(new Uint8Array([OPCODES.SAMPLING_RATE_RESPONSE]))).toBe(3);
  });

  it('INQUIRY_RESPONSE needs numChannels (index 7) before length is known', () => {
    // Only 7 bytes -> numChannels byte not present yet.
    expect(shimmer3ControlMessageLength(new Uint8Array(INQUIRY_MSG.slice(0, 7)))).toBe(NEED_MORE);
    // 8 bytes -> numChannels=3 readable -> total 9 + 3 = 12.
    expect(shimmer3ControlMessageLength(new Uint8Array(INQUIRY_MSG.slice(0, 8)))).toBe(12);
    expect(shimmer3ControlMessageLength(new Uint8Array(INQUIRY_MSG))).toBe(12);
  });

  it('unknown leading opcode signals RESYNC', () => {
    expect(shimmer3ControlMessageLength(new Uint8Array([0xde]))).toBe(RESYNC);
  });

  it('INQUIRY_RESPONSE with an implausible numChannels resyncs (stray 0x02 guard)', () => {
    // A stray stream-data byte 0x02 mid-buffer would otherwise be framed as an
    // INQUIRY_RESPONSE whose numChannels comes from garbage, swallowing real
    // control bytes. numChannels=129 (the live-capture value) → 138-byte frame
    // pre-fix; now bounded to resync.
    const bogus = new Uint8Array([INQ_RSP, 0, 0, 0, 0, 0, 0, 129, 0, 0]);
    expect(shimmer3ControlMessageLength(bogus)).toBe(RESYNC);
    // The boundary: 32 channels is accepted (9 + 32 = 41); 33 resyncs.
    const at32 = new Uint8Array([INQ_RSP, 0, 0, 0, 0, 0, 0, 32, 0, 0]);
    expect(shimmer3ControlMessageLength(at32)).toBe(41);
    const at33 = new Uint8Array([INQ_RSP, 0, 0, 0, 0, 0, 0, 33, 0, 0]);
    expect(shimmer3ControlMessageLength(at33)).toBe(RESYNC);
  });

  it('empty buffer needs more', () => {
    expect(shimmer3ControlMessageLength(new Uint8Array([]))).toBe(NEED_MORE);
  });

  it('EXG_REGS_RESPONSE length comes from its own count byte', () => {
    const rsp = OPCODES.EXG_REGS_RESPONSE; // 0x62
    // The count byte is not there yet.
    expect(shimmer3ControlMessageLength(new Uint8Array([rsp]))).toBe(NEED_MORE);
    // A full bank: [0x62][10][reg0..reg9] = 12 bytes, known from 2 bytes in.
    expect(shimmer3ControlMessageLength(new Uint8Array([rsp, 10]))).toBe(12);
    expect(shimmer3ControlMessageLength(new Uint8Array([rsp, 10, ...new Array(10).fill(0)]))).toBe(
      12,
    );
    // A short read is self-describing too.
    expect(shimmer3ControlMessageLength(new Uint8Array([rsp, 3, 1, 2, 3]))).toBe(5);
    // A count above one bank cannot be real — resync rather than swallow it.
    expect(shimmer3ControlMessageLength(new Uint8Array([rsp, 11]))).toBe(RESYNC);
    expect(shimmer3ControlMessageLength(new Uint8Array([rsp, 0xff]))).toBe(RESYNC);
  });
});

describe('deriveShimmer3FirmwareVersionCode (ShimmerVerObject ladder)', () => {
  const fw = (id: number, major: number, minor: number, internal: number) => ({
    firmwareIdentifier: id,
    major,
    minor,
    internal,
  });

  it('places each rung at the Java threshold', () => {
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.LOGANDSTREAM, 0, 16, 6), 3)).toBe(9);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.LOGANDSTREAM, 0, 16, 5), 3)).toBe(8);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.LOGANDSTREAM, 0, 13, 7), 3)).toBe(8);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.LOGANDSTREAM, 0, 13, 6), 3)).toBe(7);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.SDLOG, 0, 20, 1), 3)).toBe(8);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.LOGANDSTREAM, 0, 6, 5), 3)).toBe(7);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.BTSTREAM, 0, 7, 3), 3)).toBe(6);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.SDLOG, 0, 11, 5), 3)).toBe(6);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.BTSTREAM, 0, 5, 0), 3)).toBe(5);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.BTSTREAM, 0, 4, 0), 3)).toBe(4);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.BTSTREAM, 0, 3, 0), 3)).toBe(3);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.BTSTREAM, 0, 2, 0), 3)).toBe(2);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.BTSTREAM, 0, 1, 0), 3)).toBe(1);
    // Shimmer2R BtStream 1.2.0 is the other code-1 rung.
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.BTSTREAM, 1, 2, 0), 2)).toBe(1);
  });

  it('is hardware-id gated: a Shimmer3R rung never matches a Shimmer3', () => {
    // LogAndStream 0.0.1 on a 3R is code 8; on a Shimmer3 no rung matches.
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.LOGANDSTREAM, 0, 0, 1), 10)).toBe(8);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.LOGANDSTREAM, 0, 0, 1), 3)).toBe(-1);
  });

  it('returns -1 below every rung', () => {
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.BTSTREAM, 0, 0, 9), 3)).toBe(-1);
    expect(deriveShimmer3FirmwareVersionCode(fw(FW_ID.LOGANDSTREAM, 0, 0, 0), 3)).toBe(-1);
  });
});

describe('shimmer3SupportsExg (the Java ExG command gate)', () => {
  const fw = (id: number, major: number, minor: number, internal: number) => ({
    firmwareIdentifier: id,
    major,
    minor,
    internal,
  });

  it('accepts every code > 2', () => {
    expect(shimmer3SupportsExg(fw(FW_ID.LOGANDSTREAM, 0, 15, 0), 3)).toBe(true); // code 8
    expect(shimmer3SupportsExg(fw(FW_ID.BTSTREAM, 0, 3, 0), 3)).toBe(true); // code 3
    expect(shimmer3SupportsExg(fw(FW_ID.LOGANDSTREAM, 0, 0, 1), 10)).toBe(true); // 3R, code 8
  });

  it('accepts code 2 only from internal 8 up (BtStream 0.2.8)', () => {
    expect(shimmer3SupportsExg(fw(FW_ID.BTSTREAM, 0, 2, 8), 3)).toBe(true);
    expect(shimmer3SupportsExg(fw(FW_ID.BTSTREAM, 0, 2, 7), 3)).toBe(false);
    expect(shimmer3SupportsExg(fw(FW_ID.BTSTREAM, 0, 2, 0), 3)).toBe(false);
  });

  it('rejects code 1 and code -1', () => {
    expect(shimmer3SupportsExg(fw(FW_ID.BTSTREAM, 0, 1, 0), 3)).toBe(false);
    expect(shimmer3SupportsExg(fw(FW_ID.BTSTREAM, 0, 0, 0), 3)).toBe(false);
    // An internal >= 8 does NOT rescue a firmware whose code is not exactly 2.
    expect(shimmer3SupportsExg(fw(FW_ID.BTSTREAM, 0, 1, 9), 3)).toBe(false);
  });
});
