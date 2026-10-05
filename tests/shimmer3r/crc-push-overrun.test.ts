import { describe, it, expect, vi } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import {
  CRC_MODE,
  SHIMMER3R_STATUS_PUSH_BUFFER_FIX_FIRMWARE,
  appendCrc,
  twoByteCrcOverrunsStatusPush,
  type CrcMode,
} from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { HW, versionReply, type FwTuple } from './configFirmware.js';

// Shimmer3R LogAndStream v1.00.024 to v1.00.049 build the unsolicited status
// push in a six-byte stack buffer, `uint8_t selfcmd[6]`
// (`ShimBt_instreamStatusRespSend`, log-and-stream-common
// `Comms/shimmer_bt_uart.c:2262` at f39be8c1f, which v1.00.049 pins). The push
// is the ACK prefix the firmware defaults to, 0x8A 0x71 and two status bytes,
// so a 2-byte link CRC makes seven, and the seventh byte overruns the buffer.
// The sensor hardfaults (DEV-621). v1.00.050 made the buffer big enough.
//
// setCrcMode(2) turns the prefix off first on those releases
// (SET_INSTREAM_RESPONSE_ACK_PREFIX_STATE, 0xA3), and the push is six bytes.
//
// The devices below fault the way that firmware does: a push that does not fit
// the release's buffer takes the device off the air. So these tests fail if the
// client ever lets a 2-byte CRC onto one of those releases with the prefix
// still on.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
const NACK = OPCODES.NACK_COMMAND_PROCESSED; // 0xFE
const INSTREAM = OPCODES.INSTREAM_CMD_RESPONSE; // 0x8A
const STATUS = OPCODES.STATUS_RESPONSE; // 0x71
const VBATT = OPCODES.VBATT_RESPONSE; // 0x94
const ACK_PREFIX = OPCODES.SET_INSTREAM_RESPONSE_ACK_PREFIX_STATE; // 0xA3

/** Status byte 0 on docking: docked, nothing else. */
const DOCKED = 0x01;
/** The battery reply's payload, and the ADC value it decodes to. */
const BATT_RAW = [0x00, 0x0a, 0x40];
const BATT_ADC = 0x0a00;

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

interface Release {
  name: string;
  hw: number;
  fw: FwTuple;
  /** Status bytes in a STATUS_RESPONSE, read off the firmware source. */
  statusBytes: 1 | 2;
  /**
   * The push's stack buffer, read off the firmware source: `selfcmd[6]` on a
   * Shimmer3R before v1.00.050, and `3 + STATUS_BYTE_COUNT +
   * CRC_MAX_SUPPORTED_BYTES` on the releases that carry DEV-621's fix.
   */
  pushBuffer: number;
}

/** The first and last releases whose push a 2-byte CRC overruns behind the prefix. */
const OVERRUN: readonly Release[] = [
  {
    name: 'Shimmer3R LogAndStream v1.00.024',
    hw: HW.SHIMMER3R,
    fw: [3, 1, 0, 24],
    statusBytes: 2,
    pushBuffer: 6,
  },
  {
    name: 'Shimmer3R LogAndStream v1.00.049',
    hw: HW.SHIMMER3R,
    fw: [3, 1, 0, 49],
    statusBytes: 2,
    pushBuffer: 6,
  },
];

/** The releases either side of them, and a Shimmer3: their push fits whatever the prefix. */
const FITS: readonly Release[] = [
  // One status byte, so six bytes at most
  {
    name: 'Shimmer3R LogAndStream v1.00.023',
    hw: HW.SHIMMER3R,
    fw: [3, 1, 0, 23],
    statusBytes: 1,
    pushBuffer: 6,
  },
  // DEV-621's fix: 3 + 2 + 3
  {
    name: 'Shimmer3R LogAndStream v1.00.050',
    hw: HW.SHIMMER3R,
    fw: [3, 1, 0, 50],
    statusBytes: 2,
    pushBuffer: 8,
  },
  // Every Shimmer3 release sends one status byte, and this one has the fix: 3 + 1 + 3
  {
    name: 'Shimmer3 LogAndStream v1.01.005',
    hw: HW.SHIMMER3,
    fw: [3, 1, 1, 5],
    statusBytes: 1,
    pushBuffer: 7,
  },
];

const V1_00_049 = OVERRUN[1];

const LINKS = [
  { name: 'BLE', framed: true },
  { name: 'a byte stream', framed: false },
] as const;
type Link = (typeof LINKS)[number];

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface DeviceOptions {
  /**
   * How the firmware answers SET_INSTREAM_RESPONSE_ACK_PREFIX_STATE. Every
   * release ACKs it; `hold` keeps the ACK back until `releasePrefixAck()`.
   */
  prefixCommand?: 'ack' | 'nack' | 'ignore' | 'hold';
}

/**
 * A sensor running `release`, as its firmware composes what it sends: each
 * reply is one packet, with the CRC in force when it is composed over the
 * whole of it. A framed link gets one notification per packet; a byte stream
 * gets 3-byte reads.
 */
function device(release: Release, link: Link, opts: DeviceOptions = {}) {
  const state = {
    mode: CRC_MODE.OFF as CrcMode,
    ackPrefix: true,
    /** Set by a push that overran its buffer. The device answers nothing after it. */
    hardfaulted: false,
  };
  const t = new LoopbackTransport({ capabilities: link.framed ? {} : { framed: false } });
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
  const send = (msg: number[]): void => deliver(appendCrc(new Uint8Array(msg), state.mode));
  const status = (s0: number): number[] => (release.statusBytes === 2 ? [s0, 1] : [s0]);
  let heldPrefixAck: (() => void) | null = null;

  t.setOnWrite((bytes) => {
    if (state.hardfaulted) return;
    const op = bytes[0];
    const version = versionReply(op, release.hw, release.fw);
    if (version) {
      send(version);
    } else if (op === ACK_PREFIX) {
      const how = opts.prefixCommand ?? 'ack';
      if (how === 'ignore') return;
      if (how === 'nack') return send([NACK]);
      // Applied while the command is processed (`:867`), and ACKed after
      state.ackPrefix = bytes[1] !== 0;
      if (how === 'hold') heldPrefixAck = () => send([ACK]);
      else send([ACK]);
    } else if (op === OPCODES.SET_CRC_COMMAND) {
      // Switched while the command is processed, so its own ACK has the new trailer
      state.mode = bytes[1] as CrcMode;
      send([ACK]);
    } else if (op === OPCODES.INQUIRY_COMMAND) {
      send([ACK, ...INQUIRY_BODY]);
    } else if (op === OPCODES.GET_VBATT_COMMAND) {
      send([ACK, INSTREAM, VBATT, ...BATT_RAW]);
    } else if (op === OPCODES.START_STREAMING_COMMAND || op === OPCODES.STOP_STREAMING_COMMAND) {
      send([ACK]);
    } else {
      send([NACK]);
    }
  });

  return {
    t,
    state,
    /**
     * An unsolicited status, as on docking, composed the way
     * `ShimBt_instreamStatusRespSend` composes it: behind the prefix while it is
     * on, with the CRC on top. One that does not fit the buffer is the hardfault.
     */
    push(s0: number): void {
      if (state.hardfaulted) return;
      const msg = [...(state.ackPrefix ? [ACK] : []), INSTREAM, STATUS, ...status(s0)];
      const packet = appendCrc(new Uint8Array(msg), state.mode);
      if (packet.length > release.pushBuffer) {
        state.hardfaulted = true;
        return;
      }
      deliver(packet);
    },
    /** Stream data, CRC'd in the device's current mode. */
    streamFrames(from: number, count: number): void {
      for (let i = 0; i < count; i++) send(dataPacket((from + i) * TICKS_PER_FRAME));
    },
    /**
     * The link drops. The firmware turns the CRC off and then the prefix back on
     * (`ShimBt_handleBtRfCommStateChange`, `:2349-2351`).
     */
    dropLink(): void {
      state.mode = CRC_MODE.OFF;
      state.ackPrefix = true;
      t.emitDisconnect(new Error('link lost'));
    },
    /** Send the ACK a `hold` device kept back. */
    releasePrefixAck(): void {
      heldPrefixAck?.();
      heldPrefixAck = null;
    },
  };
}

/** Opcodes written to the device, in order, from write `from` on. */
function sent(t: LoopbackTransport, from = 0): number[] {
  return t.writes.slice(from).map((w) => w.bytes[0]);
}

/** True when the prefix command went out, with 0, before SET_CRC did. */
function prefixOffBeforeCrc(t: LoopbackTransport, from = 0): boolean {
  const writes = t.writes.slice(from).map((w) => Array.from(w.bytes));
  const prefix = writes.findIndex((w) => w[0] === ACK_PREFIX);
  const crc = writes.findIndex((w) => w[0] === OPCODES.SET_CRC_COMMAND);
  return prefix >= 0 && crc > prefix && writes[prefix][1] === 0;
}

async function connected(dev: ReturnType<typeof device>): Promise<Shimmer3RClient> {
  const client = new Shimmer3RClient({ debug: false });
  await client.connect(dev.t);
  return client;
}

describe('twoByteCrcOverrunsStatusPush', () => {
  const fw = (major: number, minor: number, patch: number, fwId = 3) => ({
    fwId,
    major,
    minor,
    patch,
  });

  it('is true on Shimmer3R LogAndStream v1.00.024 to v1.00.049', () => {
    expect(SHIMMER3R_STATUS_PUSH_BUFFER_FIX_FIRMWARE).toEqual({ major: 1, minor: 0, internal: 50 });
    for (const internal of [24, 25, 40, 49]) {
      expect(twoByteCrcOverrunsStatusPush(HW.SHIMMER3R, fw(1, 0, internal))).toBe(true);
    }
  });

  it('is false either side: one status byte before v1.00.024, room for the CRC from v1.00.050', () => {
    for (const v of [fw(0, 0, 2), fw(1, 0, 11), fw(1, 0, 23), fw(1, 0, 50), fw(1, 1, 17)]) {
      expect(twoByteCrcOverrunsStatusPush(HW.SHIMMER3R, v)).toBe(false);
    }
    expect(twoByteCrcOverrunsStatusPush(HW.SHIMMER3R, fw(2, 0, 0))).toBe(false);
  });

  it('is false on a Shimmer3, whose version numbers run through the same range', () => {
    expect(twoByteCrcOverrunsStatusPush(HW.SHIMMER3, fw(1, 0, 30))).toBe(false);
  });

  it('is false on firmware other than LogAndStream', () => {
    expect(twoByteCrcOverrunsStatusPush(HW.SHIMMER3R, fw(1, 0, 30, 2))).toBe(false);
  });

  it('agrees with the byte count of every scripted release', () => {
    // Prefix, 0x8A 0x71, the status and a 2-byte CRC, against the buffer
    for (const r of [...OVERRUN, ...FITS]) {
      const [fwId, major, minor, patch] = r.fw;
      const overruns = 1 + 2 + r.statusBytes + 2 > r.pushBuffer;
      expect(twoByteCrcOverrunsStatusPush(r.hw, { fwId, major, minor, patch })).toBe(overruns);
    }
  });
});

describe('the scripted firmware', () => {
  // A check on the device double: unless it does fault, the "did not hardfault"
  // assertions below prove nothing.
  it('hardfaults on a push that a 2-byte CRC behind the prefix takes past its buffer', () => {
    const dev = device(V1_00_049, LINKS[0]);
    dev.state.mode = CRC_MODE.TWO_BYTE;
    dev.push(DOCKED);
    expect(dev.state.hardfaulted).toBe(true);
  });

  it('fits the same push once the prefix is off', () => {
    const dev = device(V1_00_049, LINKS[0]);
    dev.state.mode = CRC_MODE.TWO_BYTE;
    dev.state.ackPrefix = false;
    dev.push(DOCKED);
    expect(dev.state.hardfaulted).toBe(false);
  });
});

for (const link of LINKS) {
  for (const release of OVERRUN) {
    describe(`${release.name} over ${link.name}`, () => {
      it('turns the push ACK prefix off before a 2-byte CRC, so a push fits', async () => {
        const dev = device(release, link);
        const client = await connected(dev);
        await client.setCrcMode(CRC_MODE.TWO_BYTE);

        expect(prefixOffBeforeCrc(dev.t)).toBe(true);
        expect(dev.state).toMatchObject({ ackPrefix: false, mode: CRC_MODE.TWO_BYTE });
        expect(client.crcMode).toBe(CRC_MODE.TWO_BYTE);

        const spy = vi.fn();
        client.onDeviceStatus = spy;
        dev.push(DOCKED);
        await tick(5);
        expect(dev.state.hardfaulted).toBe(false);
        // Reported without its prefix, and the CRC checked
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toMatchObject({ docked: true, usbPluggedIn: true });
        expect((await client.getBattery()).adcValue).toBe(BATT_ADC);
        expect(client.crcFailures).toBe(0);
      });

      it('leaves the prefix alone for a 1-byte CRC, whose push fits anyway', async () => {
        const dev = device(release, link);
        const client = await connected(dev);
        await client.setCrcMode(CRC_MODE.ONE_BYTE);
        expect(sent(dev.t)).not.toContain(ACK_PREFIX);

        const spy = vi.fn();
        client.onDeviceStatus = spy;
        dev.push(DOCKED);
        await tick(5);
        expect(dev.state.hardfaulted).toBe(false);
        expect(spy).toHaveBeenCalledTimes(1);
        expect((await client.getBattery()).adcValue).toBe(BATT_ADC);
        expect(client.crcFailures).toBe(0);
      });

      it('turns it off again on the next link, before the CRC goes back on', async () => {
        // The firmware puts the prefix back when the link drops, and the client
        // asks for the 2-byte CRC again on reconnect.
        const dev = device(release, link);
        const client = await connected(dev);
        await client.setCrcMode(CRC_MODE.TWO_BYTE);
        dev.dropLink();
        expect(dev.state.ackPrefix).toBe(true);

        const before = dev.t.writes.length;
        await client.connect(dev.t);
        expect(prefixOffBeforeCrc(dev.t, before)).toBe(true);
        expect(client.crcMode).toBe(CRC_MODE.TWO_BYTE);
        expect(dev.state).toMatchObject({ ackPrefix: false, mode: CRC_MODE.TWO_BYTE });

        dev.push(DOCKED);
        await tick(5);
        expect(dev.state.hardfaulted).toBe(false);
        expect((await client.getBattery()).adcValue).toBe(BATT_ADC);
      });
    });
  }

  for (const release of FITS) {
    it(`sends ${release.name} over ${link.name} a 2-byte CRC alone, and its push still fits`, async () => {
      const dev = device(release, link);
      const client = await connected(dev);
      await client.setCrcMode(CRC_MODE.TWO_BYTE);
      expect(sent(dev.t)).not.toContain(ACK_PREFIX);
      expect(dev.state).toMatchObject({ ackPrefix: true, mode: CRC_MODE.TWO_BYTE });

      const spy = vi.fn();
      client.onDeviceStatus = spy;
      dev.push(DOCKED);
      await tick(5);
      expect(dev.state.hardfaulted).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ docked: true });
      expect((await client.getBattery()).adcValue).toBe(BATT_ADC);
      expect(client.crcFailures).toBe(0);
    });
  }
}

describe('a push in the middle of a 2-byte CRC stream (DEV-621)', () => {
  for (const link of LINKS) {
    it(`leaves the sensor up over ${link.name}, and the command after the stop is answered`, async () => {
      // The case the firmware ticket names: streaming, and a push from undocking.
      const dev = device(V1_00_049, link);
      const client = await connected(dev);
      await client.inquiry();
      await client.setCrcMode(CRC_MODE.TWO_BYTE);
      const frames: Array<boolean | null> = [];
      client.onStreamFrame = (oc) => frames.push(oc.crcOk);

      await client.startStreaming();
      dev.streamFrames(1, 4);
      await tick(10);
      dev.push(0x1a); // undocked, streaming, logging, sensing
      dev.streamFrames(5, 4);
      await tick(10);
      expect(dev.state.hardfaulted).toBe(false);

      await client.stopStreaming();
      await expect(client.inquiry()).resolves.toMatchObject({ channelIds: CHANNELS });
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every((ok) => ok === true)).toBe(true);
    });
  }
});

describe('when the device will not turn the prefix off', () => {
  for (const link of LINKS) {
    it(`refuses the 2-byte CRC on a NACK over ${link.name}, sending no SET_CRC`, async () => {
      const dev = device(V1_00_049, link, { prefixCommand: 'nack' });
      const client = await connected(dev);
      await expect(client.setCrcMode(CRC_MODE.TWO_BYTE)).rejects.toThrow(
        /LogAndStream v1\.00\.049 hardfaults.*Use a 1-byte CRC, or update to LogAndStream v1\.00\.050/,
      );
      expect(sent(dev.t)).not.toContain(OPCODES.SET_CRC_COMMAND);
      expect(client.crcMode).toBe(CRC_MODE.OFF);
      expect(dev.state.mode).toBe(CRC_MODE.OFF);

      // A 1-byte CRC never needed the prefix off.
      await client.setCrcMode(CRC_MODE.ONE_BYTE);
      dev.push(DOCKED);
      await tick(5);
      expect(dev.state.hardfaulted).toBe(false);
      expect((await client.getBattery()).adcValue).toBe(BATT_ADC);
    });
  }

  it('refuses it when the prefix command is not answered', async () => {
    const dev = device(V1_00_049, LINKS[0], { prefixCommand: 'ignore' });
    const client = await connected(dev);
    // Read first, so the prefix command's own timeout is the only wait left.
    await client.readDeviceVersion();
    await client.readFwVersion();

    vi.useFakeTimers();
    try {
      const refused = expect(client.setCrcMode(CRC_MODE.TWO_BYTE)).rejects.toThrow(
        /turning the prefix off failed \(ACK timeout\)/,
      );
      await vi.advanceTimersByTimeAsync(1500);
      await refused;
    } finally {
      vi.useRealTimers();
    }
    expect(sent(dev.t)).not.toContain(OPCODES.SET_CRC_COMMAND);
    expect(client.crcMode).toBe(CRC_MODE.OFF);
  });

  it('still refuses mid-stream when a stream starts while the prefix command is answered', async () => {
    /* The prefix command is a round trip of its own between the version check
       and SET_CRC, so the refusal to change the width mid-stream is made again
       after it. The ACK is held until the stream has started. */
    const dev = device(V1_00_049, LINKS[0], { prefixCommand: 'hold' });
    const client = await connected(dev);
    await client.readDeviceVersion();
    await client.readFwVersion();

    const switching = client.setCrcMode(CRC_MODE.TWO_BYTE);
    await tick();
    expect(sent(dev.t)).toContain(ACK_PREFIX);
    const starting = client.startStreaming();
    dev.releasePrefixAck();
    await expect(switching).rejects.toThrow(/while streaming/);
    await starting;
    expect(sent(dev.t)).not.toContain(OPCODES.SET_CRC_COMMAND);
    expect(client.crcMode).toBe(CRC_MODE.OFF);
    await client.stopStreaming();
  });

  it('a reconnect that cannot have its two bytes says why, and carries on without a CRC', async () => {
    const client = new Shimmer3RClient({ debug: false });
    const statuses: string[] = [];
    client.onStatus = (s) => statuses.push(s);

    const first = device(V1_00_049, LINKS[1]);
    await client.connect(first.t);
    await client.setCrcMode(CRC_MODE.TWO_BYTE);
    await client.disconnect();

    const second = device(V1_00_049, LINKS[1], { prefixCommand: 'nack' });
    await client.connect(second.t);
    expect(client.crcMode).toBe(CRC_MODE.OFF);
    expect(sent(second.t)).not.toContain(OPCODES.SET_CRC_COMMAND);
    expect(statuses.some((s) => /Could not re-enable the 2-byte CRC.*v1\.00\.050/.test(s))).toBe(
      true,
    );

    second.push(DOCKED);
    await tick(5);
    expect(second.state.hardfaulted).toBe(false);
    expect((await client.getBattery()).adcValue).toBe(BATT_ADC);
  });
});
