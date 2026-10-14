import { describe, it, expect } from 'vitest';
import { Shimmer3Client } from '../../src/devices/shimmer3/Shimmer3Client.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

/* The reconnect race review found in Shimmer3RClient, in the classic client.
   A command whose ACK or reply was awaited when the link dropped kept its
   waiter, and every waiter sees every message: on the next link it took the
   first ACK or matching reply as its own. Nothing reset the link's own state
   either, and every write went to whichever transport was current, so an
   operation the drop stranded part-way went on over the next link. */

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const INQ_RSP = OPCODES.INQUIRY_RESPONSE;
const DEVVER = OPCODES.DEVICE_VERSION_RESPONSE;
const FWVER = OPCODES.FW_VERSION_RESPONSE;

// Classic-Shimmer3 inquiry response, 51.2 Hz, gyro X/Y/Z (see transport-loopback.test.ts)
const INQUIRY_MSG = [INQ_RSP, 0x80, 0x02, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x0a, 0x0b, 0x0c];
/** FW_VERSION_RESPONSE for LogAndStream 0.<minor>.0: the minor tells two devices apart. */
const fw = (minor: number): number[] => [FWVER, 3, 0, 0, 0, minor, 0];
const infomem = (n: number): number[] => [
  OPCODES.INFOMEM_RESPONSE,
  n,
  ...Array.from({ length: n }, (_, k) => 0x40 + k),
];
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const gates = (c: Shimmer3Client): { awaitCmd: number; awaitInq: number } => {
  const internals = c as unknown as { _awaitCmd: number; _awaitInq: number };
  return { awaitCmd: internals._awaitCmd, awaitInq: internals._awaitInq };
};

/** What a device sends back for a command, or `null` for nothing at all. */
type Answer = (cmd: Uint8Array) => number[] | null;

/**
 * A Shimmer3 running LogAndStream 0.<minor>.0: it answers the connect
 * handshake, and every other command as `answer` says - by default with an ACK.
 */
function shimmer3(answer: Answer = () => [ACK], minor = 15) {
  const replyTo = (cmd: Uint8Array): number[] | null => {
    switch (cmd[0]) {
      case OPCODES.STOP_STREAMING_COMMAND:
      case OPCODES.GET_SAMPLING_RATE_COMMAND:
        return null; // the handshake flushes whatever these produce
      case OPCODES.GET_DEVICE_VERSION_COMMAND:
        return [DEVVER, 3];
      case OPCODES.GET_FW_VERSION_COMMAND:
        return fw(minor);
      default:
        return answer(cmd);
    }
  };
  return (bytes: Uint8Array, tr: LoopbackTransport): void => {
    const reply = replyTo(bytes);
    if (reply) setTimeout(() => tr.notify(reply), 0);
  };
}

/** An RFCOMM link to {@link shimmer3}. */
function device(answer?: Answer, minor?: number): LoopbackTransport {
  const t = new LoopbackTransport({ capabilities: { framed: false } });
  t.setOnWrite(shimmer3(answer, minor));
  return t;
}

/** A link whose transport holds the write of `opcode`, never answered, until `release()`. */
function holding(opcode: number): { t: LoopbackTransport; release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((r) => (release = r));
  const answer = shimmer3();
  const t = new LoopbackTransport({ capabilities: { framed: false } });
  t.setOnWrite(async (bytes, tr) => {
    if (bytes[0] === opcode) await held;
    else answer(bytes, tr);
  });
  return { t, release };
}

const silentTo =
  (opcode: number): Answer =>
  (cmd) =>
    cmd[0] === opcode ? null : [ACK];

describe('a command pending when the link drops', () => {
  it('fails at the reset, not at the next traffic or its own timeout', async () => {
    const first = device(silentTo(OPCODES.SET_SAMPLING_RATE_COMMAND));
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first);
    const stranded = client.setSamplingRate(51.2).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20); // its ACK is awaited
    first.emitDisconnect(new Error('dropped'));
    // Nothing has arrived on any link since, so only the reset can fail it
    const early = await Promise.race([stranded, tick(200).then(() => 'still waiting')]);
    expect(early).toMatch(/link was reset/);
    expect(gates(client)).toEqual({ awaitCmd: 0, awaitInq: 0 });
  });

  it("does not take the next link's ACK", async () => {
    const first = device(silentTo(OPCODES.SET_SAMPLING_RATE_COMMAND));
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first);
    const stranded = client.setSamplingRate(51.2).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20);
    first.emitDisconnect(new Error('dropped'));

    await client.connect(device());
    await client.setGSRRange(2);
    expect(await stranded).toMatch(/link was reset/);
    expect(client.samplingRateHz).toBe(0); // no device ever ACKed the rate
  });

  it("a read waiting for its reply does not take the next link's", async () => {
    const first = device(silentTo(OPCODES.GET_INFOMEM_COMMAND));
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first);
    const stranded = client.readInfoMem(0, 16).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20);
    first.emitDisconnect(new Error('dropped'));

    await client.connect(
      device((cmd) => (cmd[0] === OPCODES.GET_INFOMEM_COMMAND ? infomem(cmd[1]) : [ACK])),
    );
    const data = await client.readInfoMem(0, 16);
    expect(Array.from(data)).toEqual(infomem(16).slice(2));
    expect(await stranded).toMatch(/link was reset/);
  });

  it("a write still in flight at the reset does not take the next link's ACK", async () => {
    /* The write is asynchronous. One the old transport still held at the drop
       completed once the next link was up, and its command's waiter then took
       that link's first ACK. */
    const first = holding(OPCODES.SET_SAMPLING_RATE_COMMAND);
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first.t);
    const stranded = client.setSamplingRate(51.2).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20); // its write is held
    first.t.emitDisconnect(new Error('dropped'));

    await client.connect(device());
    const gsr = client.setGSRRange(2);
    // The old write completes just before the next link's ACK arrives, so its
    // command would be first in line for it
    first.release();
    await gsr;
    expect(await stranded).toMatch(/link was reset/);
    expect(client.samplingRateHz).toBe(0);
  });

  it('an inquiry stranded on the old link leaves the next link dropping a stray 0x02', async () => {
    const first = device(silentTo(OPCODES.INQUIRY_COMMAND));
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first);
    const stranded = client.inquiry().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20); // its response is awaited, so a 0x02 is being framed
    first.emitDisconnect(new Error('dropped'));

    /* A stray 0x02 - a leaked stream byte - just ahead of the genuine ACK.
       With no inquiry awaited on this link it is dropped; framed as an inquiry
       response it would take 9 + 3 bytes, the ACK the last of them. */
    const stray = [INQ_RSP, 0, 0, 0, 0, 0, 0, 3, 0, 0xaa, 0xbb];
    await client.connect(
      device((cmd) => (cmd[0] === OPCODES.SET_GSR_RANGE_COMMAND ? [...stray, ACK] : [ACK])),
    );
    await expect(client.setGSRRange(2)).resolves.toEqual({ gsrRange: 2 });
    expect(await stranded).toMatch(/link was reset/);
  });
});

describe('an operation the drop strands part-way', () => {
  it('the connect handshake does not go on over the next link', async () => {
    const first = device();
    const client = new Shimmer3Client({ debug: false });
    const stranded = client.connect(first).then(
      () => 'connected',
      (e: Error) => e.message,
    );
    await tick(60); // inside its 250 ms flush, before it asks for either version
    first.emitDisconnect(new Error('dropped'));

    const second = device(undefined, 16);
    await client.connect(second);
    expect(await stranded).toMatch(/link was reset/);
    // The next link carried its own handshake, and nothing of the old one's
    expect(second.writes.map((w) => w.bytes[0])).toEqual([
      OPCODES.STOP_STREAMING_COMMAND,
      OPCODES.GET_SAMPLING_RATE_COMMAND,
      OPCODES.GET_DEVICE_VERSION_COMMAND,
      OPCODES.GET_FW_VERSION_COMMAND,
    ]);
    expect(client.firmwareVersion?.minor).toBe(16);
  });

  it("a stop's drain does not hold back the next link's replies", async () => {
    const first = device();
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first);
    // Not streaming, so the drain only accumulates, as when quiescing a device
    // left streaming unattended; a stream byte every 20 ms keeps it draining
    const noise = setInterval(() => first.notify([0x11]), 20);
    const stopping = client.stopStreaming();
    await tick(60);
    clearInterval(noise);
    first.emitDisconnect(new Error('dropped'));

    // The handshake's replies reach it, rather than wait behind the old drain
    await client.connect(device(undefined, 16));
    expect(client.firmwareVersion?.minor).toBe(16);
    await stopping;
  });

  it("a pressure-calibration read held across a reconnect leaves the next device's alone", async () => {
    /* Its first command's write is still held when the link drops. Released
       only after the reconnect, the read went on to ask the next device the
       two legacy commands, and when they went unanswered it cleared that
       device's calibration and blamed the firmware. */
    const first = holding(OPCODES.GET_PRESSURE_CALIBRATION_COEFFICIENTS_COMMAND);
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first.t);
    const stranded = client.readPressureCalibration();
    await tick(20); // its write is held
    first.t.emitDisconnect(new Error('dropped'));

    // A BMP581 - its id and no coefficients, since it compensates on-chip - on
    // firmware that serves only the modern command
    const second = device((cmd) =>
      cmd[0] === OPCODES.GET_PRESSURE_CALIBRATION_COEFFICIENTS_COMMAND
        ? [ACK, OPCODES.PRESSURE_CALIBRATION_COEFFICIENTS_RESPONSE, 1, 3]
        : null,
    );
    await client.connect(second);
    expect((await client.readPressureCalibration())?.sensor).toBe('bmp581');
    first.release(); // the old transport lets go only now
    expect(await stranded).toBeNull();
    expect(client.pressureCalibration?.sensor).toBe('bmp581');
    expect(second.writes.map((w) => w.bytes[0])).not.toContain(
      OPCODES.GET_BMP280_CALIBRATION_COEFFICIENTS_COMMAND,
    );
    // Room for the stranded read's three 2 s response timeouts, which is how
    // it fails where a reset does not stop it
  }, 10000);

  it('setSensors fails, rather than report success, when the link drops before its re-inquiry', async () => {
    const first = device();
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first);
    // Dropped between the SET's ACK and the inquiry: a status callback can do it
    client.onStatus = (m) => {
      if (m.startsWith('Sensors ACKed')) first.emitDisconnect(new Error('dropped'));
    };
    await expect(client.setSensors(0x000080)).rejects.toThrow();
    expect(first.writes.map((w) => w.bytes[0])).not.toContain(OPCODES.INQUIRY_COMMAND);
  });

  it('an ExG preset dropped part-way fails, rather than finish on the next device', async () => {
    const exg = (cmd: Uint8Array): number[] | null => {
      switch (cmd[0]) {
        case OPCODES.GET_EXG_REGS_COMMAND:
          return [ACK, OPCODES.EXG_REGS_RESPONSE, 10, ...new Array<number>(10).fill(0)];
        case OPCODES.INQUIRY_COMMAND:
          return [ACK, ...INQUIRY_MSG];
        default:
          return [ACK];
      }
    };
    const first = device(exg);
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first);
    const said: string[] = [];
    client.onStatus = (m) => {
      said.push(m);
      if (m.startsWith('ExG registers written')) first.emitDisconnect(new Error('dropped'));
    };
    await expect(client.applyExgPresetLive('ecg', '24bit')).rejects.toThrow();
    // The sensors were never set, so the preset was not applied
    expect(first.writes.map((w) => w.bytes[0])).not.toContain(OPCODES.SET_SENSORS_COMMAND);
    expect(said.some((m) => /preset .* applied/.test(m))).toBe(false);
  });

  it('readCalibration fails at a drop, rather than skip to a partial result', async () => {
    const first = device(silentTo(OPCODES.GET_LN_ACCEL_CALIBRATION_COMMAND));
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first);
    const reading = client.readCalibration().then(
      (groups) => groups,
      (e: Error) => e.message,
    );
    await tick(20); // the first group's reply is awaited
    first.emitDisconnect(new Error('dropped'));
    expect(await reading).toMatch(/link was reset/);
    expect(first.writes.map((w) => w.bytes[0])).not.toContain(OPCODES.GET_GYRO_CALIBRATION_COMMAND);
  });
});

describe('a status callback that ends the link', () => {
  it("before a SET's write leaves the command unsent, not ACKed by the dropped transport", async () => {
    const first = device();
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first);
    client.onStatus = (m) => {
      if (m.startsWith('SET_GSR_RANGE →')) first.emitDisconnect(new Error('dropped'));
    };
    await expect(client.setGSRRange(2)).rejects.toThrow(/link was reset|Not connected/);
    expect(client.gsrRangeSetting).toBe(0);
    expect(first.writes.map((w) => w.bytes[0])).not.toContain(OPCODES.SET_GSR_RANGE_COMMAND);
  });

  it("during an inquiry's warnings keeps the old device's schema from being applied", async () => {
    // Channel 0xEE is one this SDK cannot describe, so the inquiry warns about it
    const unknownChannel = [INQ_RSP, 0x80, 0x02, 0x00, 0x00, 0x00, 0x05, 0x01, 0x01, 0xee];
    const first = device((cmd) =>
      cmd[0] === OPCODES.INQUIRY_COMMAND ? [ACK, ...unknownChannel] : [ACK],
    );
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first);
    client.onStatus = (m) => {
      if (m.startsWith('⚠️')) first.emitDisconnect(new Error('dropped'));
    };
    await expect(client.inquiry()).rejects.toThrow(/link was reset/);
    expect(client.samplingRateHz).toBe(0); // the inquiry says 51.2 Hz
  });
});

describe('a link that dropped, before the next connect', () => {
  it('refuses a command rather than write it to the dropped transport', async () => {
    const first = device();
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first);
    first.emitDisconnect(new Error('dropped'));
    const before = first.writes.length;
    await expect(client.setSamplingRate(51.2)).rejects.toThrow(/Not connected/);
    expect(first.writes.length).toBe(before);
    expect(client.samplingRateHz).toBe(0);
  });
});

describe('the transport of a link that dropped', () => {
  it('has its late traffic and disconnect ignored on the next link', async () => {
    const first = device();
    const client = new Shimmer3Client({ debug: false });
    let drops = 0;
    client.onDisconnect = () => drops++;
    await client.connect(first);
    first.emitDisconnect(new Error('dropped'));

    const answer = shimmer3(undefined, 16);
    const second = new LoopbackTransport({ capabilities: { framed: false } });
    second.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND) {
        // A reply the old link's transport delivers late, from other firmware
        setTimeout(() => first.notify(fw(9)), 5);
        setTimeout(() => tr.notify(fw(16)), 30);
      } else {
        answer(bytes, tr);
      }
    });
    await client.connect(second);
    expect(client.firmwareVersion?.minor).toBe(16);

    first.emitDisconnect(new Error('late'));
    expect(drops).toBe(1);
  });
});

describe('a reply settled in the same turn as the drop', () => {
  it("does not hand the old device's inquiry to its caller after the reconnect", async () => {
    /* A waiter that settled - and so left the reset's reach - inside the very
       notification whose transport then reported the link down delivered its
       result after the next link had begun. A notification and a disconnect
       in one turn, with the application reconnecting from onDisconnect, is
       the case. */
    const answer = shimmer3();
    const first = new LoopbackTransport({ capabilities: { framed: false } });
    first.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.INQUIRY_COMMAND) {
        setTimeout(() => {
          tr.notify([ACK, ...INQUIRY_MSG]); // settles the inquiry's waiter...
          tr.emitDisconnect(new Error('dropped')); // ...and the link drops in the same turn
        }, 0);
      } else {
        answer(bytes, tr);
      }
    });
    const client = new Shimmer3Client({ debug: false });
    await client.connect(first);
    let reconnected: Promise<void> = Promise.resolve();
    client.onDisconnect = () => {
      reconnected = client.connect(device(undefined, 16));
    };
    const stale = client.inquiry().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(await stale).toMatch(/link was reset/);
    await reconnected;
    expect(client.samplingRateHz).toBe(0); // the old device's configuration was not taken up
  });
});
