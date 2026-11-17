/**
 * Event records, files, frames and status, decoded from the bytes of
 * log-and-stream-common `docs/SHIMMER3_EVENT_CHANNEL.md` §5 and
 * `docs/SHIMMER3_BT_COMMUNICATION_PROTOCOL.md` §7.15, which the firmware's
 * `Test/host/test_event_record.c` pins its encoder to.
 */
import { describe, it, expect } from 'vitest';
import {
  EVENT_CHANNEL,
  EVENT_FILE_OPEN_REASON,
  EVENT_INPUT,
  EVENT_RECORD_FLAG,
  EVENT_RECORD_TYPE,
  EventFileFormatError,
  describeEventRecord,
  eventFrameLength,
  eventTicksToUnixMs,
  parseEventChannelStatus,
  parseEventFile,
  parseEventFrame,
} from '../../src/devices/events/record.js';
import { NEED_MORE, RESYNC } from '../../src/core/framing.js';

const hex = (s: string): Uint8Array =>
  new Uint8Array(
    s
      .trim()
      .split(/\s+/)
      .map((b) => parseInt(b, 16)),
  );

/** The worked example: a Shimmer3R, both inputs on, 2.5 minutes of logging. */
const WORKED_FILE = hex(`
  53 45 56 54 01 40 10 0A 00 20 12 37 72 35 00 00
  00 00 00 00 00 00 00 00 90 5C E4 6A 03 00 01 00
  01 19 00 00 01 03 00 00 00 00 00 00 00 00 00 00
  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  01 00 00 00 A4 D0 11 37 72 35 00 00 00 01 00 00
  01 00 01 00 71 DD 11 37 72 35 00 00 00 00 00 00
  01 00 02 00 EC F1 11 37 72 35 00 00 00 01 00 00
  01 00 03 00 48 01 12 37 72 35 00 00 00 00 00 00
  02 00 04 00 00 20 12 37 72 35 00 00 FF 00 00 00
  01 00 05 00 33 53 18 37 72 35 00 00 00 01 00 00
  01 00 06 00 3D 6A 18 37 72 35 00 00 00 00 00 00
  01 01 07 00 04 20 21 37 72 35 00 00 01 02 00 00
  01 01 08 00 4C 21 21 37 72 35 00 00 01 00 00 00
  01 01 09 00 10 A0 28 37 72 35 00 00 01 02 00 00
  01 01 0A 00 58 A1 28 37 72 35 00 00 01 00 00 00
  03 00 0B 00 00 20 4E 37 72 35 00 00 FF 00 00 00
  01 00 0C 00 00 20 5D 37 72 35 00 00 00 01 00 00
  01 00 0D 00 14 2E 5D 37 72 35 00 00 00 00 00 00
  01 00 0E 00 66 46 5D 37 72 35 00 00 00 01 00 00
  01 00 0F 00 7B 54 5D 37 72 35 00 00 00 00 00 00
  03 80 10 00 AE 87 5D 37 72 35 00 00 FF 00 00 00
`);

/** The marker press from that file, as a link's second record, CRC 0x2009. */
const WORKED_FRAME = hex('8A BB 10 01 00 01 00 33 53 18 37 72 35 00 00 00 01 00 00 09 20');

describe('parseEventFile', () => {
  const file = parseEventFile(WORKED_FILE);

  it('decodes the header', () => {
    expect(file.header).toEqual({
      version: 1,
      headerLength: 64,
      recordLength: 16,
      hardwareId: 10,
      fileOpenTicks: 0x357237122000n,
      rtcOffsetTicks: 0n,
      configTime: 0x6ae45c90,
      firmwareId: 3,
      firmwareVersion: { major: 1, minor: 1, internal: 25 },
      firstSeq: 0,
      openReason: EVENT_FILE_OPEN_REASON.SESSION_START,
      inputs: EVENT_INPUT.BUTTON | EVENT_INPUT.TTL,
    });
    // 10:15:00.250 UTC on 30 Oct 2026
    expect(new Date(eventTicksToUnixMs(file.header.fileOpenTicks)).toISOString()).toBe(
      '2026-10-30T10:15:00.250Z',
    );
  });

  it('decodes all 17 records, complete', () => {
    expect(file.records).toHaveLength(17);
    expect(file.trailingBytes).toBe(0);
    expect(file.complete).toBe(true);
    expect(file.records.map((r) => r.seq)).toEqual(Array.from({ length: 17 }, (_u, i) => i));
  });

  it('times each record from the file open as the doc does', () => {
    const t = (i: number): number =>
      Number(file.records[i].ticks - file.header.fileOpenTicks) / 32768;
    expect(t(0)).toBeCloseTo(-0.619995, 5);
    expect(t(4)).toBe(0);
    expect(t(5)).toBeCloseTo(12.399994, 5);
    expect(t(7)).toBeCloseTo(30.000122, 5);
    expect(t(16)).toBeCloseTo(150.809998, 5);
  });

  it('reads the record fields', () => {
    const [press, , , , init, , , ttlRise, ttlFall, , , hbeat] = file.records;
    expect(press).toMatchObject({
      type: EVENT_RECORD_TYPE.EDGE,
      channel: EVENT_CHANNEL.BUTTON,
      buttonDown: true,
      ttlHigh: false,
      dropped: 0,
    });
    expect(describeEventRecord(press)).toBe('Button pressed');
    expect(init.type).toBe(EVENT_RECORD_TYPE.INITIAL_STATE);
    expect(init.channel).toBe(EVENT_CHANNEL.NONE);
    expect(describeEventRecord(init)).toBe('Initial state');
    expect(ttlRise.flags & EVENT_RECORD_FLAG.HW_CAPTURE).toBeTruthy();
    expect(describeEventRecord(ttlRise)).toBe('TTL high');
    expect(describeEventRecord(ttlFall)).toBe('TTL low');
    expect(describeEventRecord(hbeat)).toBe('Heartbeat');
    expect(describeEventRecord(file.records[16])).toBe('End of file');
  });

  it('keeps a file cut short, and says so', () => {
    const cut = parseEventFile(WORKED_FILE.subarray(0, 64 + 16 * 5 + 7));
    expect(cut.records).toHaveLength(5);
    expect(cut.trailingBytes).toBe(7);
    expect(cut.complete).toBe(false);
  });

  it('skips header and record bytes beyond those it knows', () => {
    const longer = new Uint8Array(80 + 20);
    longer.set(WORKED_FILE.subarray(0, 64), 0);
    longer[5] = 80;
    longer[6] = 20;
    longer.set(WORKED_FILE.subarray(64, 80), 80);
    const f = parseEventFile(longer);
    expect(f.records).toHaveLength(1);
    expect(f.records[0].ticks).toBe(0x35723711d0a4n);
  });

  it('refuses what is not an event file', () => {
    expect(() => parseEventFile(hex('00 01 02 03 04 05 06 07'))).toThrow(EventFileFormatError);
    const v2 = WORKED_FILE.slice();
    v2[4] = 2;
    expect(() => parseEventFile(v2)).toThrow(/version 2/);
  });
});

describe('event record frames', () => {
  it('decodes the protocol doc example, CRC included', () => {
    expect(eventFrameLength(WORKED_FRAME)).toBe(21);
    const rec = parseEventFrame(WORKED_FRAME);
    expect(rec).toMatchObject({
      type: EVENT_RECORD_TYPE.EDGE,
      seq: 1,
      ticks: 0x357237185333n,
      channel: EVENT_CHANNEL.BUTTON,
      buttonDown: true,
    });
  });

  it('rejects a frame whose CRC does not check out', () => {
    const bad = WORKED_FRAME.slice();
    bad[10] ^= 0x01;
    expect(eventFrameLength(bad)).toBe(RESYNC);
    expect(parseEventFrame(bad)).toBeNull();
  });

  it('asks for more until the frame is whole', () => {
    for (let n = 1; n < 21; n++)
      expect(eventFrameLength(WORKED_FRAME.subarray(0, n))).toBe(NEED_MORE);
  });

  it('is not fooled by other 0x8A messages', () => {
    expect(eventFrameLength(hex('8A 71 00 01'))).toBe(RESYNC);
    expect(eventFrameLength(hex('8A BB 05'))).toBe(RESYNC); // shorter than a record
  });

  it('measures a frame at an offset', () => {
    const buf = new Uint8Array(25);
    buf.set(WORKED_FRAME, 4);
    expect(eventFrameLength(buf, 4)).toBe(21);
  });
});

describe('parseEventChannelStatus', () => {
  it('decodes the 9 bytes', () => {
    expect(parseEventChannelStatus(hex('03 0B 02 05 00 02 00 01 00'))).toEqual({
      inputsEnabled: 3,
      streaming: true,
      fileOpen: true,
      fileError: false,
      ttlArmed: true,
      ttlThrottled: false,
      state: EVENT_INPUT.TTL,
      nextSeq: 5,
      sessionDropped: 2,
      linkLost: 1,
    });
  });

  it('needs all 9', () => {
    expect(() => parseEventChannelStatus(hex('03 0B'))).toThrow(RangeError);
  });
});
