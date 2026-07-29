import { describe, it, expect } from 'vitest';
import {
  interpretShimmer3InquiryResponse,
  buildShimmer3Schema,
  parseShimmer3DeviceVersionResponse,
  parseShimmer3FwVersionResponse,
  shimmer3UsesThreeByteTimestamp,
  shimmer3ControlMessageLength,
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
});
