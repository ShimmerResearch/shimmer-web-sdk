import { describe, it, expect } from 'vitest';
import {
  scanStreamFrame,
  crc16_ccitt_false,
  STREAM_FRAME_HEADER,
  STREAM_FRAME_MAX_PAYLOAD,
} from '../../src/devices/verisense/protocol.js';

/** Build a wire-format streaming frame from a payload (sensorId + tick + samples). */
function buildStreamFrame(payloadNoCrc: Uint8Array): Uint8Array {
  const crc = crc16_ccitt_false(payloadNoCrc);
  const len = payloadNoCrc.length + 2; // length field includes the 2-byte CRC trailer
  const out = new Uint8Array(3 + len);
  out[0] = STREAM_FRAME_HEADER;
  out[1] = len & 0xff;
  out[2] = (len >> 8) & 0xff;
  out.set(payloadNoCrc, 3);
  out[3 + payloadNoCrc.length] = crc & 0xff;
  out[3 + payloadNoCrc.length + 1] = (crc >> 8) & 0xff;
  return out;
}

/** Drive scanStreamFrame the way VerisenseClient's parse loop does. */
function drainFrames(buf: Uint8Array): {
  frames: Uint8Array[];
  dropped: number;
  remaining: Uint8Array;
} {
  let work = buf;
  const frames: Uint8Array[] = [];
  let dropped = 0;
  for (;;) {
    const scan = scanStreamFrame(work);
    if (scan.status === 'need-more') break;
    if (scan.status === 'invalid') {
      work = work.slice(1);
      dropped++;
      continue;
    }
    frames.push(scan.payload);
    work = work.slice(scan.consumed);
  }
  return { frames, dropped, remaining: work };
}

// A representative LSM6DSV (id 6) payload: sensorId + 3-byte tick + a few samples.
const SAMPLE_PAYLOAD = new Uint8Array([0x06, 0x10, 0x20, 0x30, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);

describe('STREAM_FRAME_HEADER', () => {
  it('is RESPONSE | STREAM_MODE === 0x3A', () => {
    expect(STREAM_FRAME_HEADER).toBe(0x3a);
  });
});

describe('scanStreamFrame', () => {
  it('accepts a well-formed frame and reports bytes consumed', () => {
    const frame = buildStreamFrame(SAMPLE_PAYLOAD);
    const scan = scanStreamFrame(frame);
    expect(scan.status).toBe('frame');
    if (scan.status !== 'frame') return;
    expect(scan.consumed).toBe(frame.length);
    // payload includes the CRC trailer; first byte is the sensor id.
    expect(scan.payload[0]).toBe(0x06);
    expect(scan.payload.length).toBe(SAMPLE_PAYLOAD.length + 2);
  });

  it('returns need-more for an empty or partial buffer', () => {
    expect(scanStreamFrame(new Uint8Array(0)).status).toBe('need-more');
    expect(scanStreamFrame(new Uint8Array([STREAM_FRAME_HEADER, 0x06])).status).toBe('need-more');

    const frame = buildStreamFrame(SAMPLE_PAYLOAD);
    expect(scanStreamFrame(frame.subarray(0, frame.length - 1)).status).toBe('need-more');
  });

  it('rejects a wrong header byte', () => {
    const frame = buildStreamFrame(SAMPLE_PAYLOAD);
    const bad = frame.slice();
    bad[0] = 0x40; // ACK command nibble, not a stream frame
    expect(scanStreamFrame(bad).status).toBe('invalid');
  });

  it('rejects out-of-bounds lengths without waiting for bytes', () => {
    // len = 2 (< minimum payload of 6)
    expect(scanStreamFrame(new Uint8Array([STREAM_FRAME_HEADER, 0x02, 0x00])).status).toBe(
      'invalid',
    );
    // len just over the ceiling — must reject immediately, not block on need-more
    const over = STREAM_FRAME_MAX_PAYLOAD + 1;
    expect(
      scanStreamFrame(new Uint8Array([STREAM_FRAME_HEADER, over & 0xff, (over >> 8) & 0xff]))
        .status,
    ).toBe('invalid');
  });

  it('accepts a large frame reassembled from several BLE notifications', () => {
    // Regression guard: the firmware packages multi-sample IMU records into one
    // logical frame (~1.8 kB for an LSM6DSV accel/gyro/mag burst) fragmented
    // across BLE notifications; the host reassembles them before scanning. A
    // ceiling near the BLE MTU (the old 512) silently dropped every such frame.
    const payload = new Uint8Array(1791);
    payload[0] = 0x06; // LSM6DSV (accel/gyro/mag) sensor id
    for (let i = 1; i < payload.length; i++) payload[i] = (i * 7) & 0xff;
    const frame = buildStreamFrame(payload);
    expect(frame.length).toBe(3 + 1793);
    const scan = scanStreamFrame(frame);
    expect(scan.status).toBe('frame');
    if (scan.status !== 'frame') return;
    expect(scan.consumed).toBe(frame.length);
    expect(scan.payload[0]).toBe(0x06);
  });

  it('rejects a frame whose CRC does not match (corruption)', () => {
    const frame = buildStreamFrame(SAMPLE_PAYLOAD);
    const corrupt = frame.slice();
    corrupt[4] ^= 0xff; // flip a payload byte, CRC trailer untouched
    expect(scanStreamFrame(corrupt).status).toBe('invalid');
  });

  it('parses payload bytes that happen to equal the header byte', () => {
    // Inner 0x3A must not be mistaken for a boundary — framing is length+CRC driven.
    const payload = new Uint8Array([0x06, 0x3a, 0x3a, 0x3a, 0x3a, 0x3a]);
    const scan = scanStreamFrame(buildStreamFrame(payload));
    expect(scan.status).toBe('frame');
  });
});

describe('resynchronisation (parse-loop behaviour)', () => {
  it('parses back-to-back frames with nothing dropped', () => {
    const a = buildStreamFrame(new Uint8Array([0x06, 0x01, 0x02, 0x03, 0xaa, 0xbb]));
    const b = buildStreamFrame(new Uint8Array([0x01, 0x04, 0x05, 0x06, 0xcc]));
    const merged = new Uint8Array([...a, ...b]);

    const { frames, dropped, remaining } = drainFrames(merged);
    expect(dropped).toBe(0);
    expect(frames).toHaveLength(2);
    expect(frames[0][0]).toBe(0x06);
    expect(frames[1][0]).toBe(0x01);
    expect(remaining.length).toBe(0);
  });

  it('re-locks on the next valid frame after leading garbage (incl. a stray 0x3A)', () => {
    // Garbage that mimics a dropped-packet tail: ordinary bytes plus a false
    // 0x3A header whose length is out of range (0xFFFF > STREAM_FRAME_MAX_PAYLOAD)
    // and so is rejected immediately, rather than blocking to buffer a bogus body.
    const garbage = new Uint8Array([0xaa, 0xbb, STREAM_FRAME_HEADER, 0xff, 0xff]);
    const good = buildStreamFrame(SAMPLE_PAYLOAD);
    const { frames, dropped } = drainFrames(new Uint8Array([...garbage, ...good]));

    expect(frames).toHaveLength(1);
    expect(frames[0][0]).toBe(0x06);
    expect(dropped).toBe(garbage.length);
  });

  it('discards a corrupt frame and recovers on the following good frame', () => {
    // Payload chosen so neither its bytes, length, nor CRC trailer contain a
    // stray 0x3A: otherwise a flipped byte can leave an in-range false header
    // that legitimately blocks on need-more (it resolves in a live stream once
    // the claimed body arrives, but not within this fixed-size test buffer).
    const good = buildStreamFrame(
      new Uint8Array([0x06, 0x11, 0x21, 0x31, 0x00, 0x13, 0x14, 0x15, 0x16, 0x17]),
    );
    const corrupt = good.slice();
    corrupt[5] ^= 0xff; // break the first frame's CRC
    const next = buildStreamFrame(new Uint8Array([0x07, 0x11, 0x22, 0x33, 0x44]));

    const { frames } = drainFrames(new Uint8Array([...corrupt, ...next]));
    // The corrupt frame is dropped; the good one after it is recovered.
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[frames.length - 1][0]).toBe(0x07);
  });

  it('keeps a trailing partial frame buffered until the rest arrives', () => {
    const whole = buildStreamFrame(SAMPLE_PAYLOAD);
    const head = whole.subarray(0, whole.length - 3);

    const first = drainFrames(head);
    expect(first.frames).toHaveLength(0);
    expect(first.remaining.length).toBe(head.length); // nothing consumed, awaiting more

    // The rest arrives; concatenation now yields the full frame.
    const completed = drainFrames(
      new Uint8Array([...first.remaining, ...whole.subarray(head.length)]),
    );
    expect(completed.frames).toHaveLength(1);
    expect(completed.frames[0][0]).toBe(0x06);
  });
});
