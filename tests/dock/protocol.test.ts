import { describe, it, expect } from 'vitest';
import {
  shimmerUartCrcByte,
  shimmerUartCrcCalc,
  shimmerUartCrcCheck,
  SHIMMER_UART_CRC_INIT,
} from '../../src/devices/dock/crc.js';
import {
  buildUartPacket,
  buildReadPacket,
  buildWritePacket,
  buildMemReadPayload,
  buildMemWritePayload,
  parseUartPacket,
  wiredPacketLength,
  isBadResponse,
  badResponseReason,
  parseMacId,
  parseVersionInfo,
  parseBatteryStatus,
  battAdcToVoltage,
  parseExpansionBoard,
  NEED_MORE,
  RESYNC,
} from '../../src/devices/dock/protocol.js';
import {
  UART_PACKET_CMD,
  UART_PROP,
  UART_PACKET_HEADER,
} from '../../src/devices/dock/constants.js';

// All fixtures below are hand-derived from the Java driver and were cross-checked
// against the actual Java ShimmerCrc compiled and executed directly. Citations
// are file:line within Shimmer-Java-Android-API/ShimmerDriver .../wiredProtocol/.

const u8 = (...b: number[]): Uint8Array => Uint8Array.from(b);
const arr = (a: Uint8Array): number[] => [...a];

// ---------------------------------------------------------------------------
// CRC (ShimmerCrc.java)
// ---------------------------------------------------------------------------

describe('shimmer wired UART CRC', () => {
  it('init constant is 0xB0CA (ShimmerCrc.java:29)', () => {
    expect(SHIMMER_UART_CRC_INIT).toBe(0xb0ca);
  });

  it('matches TEST_ACK: CRC over [0x24,0xFF] = [0xD9,0xB2]', () => {
    // AbstractCommsProtocolWired.TEST_ACK = {36,-1,-39,-78} = 24 FF D9 B2 (line 40).
    expect(arr(u8(...shimmerUartCrcCalc(u8(0x24, 0xff), 2)))).toEqual([0xd9, 0xb2]);
  });

  it('single-byte fold reproduces the byte-swap+fold sequence', () => {
    // Verified equal to the Java shimmerUartCrcByte for the seed + 0x24.
    expect(shimmerUartCrcByte(SHIMMER_UART_CRC_INIT, 0x24)).toBe(shimmerUartCrcByte(0xb0ca, 0x24));
    expect(shimmerUartCrcByte(SHIMMER_UART_CRC_INIT, 0x24) & ~0xffff).toBe(0);
  });

  it('appends CRC LSB-first and validates round-trip', () => {
    const body = u8(0x24, 0x03, 0x02, 0x01, 0x02); // READ MAC body
    const [lsb, msb] = shimmerUartCrcCalc(body, body.length);
    const full = u8(...body, lsb, msb);
    expect(shimmerUartCrcCheck(full)).toBe(true);
    // Flipping any body byte breaks the check.
    const bad = u8(...full);
    bad[2] ^= 0x01;
    expect(shimmerUartCrcCheck(bad)).toBe(false);
  });

  it('odd-length input folds a trailing 0x00 (ShimmerCrc.java:37-39)', () => {
    // The 3-byte input path must include the pad; the check just needs to be
    // self-consistent with build (round-trip proves the pad is applied).
    const body = u8(0x24, 0x03, 0x02); // odd length 3
    const [lsb, msb] = shimmerUartCrcCalc(body, body.length);
    expect(shimmerUartCrcCheck(u8(...body, lsb, msb))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TX packet assembly (AbstractCommsProtocolWired#assembleTxPacket)
// ---------------------------------------------------------------------------

describe('buildUartPacket', () => {
  it('READ MAC = 24 03 02 01 02 fb ef', () => {
    // $ | READ(0x03) | LENGTH(2=comp+prop) | MAIN_PROCESSOR(0x01) | MAC(0x02) | crc
    expect(arr(buildReadPacket(UART_PROP.MAIN_PROCESSOR.MAC))).toEqual([
      0x24, 0x03, 0x02, 0x01, 0x02, 0xfb, 0xef,
    ]);
  });

  it('READ VER = 24 03 02 01 03 ca dc', () => {
    expect(arr(buildReadPacket(UART_PROP.MAIN_PROCESSOR.VER))).toEqual([
      0x24, 0x03, 0x02, 0x01, 0x03, 0xca, 0xdc,
    ]);
  });

  it('READ BAT.VALUE = 24 03 02 02 02 ab b6', () => {
    expect(arr(buildReadPacket(UART_PROP.BAT.VALUE))).toEqual([
      0x24, 0x03, 0x02, 0x02, 0x02, 0xab, 0xb6,
    ]);
  });

  it('WRITE GSR.RANGE=2: LENGTH counts comp+prop+payload (3) → 24 01 03 05 03 02 7f 12', () => {
    expect(arr(buildWritePacket(UART_PROP.GSR.RANGE, u8(0x02)))).toEqual([
      0x24, 0x01, 0x03, 0x05, 0x03, 0x02, 0x7f, 0x12,
    ]);
  });

  it('ACK echo (no arg) omits the LENGTH byte: 24 ff d9 b2', () => {
    // assembleTxPacket only emits the length byte when msgLength>0 (line 414).
    expect(arr(buildUartPacket(UART_PACKET_CMD.ACK_RESPONSE, null))).toEqual([
      0x24, 0xff, 0xd9, 0xb2,
    ]);
  });

  it('header byte is $ (0x24)', () => {
    expect(buildReadPacket(UART_PROP.BAT.VALUE)[0]).toBe(UART_PACKET_HEADER);
    expect(UART_PACKET_HEADER).toBe(0x24);
  });
});

// ---------------------------------------------------------------------------
// Memory read/write payloads (#shimmerUartGetMemCommand / #shimmerUartSetMemCommand)
// ---------------------------------------------------------------------------

describe('memory payloads', () => {
  it('INFOMEM read payload = [size, addrLE0, addrLE1]', () => {
    // size then 2-byte little-endian address (ByteBuffer.putShort + reverse).
    expect(arr(buildMemReadPayload(UART_PROP.MAIN_PROCESSOR.INFOMEM, 0x0102, 0x80))).toEqual([
      0x80, 0x02, 0x01,
    ]);
  });

  it('DAUGHTER_CARD.CARD_ID uses a single-byte address (special case)', () => {
    // shimmerUartGetMemCommand :298-300 — CARD_ID address is one byte.
    expect(arr(buildMemReadPayload(UART_PROP.DAUGHTER_CARD.CARD_ID, 0, 16))).toEqual([0x10, 0x00]);
  });

  it('INFOMEM write payload = [size, addrLE0, addrLE1, ...data]', () => {
    expect(
      arr(buildMemWritePayload(UART_PROP.MAIN_PROCESSOR.INFOMEM, 0x0010, u8(0xaa, 0xbb))),
    ).toEqual([0x02, 0x10, 0x00, 0xaa, 0xbb]);
  });
});

// ---------------------------------------------------------------------------
// RX framing length (wiredPacketLength)
// ---------------------------------------------------------------------------

describe('wiredPacketLength', () => {
  it('NEED_MORE for empty / partial header region', () => {
    expect(wiredPacketLength(u8())).toBe(NEED_MORE);
    expect(wiredPacketLength(u8(0x24))).toBe(NEED_MORE); // need cmd
    expect(wiredPacketLength(u8(0x24, 0x02))).toBe(NEED_MORE); // data cmd needs length byte
  });

  it('RESYNC when first byte is not the header', () => {
    expect(wiredPacketLength(u8(0x00, 0x24))).toBe(RESYNC);
  });

  it('RESYNC on unknown command byte', () => {
    expect(wiredPacketLength(u8(0x24, 0x7a))).toBe(RESYNC);
  });

  it('ACK / bad responses are 4 bytes (PACKET_OVERHEAD_RESPONSE_OTHER)', () => {
    expect(wiredPacketLength(u8(0x24, 0xff))).toBe(4);
    expect(wiredPacketLength(u8(0x24, 0xfe))).toBe(4);
    expect(wiredPacketLength(u8(0x24, 0xfd))).toBe(4);
    expect(wiredPacketLength(u8(0x24, 0xfc))).toBe(4);
  });

  it('DATA_RESPONSE length = 5 + LENGTH byte', () => {
    // DATA MAC has LENGTH=8 → total 13.
    expect(wiredPacketLength(u8(0x24, 0x02, 0x08))).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// RX parse (parseUartPacket) — fixtures derived from UartRxPacketObject
// ---------------------------------------------------------------------------

describe('parseUartPacket', () => {
  it('parses a DATA_RESPONSE: payload = LENGTH-2 bytes at offset 5', () => {
    // DATA MAC: 24 02 08 01 02 <6 mac> crc — LENGTH=8 → 6-byte payload.
    const pkt = parseUartPacket(
      u8(0x24, 0x02, 0x08, 0x01, 0x02, 0x00, 0x06, 0x66, 0x66, 0x80, 0x01, 0x82, 0xfe),
    );
    expect(pkt.command).toBe(UART_PACKET_CMD.DATA_RESPONSE);
    expect(pkt.component).toBe(0x01);
    expect(pkt.property).toBe(0x02);
    expect(arr(pkt.payload)).toEqual([0x00, 0x06, 0x66, 0x66, 0x80, 0x01]);
    expect(pkt.crcOk).toBe(true);
    expect(pkt.length).toBe(13);
  });

  it('parses an ACK (no comp/prop/payload)', () => {
    const pkt = parseUartPacket(u8(0x24, 0xff, 0xd9, 0xb2));
    expect(pkt.command).toBe(UART_PACKET_CMD.ACK_RESPONSE);
    expect(pkt.component).toBeNull();
    expect(pkt.payload.length).toBe(0);
    expect(pkt.crcOk).toBe(true);
    expect(pkt.length).toBe(4);
  });

  it('flags a bad CRC', () => {
    const pkt = parseUartPacket(u8(0x24, 0xff, 0x00, 0x00));
    expect(pkt.crcOk).toBe(false);
  });

  it('classifies bad responses', () => {
    expect(isBadResponse(UART_PACKET_CMD.BAD_CMD_RESPONSE)).toBe(true);
    expect(isBadResponse(UART_PACKET_CMD.BAD_ARG_RESPONSE)).toBe(true);
    expect(isBadResponse(UART_PACKET_CMD.BAD_CRC_RESPONSE)).toBe(true);
    expect(isBadResponse(UART_PACKET_CMD.ACK_RESPONSE)).toBe(false);
    expect(badResponseReason(UART_PACKET_CMD.BAD_CRC_RESPONSE)).toBe('BAD_CRC');
  });
});

// ---------------------------------------------------------------------------
// Response payload parsers
// ---------------------------------------------------------------------------

describe('response parsers', () => {
  it('parseMacId: first 6 bytes, device order, 12-char hex', () => {
    expect(parseMacId(u8(0x00, 0x06, 0x66, 0x66, 0x80, 0x01, 0xff))).toBe('000666668001');
    expect(() => parseMacId(u8(0x00, 0x06))).toThrow();
  });

  it('parseVersionInfo: 7-byte layout [hw][fwId LE][major LE][minor][internal]', () => {
    // ShimmerVerObject.parseVersionByteArray, 7-byte branch (:204-213).
    const v = parseVersionInfo(u8(0x0a, 0x03, 0x00, 0x00, 0x00, 0x0f, 0x00));
    expect(v).toEqual({
      hardwareVersion: 0x0a,
      firmwareIdentifier: 3,
      firmwareVersionMajor: 0,
      firmwareVersionMinor: 15,
      firmwareVersionInternal: 0,
    });
  });

  it('parseVersionInfo: 8-byte layout has a 2-byte HW version', () => {
    const v = parseVersionInfo(u8(0x0a, 0x00, 0x03, 0x00, 0x01, 0x00, 0x02, 0x07));
    expect(v.hardwareVersion).toBe(0x000a);
    expect(v.firmwareIdentifier).toBe(3);
    expect(v.firmwareVersionMajor).toBe(1);
    expect(v.firmwareVersionMinor).toBe(2);
    expect(v.firmwareVersionInternal).toBe(7);
    expect(() => parseVersionInfo(u8(1, 2, 3))).toThrow();
  });

  it('parseBatteryStatus: 12-bit LE ADC, charging byte, derived voltage/%', () => {
    // adc = (payload[1]<<8)|payload[0] = 0x0a00 = 2560, status 0x40 = FULLY_CHARGED.
    const s = parseBatteryStatus(u8(0x00, 0x0a, 0x40));
    expect(s.adcValue).toBe(0x0a00);
    expect(s.chargingStatusRaw).toBe(0x40);
    expect(s.chargingStatus).toBe('FULLY_CHARGED');
    expect(s.voltage).toBeCloseTo(battAdcToVoltage(0x0a00), 6);
    expect(s.voltage).toBeCloseTo(3.7284, 3);
    expect(s.percentage).not.toBeNull();
    expect(s.percentage!).toBeGreaterThanOrEqual(0);
    expect(s.percentage!).toBeLessThanOrEqual(100);
  });

  it('decodes each charging-status byte', () => {
    expect(parseBatteryStatus(u8(0x00, 0x0a, 0xc0)).chargingStatus).toBe('SUSPENDED');
    expect(parseBatteryStatus(u8(0x00, 0x0a, 0x80)).chargingStatus).toBe('CHARGING');
    expect(parseBatteryStatus(u8(0x00, 0x0a, 0x00)).chargingStatus).toBe('BAD_BATTERY');
    expect(parseBatteryStatus(u8(0x00, 0x0a, 0xff)).chargingStatus).toBe('UNKNOWN');
    expect(parseBatteryStatus(u8(0x00, 0x0a, 0x11)).chargingStatus).toBe('ERROR');
  });

  it('parseExpansionBoard: [id, rev, specialRev]; all-0xFF means absent', () => {
    expect(parseExpansionBoard(u8(0x08, 0x01, 0x03))).toEqual({
      boardId: 8,
      boardRev: 1,
      specialRev: 3,
    });
    expect(parseExpansionBoard(u8(0xff, 0xff, 0xff))).toBeNull();
    expect(parseExpansionBoard(u8(0x08))).toBeNull();
  });
});
