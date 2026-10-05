import { describe, it, expect, vi } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { CRC_MODE, appendCrc, type CrcMode } from '../../src/devices/shimmer3r/crcMode.js';
import {
  SHIMMER3R_TWO_BYTE_STATUS_MIN_FIRMWARE,
  statusPayloadBytesFor,
} from '../../src/devices/shimmer3r/protocol.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { HW, versionReply, type FwTuple } from './configFirmware.js';

// How many status bytes a STATUS_RESPONSE carries depends on the firmware, not
// only on the hardware. Shimmer3R LogAndStream sent one until v1.00.024, which
// added `usbPluggedIn` as a second byte (log-and-stream-common 8377afc,
// DEV-307), and every release since sends two. v1.00.050 (DEV-621) only renamed
// that count to STATUS_BYTE_COUNT, so it is not the boundary. No Shimmer3
// release sends a second byte, though Shimmer3 version numbers run past
// v1.00.024 too.
//
// A client that took the width from the hardware alone sized every Shimmer3R
// status at two bytes. Against v1.00.023 and earlier a byte stream, or BLE with
// a link CRC on, then swallowed the byte after each status, usually an ACK; and
// over BLE without one, getStatus timed out and pushes were dropped as
// truncated once the hardware version had been read.
//
// The devices below send what each release sends, as packets: the reply rides
// behind its ACK, the CRC covers the whole packet, and a push carries the ACK
// prefix the firmware defaults to (`useAckPrefixForInstreamResponses`) until
// SET_INSTREAM_RESPONSE_ACK_PREFIX_STATE turns it off. setCrcMode(2) does that
// on v1.00.024 to v1.00.049, whose push a 2-byte CRC would otherwise overrun
// (crc-push-overrun.test.ts). A framed link gets one notification per packet; a
// byte stream gets 3-byte reads.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
const NACK = OPCODES.NACK_COMMAND_PROCESSED; // 0xFE
const INSTREAM = OPCODES.INSTREAM_CMD_RESPONSE; // 0x8A
const STATUS = OPCODES.STATUS_RESPONSE; // 0x71
const VBATT = OPCODES.VBATT_RESPONSE; // 0x94

/** docked + rtcSet + sdLogging + sdPresent. */
const S0 = 0x2d;
/** The battery reply's payload, and the ADC value it decodes to. */
const BATT_RAW = [0x00, 0x0a, 0x40];
const BATT_ADC = 0x0a00;

interface Release {
  name: string;
  hw: number;
  fw: FwTuple;
  /** What the firmware sends, read off its source, not off the SDK's rule. */
  width: 1 | 2;
}

const RELEASES: readonly Release[] = [
  // The last release without the second byte
  { name: 'Shimmer3R LogAndStream v1.00.023', hw: HW.SHIMMER3R, fw: [3, 1, 0, 23], width: 1 },
  // The first with it
  { name: 'Shimmer3R LogAndStream v1.00.024', hw: HW.SHIMMER3R, fw: [3, 1, 0, 24], width: 2 },
  // Either side of DEV-621, which renamed the count without changing it
  { name: 'Shimmer3R LogAndStream v1.00.049', hw: HW.SHIMMER3R, fw: [3, 1, 0, 49], width: 2 },
  { name: 'Shimmer3R LogAndStream v1.00.050', hw: HW.SHIMMER3R, fw: [3, 1, 0, 50], width: 2 },
  // A version past the boundary, on hardware that never sends the byte
  { name: 'Shimmer3 LogAndStream v1.01.005', hw: HW.SHIMMER3, fw: [3, 1, 1, 5], width: 1 },
];

const LINKS = [
  { name: 'BLE', framed: true },
  { name: 'a byte stream', framed: false },
] as const;
type Link = (typeof LINKS)[number];

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A sensor running `release`, connected to a client over `link`. */
async function sensor(release: Release, link: Link) {
  const state = { mode: CRC_MODE.OFF as CrcMode, usb: 1, ackPrefix: true };
  const t = new LoopbackTransport({
    capabilities: link.framed ? {} : { framed: false },
    deviceName: link.framed ? 'Shimmer3R-BLE' : 'Shimmer3R-SPP',
  });
  const deliver = (packet: Uint8Array): void => {
    if (link.framed) {
      setTimeout(() => t.notify(packet), 0);
      return;
    }
    for (let i = 0; i < packet.length; i += 3) {
      const read = packet.slice(i, i + 3);
      setTimeout(() => t.notify(read), 0);
    }
  };
  /** One packet in the CRC mode current when it is composed. */
  const send = (msg: number[]): void => deliver(appendCrc(new Uint8Array(msg), state.mode));
  const statusBytes = (s0: number): number[] => (release.width === 2 ? [s0, state.usb] : [s0]);

  t.setOnWrite((bytes) => {
    const op = bytes[0];
    const version = versionReply(op, release.hw, release.fw);
    if (version) {
      send(version);
    } else if (op === OPCODES.SET_INSTREAM_RESPONSE_ACK_PREFIX_STATE) {
      state.ackPrefix = bytes[1] !== 0;
      send([ACK]);
    } else if (op === OPCODES.SET_CRC_COMMAND) {
      // Switched while the command is processed, so its own ACK has the new trailer
      state.mode = bytes[1] as CrcMode;
      send([ACK]);
    } else if (op === OPCODES.GET_STATUS_COMMAND) {
      send([ACK, INSTREAM, STATUS, ...statusBytes(S0)]);
    } else if (op === OPCODES.GET_VBATT_COMMAND) {
      send([ACK, INSTREAM, VBATT, ...BATT_RAW]);
    } else {
      send([NACK]);
    }
  });

  const client = new Shimmer3RClient({ debug: false, transport: t });
  await client.connect();
  return {
    t,
    client,
    /** An unsolicited status, as on docking: behind the ACK prefix while it is on. */
    push: (s0: number): void =>
      send([...(state.ackPrefix ? [ACK] : []), INSTREAM, STATUS, ...statusBytes(s0)]),
  };
}

/** `usbPluggedIn` as `release` reports it, with USB plugged in. */
const usbAs = (release: Release): boolean | null => (release.width === 2 ? true : null);

describe('statusPayloadBytesFor', () => {
  const fw = (major: number, minor: number, patch: number, fwId = 3) => ({
    fwId,
    major,
    minor,
    patch,
  });

  it('is two from Shimmer3R LogAndStream v1.00.024, and one before it', () => {
    expect(SHIMMER3R_TWO_BYTE_STATUS_MIN_FIRMWARE).toEqual({ major: 1, minor: 0, internal: 24 });
    expect(statusPayloadBytesFor(HW.SHIMMER3R, fw(0, 0, 2))).toBe(1);
    expect(statusPayloadBytesFor(HW.SHIMMER3R, fw(1, 0, 10))).toBe(1);
    expect(statusPayloadBytesFor(HW.SHIMMER3R, fw(1, 0, 23))).toBe(1);
    expect(statusPayloadBytesFor(HW.SHIMMER3R, fw(1, 0, 24))).toBe(2);
    expect(statusPayloadBytesFor(HW.SHIMMER3R, fw(1, 0, 49))).toBe(2);
    expect(statusPayloadBytesFor(HW.SHIMMER3R, fw(1, 0, 50))).toBe(2);
    expect(statusPayloadBytesFor(HW.SHIMMER3R, fw(1, 1, 0))).toBe(2);
    expect(statusPayloadBytesFor(HW.SHIMMER3R, fw(1, 1, 17))).toBe(2);
    expect(statusPayloadBytesFor(HW.SHIMMER3R, fw(2, 0, 0))).toBe(2);
  });

  it('is one on a Shimmer3, whatever the firmware, read or not', () => {
    // Shimmer3 LogAndStream is at v1.01.x too: the version alone would say two.
    expect(statusPayloadBytesFor(HW.SHIMMER3, fw(1, 1, 5))).toBe(1);
    expect(statusPayloadBytesFor(HW.SHIMMER3, null)).toBe(1);
  });

  it('is one on firmware other than LogAndStream, and on other hardware', () => {
    expect(statusPayloadBytesFor(HW.SHIMMER3R, fw(1, 1, 17, 2))).toBe(1);
    expect(statusPayloadBytesFor(58, fw(1, 1, 17))).toBe(1);
  });

  it('is not known until the versions that decide it are', () => {
    expect(statusPayloadBytesFor(undefined, undefined)).toBeNull();
    expect(statusPayloadBytesFor(null, fw(1, 1, 17))).toBeNull();
    expect(statusPayloadBytesFor(HW.SHIMMER3R, null)).toBeNull();
  });
});

for (const link of LINKS) {
  for (const release of RELEASES) {
    describe(`${release.name} over ${link.name}`, () => {
      it(`reads its ${release.width}-byte status, and the next command still works`, async () => {
        const { client } = await sensor(release, link);
        expect(await client.getStatus()).toMatchObject({
          docked: true,
          sdLogging: true,
          usbPluggedIn: usbAs(release),
        });
        // Nothing was swallowed after the status, and nothing left behind it.
        expect((await client.getBattery()).adcValue).toBe(BATT_ADC);
      });

      it('reads it with the hardware version already known', async () => {
        // The regression case: two bytes were required of every Shimmer3R once
        // its hardware version had been read.
        const { client } = await sensor(release, link);
        expect((await client.readDeviceVersion()).hardwareVersion).toBe(release.hw);
        expect((await client.getStatus()).usbPluggedIn).toBe(usbAs(release));
        expect((await client.getBattery()).adcValue).toBe(BATT_ADC);
      });

      for (const mode of [CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE] as const) {
        it(`reads it under a ${mode}-byte link CRC`, async () => {
          // A CRC sends BLE through the framer too. setCrcMode reads both
          // versions first, which settles the width.
          const { client } = await sensor(release, link);
          await client.setCrcMode(mode);
          expect((await client.getStatus()).usbPluggedIn).toBe(usbAs(release));
          expect((await client.getBattery()).adcValue).toBe(BATT_ADC);
          expect(client.crcFailures).toBe(0);
        });
      }

      it('reports its push once the width is known, leaving the next command whole', async () => {
        const { client, push } = await sensor(release, link);
        await client.readDeviceVersion();
        await client.readFwVersion();
        const spy = vi.fn();
        client.onDeviceStatus = spy;
        push(0x01); // docked
        await tick(5);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toMatchObject({
          docked: true,
          sdLogging: false,
          usbPluggedIn: usbAs(release),
        });
        expect((await client.getBattery()).adcValue).toBe(BATT_ADC);
      });

      it('frames a push that arrives before the width is known', async () => {
        const { client, push } = await sensor(release, link);
        const spy = vi.fn();
        client.onDeviceStatus = spy;
        push(0x01);
        await tick(5);
        // getStatus reads the versions first; their replies follow the push.
        expect((await client.getStatus()).usbPluggedIn).toBe(usbAs(release));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toMatchObject({ docked: true, usbPluggedIn: usbAs(release) });
        expect((await client.getBattery()).adcValue).toBe(BATT_ADC);
      });
    });
  }
}

describe('a one-byte push on a byte stream, before the width is known', () => {
  const v1_00_023 = RELEASES[0];

  it('waits for the next byte to show where it ends, then hands both on whole', async () => {
    const { client, push } = await sensor(v1_00_023, LINKS[1]);
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    push(0x21); // docked + sdPresent
    await tick(5);
    // [0x8A][0x71][0x21] may be a whole status or the start of a two-byte one,
    // so it is held rather than guessed at.
    expect(spy).not.toHaveBeenCalled();

    // The next packet begins with an ACK, which no second status byte can be.
    expect(await client.readDeviceVersion()).toEqual({ hardwareVersion: HW.SHIMMER3R });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      docked: true,
      sdPresent: true,
      usbPluggedIn: null,
    });
  });
});
