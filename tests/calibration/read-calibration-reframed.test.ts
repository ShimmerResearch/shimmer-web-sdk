import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { Shimmer3Client } from '../../src/devices/shimmer3/Shimmer3Client.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { CRC_MODE, appendCrc, type CrcMode } from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { parseKinematicCalibBlock } from '../../src/devices/calibration/kinematic.js';
import type { KinematicCalibration } from '../../src/devices/calibration/kinematic.js';
import { getGroupDefaults } from '../../src/devices/calibration/defaults.js';
import type { ImuFamily, InertialGroup } from '../../src/devices/calibration/defaults.js';
import { HW, versionReply } from '../shimmer3r/configFirmware.js';

// readCalibration() over a link that goes through the client's framer: Web
// Serial, whether USB or the COM port a classic-Bluetooth pairing creates, and
// BLE once a link CRC is on. The firmware answers each per-sensor GET with
// `[ACK][response][21-byte block]` in one packet, and one CRC over the whole
// packet when a mode is set (`Comms/shimmer_bt_uart.c`: the ACK is staged at
// :1842-1846, the reply written at :2277-2289 from
// `ShimBt_replySingleSensorCalibCmd`, and the CRC appended at :2422-2427).
//
// Neither framer had a length for these replies, so a reframed link resynced
// through each one a byte at a time and every group timed out: a Shimmer3R
// over classic SPP read none of its six. The existing readCalibration test ran
// over framed BLE with no CRC, the one link that hands a whole message to the
// client per notification, and so never reached the framer.

const ACK = OPCODES.ACK_COMMAND_PROCESSED;

/**
 * The block a bench Shimmer3R returned for GET_LN_ACCEL_CALIBRATION: zero
 * offsets, sensitivity 1672 on every axis, and a ±1 alignment.
 */
const BENCH_LN_ACCEL_BLOCK = [
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x88, 0x06, 0x88, 0x06, 0x88, 0x9c, 0x00, 0x00, 0x00,
  0x64, 0x00, 0x00, 0x00, 0x9c,
];

/**
 * A different block per group, so a block applied to the wrong group, or read
 * a byte out of step, cannot pass. Each keeps bytes a resyncing framer would
 * take for the start of a message: 0x00 (a data packet), and in the others
 * 0xFF and 0xFE (an ACK and a NACK) in the z offset.
 */
function blockFor(index: number): number[] {
  const block = [...BENCH_LN_ACCEL_BLOCK];
  if (index === 0) return block;
  block[1] = index; // x offset
  block[4] = 0xff; // z offset, high byte
  block[5] = 0xfe; // z offset, low byte: -2
  return block;
}

interface CalibrationGet {
  group: InertialGroup;
  get: number;
  resp: number;
}

const SHIMMER3R_GETS: readonly CalibrationGet[] = [
  {
    group: 'lnAccel',
    get: OPCODES.GET_LN_ACCEL_CALIBRATION_COMMAND,
    resp: OPCODES.LN_ACCEL_CALIBRATION_RESPONSE,
  },
  {
    group: 'gyro',
    get: OPCODES.GET_GYRO_CALIBRATION_COMMAND,
    resp: OPCODES.GYRO_CALIBRATION_RESPONSE,
  },
  {
    group: 'mag',
    get: OPCODES.GET_MAG_CALIBRATION_COMMAND,
    resp: OPCODES.MAG_CALIBRATION_RESPONSE,
  },
  {
    group: 'wrAccel',
    get: OPCODES.GET_WR_ACCEL_CALIBRATION_COMMAND,
    resp: OPCODES.WR_ACCEL_CALIBRATION_RESPONSE,
  },
  {
    group: 'altAccel',
    get: OPCODES.GET_ALT_ACCEL_CALIBRATION_COMMAND,
    resp: OPCODES.ALT_ACCEL_CALIBRATION_RESPONSE,
  },
  {
    group: 'altMag',
    get: OPCODES.GET_ALT_MAG_CALIBRATION_COMMAND,
    resp: OPCODES.ALT_MAG_CALIBRATION_RESPONSE,
  },
];

/** The classic Shimmer3 client asks for the first four only. */
const SHIMMER3_GETS = SHIMMER3R_GETS.slice(0, 4);

/**
 * The device's end of the link: packets arrive in the order they were sent,
 * whole or a byte per read, which is the worst a serial port does.
 *
 * One queue for the link, not a timer per byte. Node keeps a timer list per
 * delay, so `setTimeout(…, i)` per byte keeps a packet in order but not two
 * packets: the SET_CRC ACK's last trailer byte and the next reply shared those
 * lists, and a tie on expiry sometimes delivered a byte of the reply ahead of
 * the reply's own ACK. A serial port cannot reorder bytes, so this must not.
 *
 * Each read is its own task, as a real one is, and `setImmediate` rather than a
 * timer: a chained `setTimeout(…, 0)` costs a timer tick per byte, which on
 * Windows is about 15 ms, and put a 25-byte reply within reach of its timeout.
 */
function wire(tr: LoopbackTransport, perByte: boolean): (packet: number[]) => void {
  const queue: number[][] = [];
  let pumping = false;
  const pump = (): void => {
    const next = queue.shift();
    if (!next) {
      pumping = false;
      return;
    }
    tr.notify(next);
    setImmediate(pump);
  };
  return (packet) => {
    if (perByte) for (const b of packet) queue.push([b]);
    else queue.push(packet);
    if (!pumping) {
      pumping = true;
      setImmediate(pump);
    }
  };
}

/** The blocks a client adopted, read off its private record of them. */
function adopted(client: object): Partial<Record<InertialGroup, { cal: KinematicCalibration }>> {
  return (
    client as {
      _btCommandCalibrations: Partial<Record<InertialGroup, { cal: KinematicCalibration }>>;
    }
  )._btCommandCalibrations;
}

/** Each group's calibration is the parse of exactly the block sent for it. */
function expectEachBlockAdopted(
  client: object,
  family: ImuFamily,
  gets: readonly CalibrationGet[],
): void {
  const read = adopted(client);
  gets.forEach(({ group }, index) => {
    const sensitivityScale = getGroupDefaults(family, group)?.sensitivityScale ?? 1;
    const expected = parseKinematicCalibBlock(new Uint8Array(blockFor(index)), {
      sensitivityScale,
    });
    expect(expected).not.toBeNull();
    expect(read[group]?.cal).toEqual(expected);
  });
}

describe('Shimmer3RClient.readCalibration over a reframed link', () => {
  /**
   * A Shimmer3R that answers SET_CRC and the six GETs as the firmware does.
   * SET_CRC switches the mode while its arguments are processed and the ACK is
   * composed afterwards, so that ACK already carries the new mode's trailer
   * (`shimmer_bt_uart.c:944`, then `:2422`).
   *
   * It also answers the version reads `setCrcMode` makes before turning a CRC
   * on, as the bench unit did: LogAndStream v1.01.017, which keeps its CRC
   * when sensing stops.
   */
  function shimmer3r(t: LoopbackTransport, perByte: boolean): void {
    let mode: CrcMode = CRC_MODE.OFF;
    const out = wire(t, perByte);
    t.setOnWrite((bytes) => {
      const send = (msg: number[]): void => out(Array.from(appendCrc(new Uint8Array(msg), mode)));
      const version = versionReply(bytes[0], HW.SHIMMER3R, [3, 1, 1, 17]);
      if (version) {
        send(version);
        return;
      }
      if (bytes[0] === OPCODES.SET_CRC_COMMAND) {
        mode = bytes[1] as CrcMode;
        send([ACK]);
        return;
      }
      const index = SHIMMER3R_GETS.findIndex((g) => g.get === bytes[0]);
      if (index >= 0) send([ACK, SHIMMER3R_GETS[index].resp, ...blockFor(index)]);
    });
  }

  const WHOLE = 'whole packets';
  const PER_BYTE = 'a byte per read';
  it.each([
    { link: 'a byte stream', reads: WHOLE, framed: false, crc: CRC_MODE.OFF },
    { link: 'a byte stream', reads: PER_BYTE, framed: false, crc: CRC_MODE.OFF },
    { link: 'a byte stream, 1-byte CRC', reads: WHOLE, framed: false, crc: CRC_MODE.ONE_BYTE },
    { link: 'a byte stream, 2-byte CRC', reads: WHOLE, framed: false, crc: CRC_MODE.TWO_BYTE },
    { link: 'a byte stream, 2-byte CRC', reads: PER_BYTE, framed: false, crc: CRC_MODE.TWO_BYTE },
    { link: 'BLE, 2-byte CRC', reads: WHOLE, framed: true, crc: CRC_MODE.TWO_BYTE },
    // The one link this always worked on, kept as the control.
    { link: 'BLE, no CRC', reads: WHOLE, framed: true, crc: CRC_MODE.OFF },
  ])('reads all six groups over $link, in $reads', async ({ reads, framed, crc }) => {
    const t = new LoopbackTransport({ capabilities: { framed } });
    shimmer3r(t, reads === PER_BYTE);
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    if (crc !== CRC_MODE.OFF) await client.setCrcMode(crc);

    const got = await client.readCalibration(500);

    expect(got).toEqual(SHIMMER3R_GETS.map((g) => g.group));
    expectEachBlockAdopted(client, 'shimmer3r', SHIMMER3R_GETS);
    for (const { group } of SHIMMER3R_GETS) {
      expect(client.calibrationInfo.inertial[group]?.source).toBe('bt-command');
    }
    expect(client.crcFailures).toBe(0);
  });
});

describe('Shimmer3Client.readCalibration over RFCOMM', () => {
  it.each(['whole packets', 'a byte per read'])(
    'reads all four groups in %s',
    async (reads) => {
      // Shimmer3Client reframes everything it receives, whatever the transport.
      const t = new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'S3' });
      const send = wire(t, reads === 'a byte per read');
      t.setOnWrite((bytes) => {
        const op = bytes[0];
        if (op === OPCODES.GET_DEVICE_VERSION_COMMAND) {
          send([OPCODES.DEVICE_VERSION_RESPONSE, 3]);
        } else if (op === OPCODES.GET_FW_VERSION_COMMAND) {
          send([OPCODES.FW_VERSION_RESPONSE, 3, 0, 0, 0, 15, 0]);
        } else {
          const index = SHIMMER3_GETS.findIndex((g) => g.get === op);
          if (index >= 0) send([ACK, SHIMMER3_GETS[index].resp, ...blockFor(index)]);
        }
      });
      const client = new Shimmer3Client({ debug: false, transport: t });
      await client.connect();

      /* The default timeout, because this client's timeout parameter is typed
         as that literal. The test's own timeout leaves room for all four
         groups to run out, so a regression fails on the assertion rather than
         the clock. */
      const got = await client.readCalibration();

      expect(got).toEqual(SHIMMER3_GETS.map((g) => g.group));
      expectEachBlockAdopted(client, 'shimmer3-old', SHIMMER3_GETS);
    },
    15_000,
  );
});
