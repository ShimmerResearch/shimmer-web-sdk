import { describe, it, expect } from 'vitest';
import {
  SMARTDOCK_CONNECTION_TYPE,
  SMARTDOCK_BASE_CMD,
  buildBaseCommand,
  buildSelectSlotCommand,
  extractBaseLine,
  classifyBaseResponse,
  parseSmartDockVersion,
  parseSlotOccupancy,
  parseActiveSlot,
  baseHardwareType,
} from '../../src/devices/dock/smartDockProtocol.js';

const dec = (u8: Uint8Array): string => new TextDecoder().decode(u8);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('SmartDock base command assembly', () => {
  it('encodes fixed commands', () => {
    expect(dec(buildBaseCommand(SMARTDOCK_BASE_CMD.GET_VERSION))).toBe('SDV$');
    expect(dec(buildBaseCommand(SMARTDOCK_BASE_CMD.QUERY_CONNECTED_SLOTS))).toBe('SDQ$');
  });

  it('builds a without-SD slot select as SDP,NN$ (zero-padded)', () => {
    expect(dec(buildSelectSlotCommand(1, SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD))).toBe(
      'SDP,01$',
    );
    expect(dec(buildSelectSlotCommand(15, SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD))).toBe(
      'SDP,15$',
    );
  });

  it('builds a with-SD slot select as SDC,NN$', () => {
    expect(dec(buildSelectSlotCommand(3, SMARTDOCK_CONNECTION_TYPE.WITH_SD_CARD))).toBe('SDC,03$');
  });

  it('maps a DISCONNECTED select to SDD$', () => {
    expect(dec(buildSelectSlotCommand(0, SMARTDOCK_CONNECTION_TYPE.DISCONNECTED))).toBe('SDD$');
  });
});

describe('SmartDock line framing (extractBaseLine)', () => {
  it('extracts one complete line and keeps the remainder', () => {
    const buf = enc('V,1,3,0,5,0\r\nQ,0');
    const res = extractBaseLine(buf);
    expect(res).not.toBeNull();
    expect(res!.line).toBe('V,1,3,0,5,0');
    expect(dec(res!.rest)).toBe('Q,0');
  });

  it('returns null when no terminator yet', () => {
    expect(extractBaseLine(enc('V,1,3,0,5'))).toBeNull();
  });
});

describe('SmartDock response classification', () => {
  it('classifies by leading char', () => {
    expect(classifyBaseResponse('V,1,3,0,5,0')).toBe('version');
    expect(classifyBaseResponse('Q,001')).toBe('occupancy');
    expect(classifyBaseResponse('S,001')).toBe('occupancy');
    expect(classifyBaseResponse('P,03')).toBe('slotWithoutSd');
    expect(classifyBaseResponse('C,03')).toBe('slotWithSd');
    expect(classifyBaseResponse('C')).toBe('disconnected');
    expect(classifyBaseResponse('D')).toBe('disconnected');
    expect(classifyBaseResponse('E')).toBe('error');
    expect(classifyBaseResponse('garbage')).toBe('unknown');
  });
});

describe('SmartDock version parse', () => {
  it('parses V,hw,fwId,major,minor,internal', () => {
    expect(parseSmartDockVersion('V,1,3,0,5,0')).toEqual({
      hardwareVersion: 1,
      firmwareIdentifier: 3,
      firmwareVersionMajor: 0,
      firmwareVersionMinor: 5,
      firmwareVersionInternal: 0,
    });
  });

  it('rejects malformed version lines', () => {
    expect(parseSmartDockVersion('V,1,3,0,5')).toBeNull(); // only 4 fields
    expect(parseSmartDockVersion('Q,001')).toBeNull();
    expect(parseSmartDockVersion('V,x,3,0,5,0')).toBeNull();
  });
});

describe('baseHardwareType', () => {
  it('maps hardware version to family + slot count', () => {
    expect(baseHardwareType(1)).toEqual({ hardwareType: 'base15', slotCount: 15 });
    expect(baseHardwareType(2)).toEqual({ hardwareType: 'base6', slotCount: 6 });
    expect(baseHardwareType(99)).toEqual({ hardwareType: 'unknown', slotCount: 0 });
  });
});

describe('SmartDock occupancy parse', () => {
  it('parses a Q bitmap into per-slot booleans', () => {
    // Base-6 example: slots 1 and 4 occupied.
    expect(parseSlotOccupancy('Q,100100')).toEqual([true, false, false, true, false, false]);
  });

  it('parses the Java doc example Q,001000000000001 (slots 3 & 15)', () => {
    const occ = parseSlotOccupancy('Q,001000000000001');
    expect(occ).not.toBeNull();
    expect(occ!.length).toBe(15);
    expect(occ!.map((b, i) => (b ? i + 1 : 0)).filter((n) => n)).toEqual([3, 15]);
  });

  it('rejects a bitmap with non-0/1 chars', () => {
    expect(parseSlotOccupancy('Q,0012')).toBeNull();
    expect(parseSlotOccupancy('V,1,3,0,5,0')).toBeNull();
  });
});

describe('SmartDock active-slot parse', () => {
  it('parses P,NN (without SD)', () => {
    expect(parseActiveSlot('P,03')).toEqual({
      slot: 3,
      connectionType: SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD,
    });
  });

  it('parses C,NN (with SD)', () => {
    expect(parseActiveSlot('C,07')).toEqual({
      slot: 7,
      connectionType: SMARTDOCK_CONNECTION_TYPE.WITH_SD_CARD,
    });
  });

  it('parses C / D as disconnected', () => {
    expect(parseActiveSlot('C')).toEqual({
      slot: -1,
      connectionType: SMARTDOCK_CONNECTION_TYPE.DISCONNECTED,
    });
    expect(parseActiveSlot('D')).toEqual({
      slot: -1,
      connectionType: SMARTDOCK_CONNECTION_TYPE.DISCONNECTED,
    });
  });

  it('rejects a non-numeric slot', () => {
    expect(parseActiveSlot('P,xx')).toBeNull();
  });
});
