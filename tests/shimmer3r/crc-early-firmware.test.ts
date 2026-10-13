import { describe, it, expect, vi } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import {
  CRC_MODE,
  SHIMMER3R_LINK_CRC_MIN_FIRMWARE,
  appendCrc,
  keepsLinkCrcWhenSensingStops,
  type CrcMode,
} from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { HW, versionReply, type FwTuple } from './configFirmware.js';

// Shimmer3R LogAndStream v0.00.002 to v1.00.010 turn the link CRC off by
// themselves whenever sensing stops (`S4Sens_stopSensing`, `s4_sensing.c:354`
// at v1.00.010), without telling the host. The stop's own ACK still carries
// the trailer: `BtUart_processCmd` schedules the response (task bit 6) ahead of
// the stop (task bit 12), and the scheduler runs the lowest bit first. Every
// reply after it is bare. A client still expecting the trailer then waits for
// bytes that never come, and the command after the stop is lost. v1.00.011
// removed the clear (c8016de3).
//
// The client refuses to turn a CRC on there. The device below behaves as that
// firmware does around a stop, so the regression test fails, with the next
// command timing out, if the refusal is ever removed.

const ACK = OPCODES.ACK_COMMAND_PROCESSED;

/** LogAndStream (firmware id 3) releases either side of the boundary. */
const V1_00_010: FwTuple = [3, 1, 0, 10];
const V1_00_011: FwTuple = [3, 1, 0, 11];

const CHANNELS = [0x00, 0x01, 0x02]; // LN accel
const INQUIRY_BODY = [
  OPCODES.INQUIRY_RESPONSE,
  0x80,
  0x02, // 640 ticks -> 51.2 Hz
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  CHANNELS.length,
  1,
  ...CHANNELS,
];
const TICKS_PER_FRAME = 640;

/** One LN-accel data packet, as the firmware builds it before any CRC. */
function dataPacket(ts: number): number[] {
  return [0x00, ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, 100, 0, 0xce, 0xff, 0x80, 0x3e];
}

const LINKS = [
  { name: 'BLE', framed: true },
  { name: 'classic SPP', framed: false },
] as const;
type Link = (typeof LINKS)[number];

const STOPS = [
  {
    name: 'stopStreaming',
    start: (c: Shimmer3RClient) => c.startStreaming(),
    stop: (c: Shimmer3RClient) => c.stopStreaming(),
  },
  {
    name: 'stopStreamingAndLogging',
    start: (c: Shimmer3RClient) => c.startStreamingAndLogging(),
    stop: (c: Shimmer3RClient) => c.stopStreamingAndLogging(),
  },
] as const;

const STOP_OPCODES: readonly number[] = [OPCODES.STOP_STREAMING_COMMAND, OPCODES.STOP_SDBT_COMMAND];
const START_OPCODES: readonly number[] = [
  OPCODES.START_STREAMING_COMMAND,
  OPCODES.START_SDBT_COMMAND,
];

interface DeviceOptions {
  link: Link;
  firmware: FwTuple;
  hardwareVersion?: number;
  /** Whether stopping turns the CRC off. Defaults to what the firmware version does. */
  clearsCrcAtStop?: boolean;
  /** Leave GET_FW_VERSION unanswered. */
  ignoreFwVersion?: boolean;
  /** Leave GET_DEVICE_VERSION unanswered. */
  ignoreDeviceVersion?: boolean;
}

/**
 * A Shimmer3R as its firmware behaves around a stop. Every reply is composed
 * in the CRC mode current at that moment, the way `BtUart_sendRsp` appends it
 * (`shimmer_bt_comms.c:2344` at v1.00.010). So a stop is ACKed in the old mode
 * and only then cleared, and everything after it goes out bare.
 *
 * Framed links get one notification per packet. A byte stream gets whatever
 * the OS had buffered, here 3-byte reads.
 */
function device(opts: DeviceOptions) {
  const [fwId, major, minor, internal] = opts.firmware;
  const hardwareVersion = opts.hardwareVersion ?? HW.SHIMMER3R;
  const state = {
    mode: CRC_MODE.OFF as CrcMode,
    streaming: false,
    clearsCrcAtStop:
      opts.clearsCrcAtStop ??
      !keepsLinkCrcWhenSensingStops(hardwareVersion, { fwId, major, minor, patch: internal }),
  };
  const t = new LoopbackTransport({
    capabilities: opts.link.framed ? {} : { framed: false },
  });
  const deliver = (packet: Uint8Array): void => {
    if (opts.link.framed) {
      setTimeout(() => t.notify(packet), 0);
      return;
    }
    for (let i = 0; i < packet.length; i += 3) {
      const read = packet.slice(i, i + 3);
      setTimeout(() => t.notify(read), 0);
    }
  };
  const reply = (msg: number[]): void => deliver(appendCrc(new Uint8Array(msg), state.mode));

  t.setOnWrite((bytes) => {
    const op = bytes[0];
    const version = versionReply(op, hardwareVersion, opts.firmware);
    if (version) {
      if (op === OPCODES.GET_FW_VERSION_COMMAND && opts.ignoreFwVersion) return;
      if (op === OPCODES.GET_DEVICE_VERSION_COMMAND && opts.ignoreDeviceVersion) return;
      reply(version);
    } else if (op === OPCODES.SET_CRC_COMMAND) {
      state.mode = bytes[1] as CrcMode;
      reply([ACK]);
    } else if (op === OPCODES.INQUIRY_COMMAND) {
      reply([ACK, ...INQUIRY_BODY]);
    } else if (START_OPCODES.includes(op)) {
      state.streaming = true;
      reply([ACK]);
    } else if (STOP_OPCODES.includes(op)) {
      reply([ACK]); // composed before the stop runs, so in the old mode
      state.streaming = false;
      if (state.clearsCrcAtStop) state.mode = CRC_MODE.OFF;
    }
  });

  /** Stream data, CRC'd in the device's current mode. */
  const streamFrames = (count: number): void => {
    for (let i = 0; i < count; i++) {
      deliver(appendCrc(new Uint8Array(dataPacket(1000 + i * TICKS_PER_FRAME)), state.mode));
    }
  };

  return { t, state, streamFrames };
}

/** Opcodes written to the device, in order. */
function sent(t: LoopbackTransport, from = 0): number[] {
  return t.writes.slice(from).map((w) => w.bytes[0]);
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/** Start, stream a few frames, stop, and then ask the device something new. */
async function streamStopAndAskAgain(
  client: Shimmer3RClient,
  dev: ReturnType<typeof device>,
  stop: (typeof STOPS)[number],
): Promise<void> {
  await stop.start(client);
  dev.streamFrames(4);
  await settle();
  await stop.stop(client);
  // An inquiry is never cached, so the device really is asked.
  const before = dev.t.writes.length;
  await expect(client.inquiry()).resolves.toMatchObject({ channelIds: CHANNELS });
  expect(sent(dev.t, before)).toEqual([OPCODES.INQUIRY_COMMAND]);
}

describe('a link CRC on Shimmer3R firmware that drops it when sensing stops', () => {
  for (const link of LINKS) {
    for (const stop of STOPS) {
      it(`is refused on v1.00.010 over ${link.name}, so the command after ${stop.name} is answered`, async () => {
        const dev = device({ link, firmware: V1_00_010 });
        const client = new Shimmer3RClient({ debug: false });
        await client.connect(dev.t);
        await client.inquiry();

        await expect(client.setCrcMode(CRC_MODE.TWO_BYTE)).rejects.toThrow(/v1\.00\.011/);
        expect(client.crcMode).toBe(CRC_MODE.OFF);
        expect(dev.state.mode).toBe(CRC_MODE.OFF);
        expect(sent(dev.t)).not.toContain(OPCODES.SET_CRC_COMMAND);

        await streamStopAndAskAgain(client, dev, stop);
      });
    }

    it(`is kept on v1.00.011 over ${link.name}, across a stop`, async () => {
      // The other side of the boundary, and a check on the device above: on
      // firmware that keeps the CRC, the client keeps it too and both stay in
      // step through a whole start and stop.
      const dev = device({ link, firmware: V1_00_011 });
      const client = new Shimmer3RClient({ debug: false });
      await client.connect(dev.t);
      await client.inquiry();
      const frames: Array<boolean | null> = [];
      client.onStreamFrame = (oc) => frames.push(oc.crcOk);

      await client.setCrcMode(CRC_MODE.TWO_BYTE);
      expect(dev.state.mode).toBe(CRC_MODE.TWO_BYTE);

      await streamStopAndAskAgain(client, dev, STOPS[0]);
      expect(dev.state.mode).toBe(CRC_MODE.TWO_BYTE);
      expect(client.crcMode).toBe(CRC_MODE.TWO_BYTE);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every((ok) => ok === true)).toBe(true);
      expect(client.crcFailures).toBe(0);
    });
  }

  it('refuses the one-byte CRC too', async () => {
    const dev = device({ link: LINKS[0], firmware: V1_00_010 });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(dev.t);
    await expect(client.setCrcMode(CRC_MODE.ONE_BYTE)).rejects.toThrow(/v1\.00\.011/);
    expect(sent(dev.t)).not.toContain(OPCODES.SET_CRC_COMMAND);
  });

  it('still turns the CRC off there, without asking for any version first', async () => {
    // Off is the device's own state after a stop, so it is always safe to ask for.
    const dev = device({ link: LINKS[0], firmware: V1_00_010 });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(dev.t);
    await client.setCrcMode(CRC_MODE.OFF);
    expect(sent(dev.t)).toEqual([OPCODES.SET_CRC_COMMAND]);
    expect(client.crcMode).toBe(CRC_MODE.OFF);
  });

  it('follows the hardware the device reports: a Shimmer3 on LogAndStream v1.00.008 keeps its CRC', async () => {
    /* No Shimmer3 firmware clears the CRC when sensing stops; it does so only at
       startup and on disconnect. Shimmer3 and Shimmer3R version numbers
       overlap, so the version alone cannot be the gate.

       The Shimmer3R v1.00.008 release is a side build that reports hardware 3
       for older Consensys, and it does clear the CRC. It sends exactly what
       this device sends, so it is let through too, deliberately: the gate
       believes the hardware the device reports. */
    const dev = device({ link: LINKS[1], firmware: [3, 1, 0, 8], hardwareVersion: HW.SHIMMER3 });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(dev.t);
    await client.setCrcMode(CRC_MODE.TWO_BYTE);
    expect(client.crcMode).toBe(CRC_MODE.TWO_BYTE);
    expect(dev.state.mode).toBe(CRC_MODE.TWO_BYTE);
  });

  it('refuses when the firmware version cannot be read, since it might be one of them', async () => {
    const dev = device({ link: LINKS[0], firmware: V1_00_011, ignoreFwVersion: true });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(dev.t);

    vi.useFakeTimers();
    try {
      const refused = expect(client.setCrcMode(CRC_MODE.TWO_BYTE)).rejects.toThrow(
        /firmware version could not be read/,
      );
      await vi.advanceTimersByTimeAsync(1500);
      await refused;
    } finally {
      vi.useRealTimers();
    }
    expect(sent(dev.t)).not.toContain(OPCODES.SET_CRC_COMMAND);
    expect(client.crcMode).toBe(CRC_MODE.OFF);
  });

  it('refuses when the hardware version cannot be read, since nothing could be sized', async () => {
    /* The firmware version means nothing without it, and neither can the
       status width be known. A status under a CRC would then be sized by the
       byte after its first, which can be the CRC's own. */
    const dev = device({ link: LINKS[1], firmware: V1_00_011, ignoreDeviceVersion: true });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(dev.t);

    vi.useFakeTimers();
    try {
      const refused = expect(client.setCrcMode(CRC_MODE.TWO_BYTE)).rejects.toThrow(
        /hardware version could not be read/,
      );
      await vi.advanceTimersByTimeAsync(1500);
      await refused;
    } finally {
      vi.useRealTimers();
    }
    expect(sent(dev.t)).toEqual([OPCODES.GET_DEVICE_VERSION_COMMAND]);
    expect(client.crcMode).toBe(CRC_MODE.OFF);
  });

  it('still refuses mid-stream when a stream starts while the versions are checked', async () => {
    /* The check awaits before SET_CRC goes out, so the refusal to change the
       width mid-stream has to be made again after it. Deterministic: with the
       versions cached the check yields only to microtasks, and with the CRC
       off a framed link marks the stream started before the start command's
       first await. */
    const dev = device({ link: LINKS[0], firmware: V1_00_011 });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(dev.t);
    await client.readDeviceVersion();
    await client.readFwVersion();

    const switching = client.setCrcMode(CRC_MODE.TWO_BYTE);
    const starting = client.startStreaming();
    await expect(switching).rejects.toThrow(/while streaming/);
    await starting;
    expect(sent(dev.t)).not.toContain(OPCODES.SET_CRC_COMMAND);
    expect(dev.state.mode).toBe(CRC_MODE.OFF);
    expect(client.crcMode).toBe(CRC_MODE.OFF);
    await client.stopStreaming();
  });

  it('a reconnect to such a device says why the CRC is off, and keeps the request for the next one', async () => {
    const client = new Shimmer3RClient({ debug: false });
    const statuses: string[] = [];
    client.onStatus = (s) => statuses.push(s);

    const fixed = device({ link: LINKS[1], firmware: V1_00_011 });
    await client.connect(fixed.t);
    await client.setCrcMode(CRC_MODE.TWO_BYTE);
    await client.disconnect();

    // The re-establish on connect is refused, reported, and the link carries on.
    const early = device({ link: LINKS[1], firmware: V1_00_010 });
    await client.connect(early.t);
    expect(client.crcMode).toBe(CRC_MODE.OFF);
    expect(sent(early.t)).not.toContain(OPCODES.SET_CRC_COMMAND);
    expect(statuses.some((s) => /Could not re-enable.*v1\.00\.011/.test(s))).toBe(true);
    await streamStopAndAskAgain(client, early, STOPS[0]);
    await client.disconnect();

    // The request outlived the refusal, so a device that can keep it gets it.
    const later = device({ link: LINKS[1], firmware: V1_00_011 });
    await client.connect(later.t);
    expect(client.crcMode).toBe(CRC_MODE.TWO_BYTE);
    expect(later.state.mode).toBe(CRC_MODE.TWO_BYTE);
  });
});

describe('keepsLinkCrcWhenSensingStops', () => {
  const fw = (major: number, minor: number, patch: number, fwId = 3) => ({
    fwId,
    major,
    minor,
    patch,
  });

  it('is false for every Shimmer3R LogAndStream release before v1.00.011', () => {
    // Every release tag that carries the clear: v0.00.002 and v1.00.005 to v1.00.010.
    for (const v of [fw(0, 0, 2), fw(1, 0, 5), fw(1, 0, 7), fw(1, 0, 10)]) {
      expect(keepsLinkCrcWhenSensingStops(HW.SHIMMER3R, v)).toBe(false);
    }
  });

  it('is true from v1.00.011, the first release without the clear', () => {
    expect(SHIMMER3R_LINK_CRC_MIN_FIRMWARE).toEqual({ major: 1, minor: 0, internal: 11 });
    for (const v of [fw(1, 0, 11), fw(1, 0, 60), fw(1, 1, 0), fw(1, 1, 17), fw(2, 0, 0)]) {
      expect(keepsLinkCrcWhenSensingStops(HW.SHIMMER3R, v)).toBe(true);
    }
  });

  it('is true on a Shimmer3, whatever the version, since no Shimmer3 firmware clears it', () => {
    for (const v of [fw(0, 11, 0), fw(0, 16, 13), fw(1, 0, 8), fw(1, 0, 10)]) {
      expect(keepsLinkCrcWhenSensingStops(HW.SHIMMER3, v)).toBe(true);
    }
  });

  it('is true for a firmware other than LogAndStream, which it has no evidence about', () => {
    expect(keepsLinkCrcWhenSensingStops(HW.SHIMMER3R, fw(1, 0, 5, 2))).toBe(true);
  });
});
