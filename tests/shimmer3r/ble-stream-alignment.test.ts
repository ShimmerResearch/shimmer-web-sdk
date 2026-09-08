import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

// Reproduction harness for the reported BLE streaming failure: correct inquiry
// (6 channels, 16 bytes per frame, sensors 0x0000C0) but garbage on the graphs.
// A framed LoopbackTransport IS a BLE notification stream, so this replays the
// bench configuration offline.

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const INQ_RSP = OPCODES.INQUIRY_RESPONSE;

// Channels 0x00-0x02 = LN_ACCEL X/Y/Z, 0x0a-0x0c = GYRO X/Y/Z -> 0xC0.
// adcRaw 0x0280 = 640 -> 51.2 Hz, exactly the bench log.
const CHANNELS = [0x00, 0x01, 0x02, 0x0a, 0x0b, 0x0c];
const INQUIRY_BODY = [
  INQ_RSP,
  0x80,
  0x02, // sampling rate ticks = 640
  0,
  0,
  0,
  0,
  0,
  0,
  0, // config setup bytes 0..6
  CHANNELS.length,
  1, // numChannels, bufferSize
  ...CHANNELS,
];

const FRAME_BYTES = 16; // 1 preamble + 3 timestamp + 6 x i16
const TICKS_PER_FRAME = 640;

/** At-rest inertial data: Z near 1g, everything else near zero. */
const SAMPLE = { ax: 100, ay: -50, az: 16000, gx: 1, gy: -2, gz: 0 };

function buildFrame(ts: number, s = SAMPLE): number[] {
  const i16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
  return [
    0x00, // DATA_PACKET preamble
    ts & 0xff,
    (ts >> 8) & 0xff,
    (ts >> 16) & 0xff,
    ...i16(s.ax),
    ...i16(s.ay),
    ...i16(s.az),
    ...i16(s.gx),
    ...i16(s.gy),
    ...i16(s.gz),
  ];
}

/** Split a byte array into chunks of the given sizes, cycling through them. */
function chunkBy(bytes: number[], sizes: number[]): number[][] {
  const out: number[][] = [];
  let i = 0;
  let k = 0;
  while (i < bytes.length) {
    const n = sizes[k++ % sizes.length];
    out.push(bytes.slice(i, i + n));
    i += n;
  }
  return out;
}

async function connectStreaming(): Promise<{
  client: Shimmer3RClient;
  t: LoopbackTransport;
  frames: Array<Record<string, number>>;
}> {
  const t = new LoopbackTransport();
  t.setOnWrite((bytes, tr) => {
    if (bytes[0] === OPCODES.INQUIRY_COMMAND) {
      setTimeout(() => tr.notify([ACK, ...INQUIRY_BODY]), 0);
    } else if (bytes[0] === OPCODES.START_STREAMING_COMMAND) {
      setTimeout(() => tr.notify([ACK]), 0);
    }
  });
  const client = new Shimmer3RClient({ debug: false });
  await client.connect(t);

  const info = await client.inquiry();
  expect(info.numChannels).toBe(6);
  expect(info.schema.frameBytes).toBe(FRAME_BYTES);
  expect(info.schema.enabledSensors).toBe(0xc0);

  const frames: Array<Record<string, number>> = [];
  client.onStreamFrame = (oc) => {
    const row: Record<string, number> = {};
    // RAW fields only: calibration adds a second field under the same name,
    // and reading that instead would compare against m/s^2 rather than counts.
    for (const f of oc.fields) {
      if (f.kind === 'raw') row[f.name] = f.value;
    }
    frames.push(row);
  };

  await client.startStreaming();
  return { client, t, frames };
}

describe('Shimmer3R BLE streaming (accel + gyro at rest)', () => {
  it('decodes every frame when each notification carries exactly one frame', async () => {
    const { t, frames } = await connectStreaming();

    const n = 40;
    for (let i = 0; i < n; i++) t.notify(buildFrame(1000 + i * TICKS_PER_FRAME));

    // The parser validates on a double preamble, so it holds the final frame
    // back until more data arrives: n-1 emitted.
    expect(frames.length).toBe(n - 1);
    for (const [i, row] of frames.entries()) {
      expect(row.TIMESTAMP).toBe(1000 + i * TICKS_PER_FRAME);
      expect(row.LN_ACCEL_X).toBe(SAMPLE.ax);
      expect(row.LN_ACCEL_Y).toBe(SAMPLE.ay);
      expect(row.LN_ACCEL_Z).toBe(SAMPLE.az);
      expect(row.GYRO_X).toBe(SAMPLE.gx);
      expect(row.GYRO_Y).toBe(SAMPLE.gy);
      expect(row.GYRO_Z).toBe(SAMPLE.gz);
    }
  });

  it('decodes every frame when notifications split frames at arbitrary offsets', async () => {
    const { t, frames } = await connectStreaming();

    const n = 40;
    const bytes: number[] = [];
    for (let i = 0; i < n; i++) bytes.push(...buildFrame(1000 + i * TICKS_PER_FRAME));
    // Sizes that never line up with the 16-byte frame, as Immediate-mode
    // packetization does not respect frame boundaries.
    for (const c of chunkBy(bytes, [7, 23, 5, 31, 11])) t.notify(c);

    expect(frames.length).toBeGreaterThanOrEqual(n - 2);
    for (const [i, row] of frames.entries()) {
      expect(row.TIMESTAMP).toBe(1000 + i * TICKS_PER_FRAME);
      expect(row.LN_ACCEL_Z).toBe(SAMPLE.az);
      expect(row.GYRO_Z).toBe(SAMPLE.gz);
    }
  });

  it('keeps continuity when frames arrive before the START_STREAM ACK (regression)', async () => {
    // The field trigger. Firmware streams as soon as it processes the command,
    // so frames can arrive before the ACK — and the module's packetization does
    // not respect frame boundaries. The control branch used to append a
    // notification to the stream buffer only when it *started* with a preamble,
    // so the tail of a frame split across two notifications was dropped while
    // its head was kept, and every byte after it was a frame boundary out.
    const n = 40;
    const bytes: number[] = [];
    for (let i = 0; i < n; i++) bytes.push(...buildFrame(1000 + i * TICKS_PER_FRAME));

    const t = new LoopbackTransport();
    t.setOnWrite((b, tr) => {
      if (b[0] === OPCODES.INQUIRY_COMMAND) {
        setTimeout(() => tr.notify([ACK, ...INQUIRY_BODY]), 0);
      } else if (b[0] === OPCODES.START_STREAMING_COMMAND) {
        // Head of the first frame, then a tail starting mid-frame, then the
        // rest frame-aligned — and only after all that, the ACK.
        setTimeout(() => tr.notify(bytes.slice(0, 10)), 0);
        setTimeout(() => tr.notify(bytes.slice(10, 26)), 0);
        for (const c of chunkBy(bytes.slice(26), [FRAME_BYTES])) {
          setTimeout(() => tr.notify(c), 0);
        }
        setTimeout(() => tr.notify([ACK]), 0);
      }
    });

    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    const info = await client.inquiry();
    expect(info.schema.frameBytes).toBe(FRAME_BYTES);

    const frames: Array<Record<string, number>> = [];
    client.onStreamFrame = (oc) => {
      const row: Record<string, number> = {};
      for (const f of oc.fields) {
        if (f.kind === 'raw') row[f.name] = f.value;
      }
      frames.push(row);
    };
    await client.startStreaming();
    await new Promise((r) => setTimeout(r, 10));

    expect(frames.length).toBeGreaterThan(0);
    for (const row of frames) {
      expect(row.LN_ACCEL_Z).toBe(SAMPLE.az);
      expect(row.GYRO_Z).toBe(SAMPLE.gz);
      expect(row.LN_ACCEL_Y).toBe(SAMPLE.ay);
    }
  });

  it('recovers alignment when the stream starts mid-frame', async () => {
    const { t, frames } = await connectStreaming();

    const n = 40;
    const bytes: number[] = [];
    for (let i = 0; i < n; i++) bytes.push(...buildFrame(1000 + i * TICKS_PER_FRAME));
    // Drop the first 5 bytes, as if the start of the stream was lost.
    for (const c of chunkBy(bytes.slice(5), [FRAME_BYTES])) t.notify(c);

    // Whatever it locks onto, every frame it reports must be a real one.
    expect(frames.length).toBeGreaterThan(0);
    for (const row of frames) {
      expect(row.LN_ACCEL_Z).toBe(SAMPLE.az);
      expect(row.GYRO_Z).toBe(SAMPLE.gz);
    }
  });
});

describe('stopping the stream gives up the alignment claim', () => {
  /* `_parseBySchema` is gated on `schema`, not on `_streaming`, and a chunk
     beginning with DATA_PACKET is appended to the stream buffer even when not
     streaming. So frames already in flight when STOP_STREAM was sent are still
     parsed. If the stop left the alignment claim set, those residual bytes skip
     acquisition and are accepted at whatever offset they land on. Both stop
     paths therefore go through _endStreamPlane rather than clearing the
     streaming flag and the buffer by hand.

     Engineering a wrong lock takes some care. With at-rest CONSTANT data any
     wrong offset reads the same bytes each frame, so its step is 0 and the
     existing zero-step guard catches it regardless - which is why an obvious
     version of this test passes with the bug present. The residual frames below
     therefore vary a channel that lands inside the fake timestamp window:

       frame = [00 | ts0 ts1 ts2 | axL axH | ayL ayH | azL azH | gx gy gz...]
       index     0    1   2   3     4   5     6   7     8   9

     A lock at index 5 sees axH = 0x00 as a preamble (ax stays 100, so its high
     byte is always zero) and finds the next one exactly one frame later. Its
     "timestamp" is [ayL, ayH, azL], so stepping az by 1 per frame moves that
     fake step by 65536 - far from the 640-tick interval, and non-zero, so only
     the acquisition check can reject it. */

  const FAKE_LOCK_OFFSET = 5;

  /** Residual frames whose az varies, so a wrong lock has a non-zero step. */
  function residualBytes(startTs: number, n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(...buildFrame(startTs + i * TICKS_PER_FRAME, { ...SAMPLE, az: SAMPLE.az + i }));
    }
    return out;
  }

  it('re-acquires alignment for frames arriving after a stop', async () => {
    const { client, t, frames } = await connectStreaming();

    for (let i = 0; i < 20; i++) t.notify(buildFrame(1000 + i * TICKS_PER_FRAME));
    const delivered = frames.length;
    expect(delivered).toBeGreaterThan(0);

    await client.stopStreaming();

    // Start mid-frame, at the offset the wrong lock lives on.
    t.notify(residualBytes(90_000, 10).slice(FAKE_LOCK_OFFSET));

    /* Every frame delivered after the stop must decode to the real channels. A
       lock at index 5 reports az's low byte as the gyro and shifts everything,
       so this fails outright when the claim survives the stop. */
    for (const row of frames.slice(delivered)) {
      expect(row.TIMESTAMP).toBeGreaterThanOrEqual(90_000);
      expect(row.TIMESTAMP).toBeLessThan(90_000 + 10 * TICKS_PER_FRAME);
      expect(row.LN_ACCEL_X).toBe(SAMPLE.ax);
      expect(row.GYRO_Z).toBe(SAMPLE.gz);
      expect(row.GYRO_Y).toBe(SAMPLE.gy);
    }
  });

  it('clears the same state on the combined stream+logging stop', async () => {
    const { client, t, frames } = await connectStreaming();
    for (let i = 0; i < 20; i++) t.notify(buildFrame(1000 + i * TICKS_PER_FRAME));
    const delivered = frames.length;

    await client.stopStreamingAndLogging();
    t.notify(residualBytes(90_000, 10).slice(FAKE_LOCK_OFFSET));

    for (const row of frames.slice(delivered)) {
      expect(row.TIMESTAMP).toBeGreaterThanOrEqual(90_000);
      expect(row.LN_ACCEL_X).toBe(SAMPLE.ax);
      expect(row.GYRO_Z).toBe(SAMPLE.gz);
    }
  });
});

describe('a stream byte of 0xFF must not be taken for the START_STREAM ACK', () => {
  /* Review finding. `startStreaming` opens the stream plane BEFORE writing the
     command — it has to, because the firmware streams as soon as it processes
     one — so for up to the 1500 ms ACK timeout there are stream bytes arriving
     while an ACK is expected. The ACK branch fired on "first byte is 0xFF"
     alone, and 0xFF is common in at-rest inertial data: SAMPLE.ay of -50 is
     `0xce 0xff` and gy of -2 is `0xfe 0xff`. A notification beginning on one of
     those spent the ACK the start command was waiting on and diverted that
     notification's samples to the control handlers. */

  const ACK_BYTE = OPCODES.ACK_COMMAND_PROCESSED;

  it('keeps the pre-ACK frames instead of diverting them to the control path', async () => {
    /* The observable consequence, and it took a second attempt to pin. Spending
       the ACK on a stream byte costs more than the byte: the WHOLE remainder of
       that notification is handed to the control handlers, because its first
       byte is not DATA_PACKET. Any complete frames it carried are simply gone.
       Asserting that `startStreaming` resolves does not separate the two cases
       — it resolves either way, just earlier and for the wrong reason. */
    const PRE_TS = 50_000;
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.INQUIRY_COMMAND) {
        setTimeout(() => tr.notify([ACK, ...INQUIRY_BODY]), 0);
      } else if (bytes[0] === OPCODES.START_STREAMING_COMMAND) {
        /* One notification, beginning on the 0xFF that follows ay — exactly
           what an arbitrary notification boundary produces — carrying the tail
           of one frame and then five whole ones. Only afterwards, the real ACK. */
        const first = buildFrame(PRE_TS);
        const ffIndex = first.indexOf(0xff);
        expect(ffIndex).toBeGreaterThan(0);
        const burst = [...first.slice(ffIndex)];
        for (let i = 1; i <= 5; i++) burst.push(...buildFrame(PRE_TS + i * TICKS_PER_FRAME));
        setTimeout(() => tr.notify(burst), 0);
        setTimeout(() => tr.notify([ACK_BYTE]), 5);
      }
    });

    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await client.inquiry();
    const frames: number[] = [];
    client.onStreamFrame = (oc) => {
      const f = oc.fields.find((x) => x.name === 'TIMESTAMP' && x.kind === 'raw');
      if (f) frames.push(f.value);
    };

    await client.startStreaming();
    await new Promise((r) => setTimeout(r, 20));

    /* Frames from the pre-ACK burst must have been delivered. Without the gate
       the burst goes to the control handlers wholesale and none of them are. */
    const fromBurst = frames.filter((ts) => ts >= PRE_TS && ts <= PRE_TS + 5 * TICKS_PER_FRAME);
    expect(fromBurst.length).toBeGreaterThanOrEqual(3);
    for (const ts of fromBurst) {
      expect((ts - PRE_TS) % TICKS_PER_FRAME).toBe(0);
    }
  });

  it('still consumes a lone ACK, and an ACK glued to frames, while streaming', async () => {
    // The two shapes that ARE credible must keep working, or the gate has just
    // broken the handshake it was meant to protect.
    for (const glued of [false, true]) {
      const t = new LoopbackTransport();
      t.setOnWrite((bytes, tr) => {
        if (bytes[0] === OPCODES.INQUIRY_COMMAND) {
          setTimeout(() => tr.notify([ACK, ...INQUIRY_BODY]), 0);
        } else if (bytes[0] === OPCODES.START_STREAMING_COMMAND) {
          setTimeout(() => tr.notify(glued ? [ACK_BYTE, ...buildFrame(1000)] : [ACK_BYTE]), 0);
        }
      });
      const client = new Shimmer3RClient({ debug: false });
      await client.connect(t);
      await client.inquiry();
      await expect(client.startStreaming(), `glued=${glued}`).resolves.toBeUndefined();
    }
  });

  it('leaves the control plane rule untouched', async () => {
    // Nothing else is in flight there, so an expected ACK is an expected ACK —
    // including one glued to a response, which every command relies on.
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.INQUIRY_COMMAND) {
        setTimeout(() => tr.notify([ACK, ...INQUIRY_BODY]), 0);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    const info = await client.inquiry();
    expect(info.numChannels).toBe(6);
  });
});
