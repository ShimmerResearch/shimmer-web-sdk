/**
 * Board identity and Bluetooth module version: two tables ported from the Java
 * driver, plus the Shimmer3R's own composed reply, which the Java driver has
 * never seen.
 */
import { describe, it, expect } from 'vitest';
import {
  SHIMMER_PLATFORM_NAMES,
  SHIMMER_SR_BOARD_NAMES,
  formatShimmerSrCode,
  isShimmerSrBoardValid,
  describeShimmerHardware,
  BLUETOOTH_MODULE_VERSIONS,
  parseBluetoothModuleVersion,
} from '../src/devices/identity.js';

describe('SR board identity', () => {
  it('writes the SR code the way the boards are labelled', () => {
    expect(formatShimmerSrCode({ boardId: 48, boardRev: 3, specialRev: 0 })).toBe('SR48-3-0');
  });

  it('keeps the codes the firmware tests for', () => {
    /* Boards/shimmer_boards.h:26-43 — the three the firmware branches on by
       name, and which therefore must never drift. */
    expect(SHIMMER_SR_BOARD_NAMES[31]).toBe('IMU');
    expect(SHIMMER_SR_BOARD_NAMES[47]).toBe('ECG/EMG/Resp');
    expect(SHIMMER_SR_BOARD_NAMES[48]).toBe('GSR+');
  });

  it('rejects both "nothing here" patterns', () => {
    expect(isShimmerSrBoardValid({ boardId: 0, boardRev: 0, specialRev: 0 })).toBe(false);
    expect(isShimmerSrBoardValid({ boardId: 0xff, boardRev: 0xff, specialRev: 0xff })).toBe(false);
    expect(isShimmerSrBoardValid(null)).toBe(false);
    expect(isShimmerSrBoardValid({ boardId: 48, boardRev: 3, specialRev: 0 })).toBe(true);
  });

  it('describes a Shimmer3R GSR+ as platform, board and SR code', () => {
    const d = describeShimmerHardware(10, { boardId: 48, boardRev: 3, specialRev: 0 });
    expect(d).toMatchObject({ platform: 'Shimmer3R', boardName: 'GSR+', srCode: 'SR48-3-0' });
    expect(d.label).toBe('Shimmer3R GSR+ (SR48-3-0)');
  });

  it('names the platform for a Shimmer3 too, with the same board table', () => {
    expect(describeShimmerHardware(3, { boardId: 47, boardRev: 4, specialRev: 0 }).label).toBe(
      'Shimmer3 ECG/EMG/Resp (SR47-4-0)',
    );
  });

  it('still shows the SR code when the board name is unknown', () => {
    /* A board newer than this table has to stay identifiable — the SR code is
       the part a support engineer needs. */
    expect(describeShimmerHardware(10, { boardId: 52, boardRev: 1, specialRev: 0 }).label).toBe(
      'Shimmer3R (SR52-1-0)',
    );
  });

  it('degrades to the platform alone, then to the raw hardware id', () => {
    expect(describeShimmerHardware(10, null).label).toBe('Shimmer3R');
    expect(describeShimmerHardware(10).label).toBe('Shimmer3R');
    expect(describeShimmerHardware(7, { boardId: 48, boardRev: 3, specialRev: 0 }).label).toBe(
      'hardware id 7 GSR+ (SR48-3-0)',
    );
    expect(describeShimmerHardware(null).label).toBe('unknown hardware');
  });

  it('leads with the board when the sensor will not say what platform it is', () => {
    /* An older firmware that does not answer the hardware-version command
       still has a board, and "unknown hardware GSR+" reads like a fault. */
    expect(describeShimmerHardware(null, { boardId: 48, boardRev: 3, specialRev: 0 }).label).toBe(
      'GSR+ (SR48-3-0)',
    );
    expect(describeShimmerHardware(null, { boardId: 52, boardRev: 1, specialRev: 0 }).label).toBe(
      'unknown hardware (SR52-1-0)',
    );
  });

  it('knows only the two Shimmer3-family platforms', () => {
    expect(Object.keys(SHIMMER_PLATFORM_NAMES).sort()).toEqual(['10', '3']);
  });
});

describe('parseExpansionBoard agrees with the validity test', () => {
  it('reads a real page, and rejects both blank patterns', async () => {
    const { parseExpansionBoard } = await import('../src/devices/dock/protocol.js');
    expect(parseExpansionBoard(new Uint8Array([48, 3, 0]))).toEqual({
      boardId: 48,
      boardRev: 3,
      specialRev: 0,
    });
    expect(parseExpansionBoard(new Uint8Array([0xff, 0xff, 0xff]))).toBeNull();
    /* Never written. Only the 0xFF case was rejected before, so this came
       back as {0,0,0} and could be shown as the board SR0-0-0. */
    expect(parseExpansionBoard(new Uint8Array([0, 0, 0]))).toBeNull();
    expect(parseExpansionBoard(new Uint8Array([0, 0]))).toBeNull();
  });
});

describe('parseBluetoothModuleVersion', () => {
  it('names every module reply the Java table carries', () => {
    /* The full-reply column of BluetoothModuleVersionDetails.java:15-27, run
       through the substring column this SDK ports. */
    const cases: Array<[string, string]> = [
      ['Ver 4.77 05/12/09 \r\n(c) Roving Networks', 'RN41 v4.77'],
      ['Ver 4.77 RN-42 01/05/10 \r\n(c) Roving Networks', 'RN42 v4.77'],
      ['Ver 6.15 04/26/2013\r\n(c) Roving Networks', 'RN42 v6.15'],
      ['RN4678 V1.00.5 11/15/2016 (c)Microchip Technology Inc', 'RN4678 v1.00.5'],
      ['RN4678 V1.11.00 6/1/2017 (c)Microchip Technology Inc', 'RN4678 v1.11.0'],
      ['RN4678 V1.13.5 8/29/2018 (c)Microchip Technology Inc', 'RN4678 v1.13.5'],
      ['RN4678 V1.22 12/08/2020 (c)Microchip Technology Inc   ', 'RN4678 v1.22'],
      ['RN4678 V1.23 06/30/2021 (c)Microchip Technology Inc', 'RN4678 v1.23'],
    ];
    for (const [reply, label] of cases) {
      expect(parseBluetoothModuleVersion(reply).label, reply).toBe(label);
    }
  });

  it('does not let the RN41 row shadow an RN42 reply', () => {
    /* "Ver 4.77 RN-42 01/05/10" contains the RN41 row's "Ver 4.77 05" as a
       substring, so row order decides this. */
    const rn42 = parseBluetoothModuleVersion('Ver 4.77 RN-42 01/05/10 \r\n(c) Roving Networks');
    expect(rn42.family).toBe('rn42');
    expect(rn42.model).toBe('RN42');
  });

  it('corrects the two Java labels that disagreed with their own reply', () => {
    /* Java called V1.13.5 "v1.15.5" and V1.22 "v1.23". */
    expect(parseBluetoothModuleVersion('RN4678 V1.13.5 8/29/2018').version).toBe('1.13.5');
    expect(parseBluetoothModuleVersion('RN4678 V1.22 12/08/2020').version).toBe('1.22');
  });

  it('parses the Shimmer3R reply and drops its formatting zeroes', () => {
    const raw = 'CYW20820 app=v01.04.18.18, stack=0x00000000, protocol=0x0000, hardware=0x00';
    const v = parseBluetoothModuleVersion(raw);
    expect(v.family).toBe('cyw20820');
    expect(v.model).toBe('CYW20820');
    expect(v.version).toBe('1.4.18.18');
    expect(v.label).toBe('CYW20820 v1.4.18.18');
    expect(v.details).toEqual({ stack: '0x00000000', protocol: '0x0000', hardware: '0x00' });
    expect(v.raw).toBe(raw);
  });

  it('reads the reply out of firmware bytes as latin1', () => {
    const raw = 'RN4678 V1.23 06/30/2021';
    const bytes = new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
    expect(parseBluetoothModuleVersion(bytes).label).toBe('RN4678 v1.23');
  });

  it('ignores the trailing NULs a fixed-size firmware buffer carries', () => {
    const bytes = new Uint8Array(40);
    const raw = 'RN4678 V1.23';
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    expect(parseBluetoothModuleVersion(bytes).model).toBe('RN4678');
  });

  it('shows an unrecognised reply rather than swallowing it', () => {
    /* The Java equivalent returns an empty string here: its NOT_READ row has
       an empty comparison string, which String.contains matches against every
       input. What the module said is the useful thing. */
    const v = parseBluetoothModuleVersion('RN9999 V9.9 (c)Someone');
    expect(v.family).toBe('unknown');
    expect(v.model).toBeNull();
    expect(v.version).toBeNull();
    expect(v.label).toBe('RN9999 V9.9 (c)Someone');
  });

  it('says so plainly when the sensor reported nothing', () => {
    /* btVerStrResponse starts zeroed and is only filled once the module has
       answered the firmware's own query. */
    for (const empty of ['', '   ', new Uint8Array(0), new Uint8Array(8)]) {
      expect(parseBluetoothModuleVersion(empty).label).toBe('not reported');
      expect(parseBluetoothModuleVersion(empty).family).toBe('unknown');
    }
  });

  it('never throws, whatever arrives', () => {
    const rubbish = new Uint8Array([0x00, 0xff, 0x80, 0x0a, 0x0d, 0x1b, 0x7f]);
    expect(() => parseBluetoothModuleVersion(rubbish)).not.toThrow();
    /* No cast: the signature accepts these, which is the point — needing
       `as unknown as string` here was the sign that it did not. */
    expect(parseBluetoothModuleVersion(undefined).label).toBe('not reported');
    expect(parseBluetoothModuleVersion(null).label).toBe('not reported');
  });

  it('has no duplicate substrings in the table', () => {
    const matches = BLUETOOTH_MODULE_VERSIONS.map((e) => e.match);
    expect(new Set(matches).size).toBe(matches.length);
  });
});
