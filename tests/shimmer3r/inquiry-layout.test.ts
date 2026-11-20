import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { CRC_MODE, appendCrc, type CrcMode } from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { HW, versionReply, type FwTuple } from './configFirmware.js';

// DEV-1514. `Shimmer3RClient` also drives a classic Shimmer3, and Shimmer
// Capture Web uses it for every Bluetooth sensor. The inquiry reply is laid out
// differently on the two: the config word is 4 bytes on a Shimmer3 and 7 on a
// Shimmer3R, so the channel count sits at offset 7 on one and 10 on the other.
// The client read every reply as a Shimmer3R's. On a byte stream, or with a
// link CRC on, the framer cut a 21-channel Shimmer3 reply at 13 bytes of its 30
// and the replies after it were misframed; over BLE without a CRC the reply
// arrived whole and was parsed as a one-channel configuration.
//
// The Shimmer3 reply below is a real one: Shimmer3 A615, captured over its
// Classic Bluetooth COM port on 19 Nov 2026 with the link CRC off. The CRCs a
// device adds are computed here, as the firmware computes them over the whole
// `[ACK][response]` packet; the same capture taken at 1 and 2 CRC bytes matched
// that computation on every reply.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
const NACK = OPCODES.NACK_COMMAND_PROCESSED; // 0xFE
const INSTREAM = OPCODES.INSTREAM_CMD_RESPONSE; // 0x8A

const hex = (s: string): number[] => s.split(' ').map((h) => parseInt(h, 16));

/** A615's channel list: 21 channels, in the order its inquiry gave them. */
const A615_CHANNELS = hex('00 01 02 03 0a 0b 0c 04 05 06 07 08 09 14 15 16 17 18 19 1a 1b');
/** A615's whole inquiry reply, opcode included, without its ACK. */
const A615_INQUIRY = hex('02 80 02 00 06 0d 08 15 01').concat(A615_CHANNELS);

/** A Shimmer3R's reply for the same three channels: a 7-byte config word. */
const S3R_CHANNELS = [0x00, 0x01, 0x02];
const S3R_INQUIRY = [
  0x02,
  0x80,
  0x02,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  S3R_CHANNELS.length,
  1,
  ...S3R_CHANNELS,
];

/** A615's GET_VBATT and GET_STATUS payloads, from the same capture. */
const BATT_RAW = hex('2a 0b 40');
const BATT_ADC = 0x0b2a;
const STATUS0 = 0x25; // docked, RTC set, SD card in

interface Device {
  name: string;
  hw: number;
  fw: FwTuple;
  inquiry: number[];
  channels: number[];
  statusBytes: number[];
}

const DEVICES: readonly Device[] = [
  {
    name: 'a Shimmer3 (A615)',
    hw: HW.SHIMMER3,
    fw: [3, 1, 1, 5],
    inquiry: A615_INQUIRY,
    channels: A615_CHANNELS,
    statusBytes: [STATUS0],
  },
  {
    name: 'a Shimmer3R',
    hw: HW.SHIMMER3R,
    fw: [3, 1, 1, 5],
    inquiry: S3R_INQUIRY,
    channels: S3R_CHANNELS,
    statusBytes: [STATUS0, 1],
  },
];

const LINKS = [
  { name: 'BLE', framed: true },
  { name: 'a byte stream', framed: false },
] as const;
type Link = (typeof LINKS)[number];

/**
 * `device` connected over `link`. A framed link gets one notification per
 * packet, unless `splitAt` splits the inquiry's; a byte stream gets 3-byte
 * reads.
 */
async function sensor(device: Device, link: Link, splitAt?: number) {
  const state = { mode: CRC_MODE.OFF as CrcMode };
  const t = new LoopbackTransport({
    capabilities: link.framed ? {} : { framed: false },
    deviceName: link.framed ? 'Shimmer-BLE' : 'Shimmer-SPP',
  });
  const deliver = (packet: Uint8Array): void => {
    if (link.framed) {
      const cuts =
        splitAt === undefined ? [packet] : [packet.slice(0, splitAt), packet.slice(splitAt)];
      for (const cut of cuts) setTimeout(() => t.notify(cut), 0);
      return;
    }
    for (let i = 0; i < packet.length; i += 3) {
      const read = packet.slice(i, i + 3);
      setTimeout(() => t.notify(read), 0);
    }
  };
  /** One packet, CRC'd in the mode current when it is composed. */
  const send = (msg: number[]): void => deliver(appendCrc(new Uint8Array(msg), state.mode));

  t.setOnWrite((bytes) => {
    const op = bytes[0];
    const version = versionReply(op, device.hw, device.fw);
    if (version) {
      send(version);
    } else if (op === OPCODES.SET_CRC_COMMAND) {
      // Switched while the command is processed, so its own ACK has the new trailer
      state.mode = bytes[1] as CrcMode;
      send([ACK]);
    } else if (op === OPCODES.INQUIRY_COMMAND) {
      send([ACK, ...device.inquiry]);
    } else if (op === OPCODES.GET_VBATT_COMMAND) {
      send([ACK, INSTREAM, OPCODES.VBATT_RESPONSE, ...BATT_RAW]);
    } else if (op === OPCODES.GET_STATUS_COMMAND) {
      send([ACK, INSTREAM, OPCODES.STATUS_RESPONSE, ...device.statusBytes]);
    } else {
      send([NACK]);
    }
  });

  const client = new Shimmer3RClient({ debug: false, transport: t });
  await client.connect();
  return client;
}

describe("the inquiry reply is read with the answering device's layout", () => {
  for (const device of DEVICES) {
    for (const link of LINKS) {
      for (const mode of [CRC_MODE.OFF, CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE] as const) {
        it(`${device.name} over ${link.name}, CRC ${mode}`, async () => {
          const client = await sensor(device, link);
          // As Shimmer Capture Web does: both versions, then the CRC, then the inquiry.
          await client.readFwVersion();
          await client.readDeviceVersion();
          if (mode !== CRC_MODE.OFF) await client.setCrcMode(mode);

          const info = await client.inquiry();
          expect(info.numChannels).toBe(device.channels.length);
          expect(info.channelIds).toEqual(device.channels);
          expect(info.bufferSize).toBe(1);
          expect(info.samplingRateHz).toBeCloseTo(51.2, 5); // 32768 / 0x0280

          // Nothing of the inquiry is left over to misframe what follows.
          expect((await client.getBattery()).adcValue).toBe(BATT_ADC);
          expect((await client.getStatus()).docked).toBe(true);
        });
      }
    }
  }

  it('a Shimmer3 reply split across BLE notifications is put back together', async () => {
    // The continuation carries no opcode, so the reader judges completeness from
    // the header: 9 bytes on a Shimmer3, then the channel count it declares.
    const client = await sensor(DEVICES[0], LINKS[0], 6);
    await client.readDeviceVersion();
    const info = await client.inquiry();
    expect(info.channelIds).toEqual(A615_CHANNELS);
  });

  it('the parsed config word is the 4 bytes a Shimmer3 sends', async () => {
    // 00 06 0d 08 little-endian: GSR range 4 (auto) in byte 3 bits 1-3,
    // expansion power off in bit 0.
    const client = await sensor(DEVICES[0], LINKS[1]);
    await client.readDeviceVersion();
    await client.inquiry();
    expect(client.gsrRangeSetting).toBe(4);
    expect(client.ExpPower).toBe(0);
  });
});
