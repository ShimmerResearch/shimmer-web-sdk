import { describe, it, expect } from 'vitest';
import { VerisenseBleDevice } from '../../src/devices/verisense/VerisenseClient.js';
import { ASM_COMMAND, ASM_PROPERTY, STREAM_MODE } from '../../src/devices/verisense/constants.js';
import { buildHeader, buildMessage } from '../../src/devices/verisense/protocol.js';

// These tests exercise the client's streaming control path without a real Web
// Bluetooth stack: a fake NUS TX characteristic records the bytes the client
// writes (and whether it used write-with-response), and command ACKs are
// injected via the same private byte-feed the BLE notification handler calls.
//
// The regression under test: at a high data rate the STREAM_MODE-disable ACK can
// be lost (BLE notifications are unacknowledged) or buried in the in-flight
// stream tail, so stopStreaming() must NOT depend on it — it must reconcile state
// (idle + streaming:false) regardless, or the UI stays wedged in "streaming".

interface RecordedWrite {
  withResponse: boolean;
  bytes: Uint8Array;
}

function bufToU8(b: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (b instanceof Uint8Array) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return new Uint8Array(b);
}

/** Attach a fake NUS TX characteristic; returns the list of recorded writes. */
function attachFakeTx(v: VerisenseBleDevice): RecordedWrite[] {
  const writes: RecordedWrite[] = [];
  (v as unknown as { tx: unknown }).tx = {
    // Write-with-response (acknowledged at the ATT layer).
    writeValue: async (b: ArrayBuffer | ArrayBufferView) => {
      writes.push({ withResponse: true, bytes: bufToU8(b) });
    },
    // Write-without-response (used by normal commands).
    writeValueWithoutResponse: async (b: ArrayBuffer | ArrayBufferView) => {
      writes.push({ withResponse: false, bytes: bufToU8(b) });
    },
  };
  return writes;
}

/** Inject a STREAM_MODE ACK the way the BLE notification handler would. */
function feedStreamModeAck(v: VerisenseBleDevice): void {
  const ack = new Uint8Array([buildHeader(ASM_COMMAND.ACK, ASM_PROPERTY.STREAM_MODE), 0x00, 0x00]);
  (v as unknown as { _feedStreamBytes(c: Uint8Array): void })._feedStreamBytes(ack);
}

const getMode = (v: VerisenseBleDevice): string => (v as unknown as { _mode: string })._mode;
const setMode = (v: VerisenseBleDevice, m: string): void => {
  (v as unknown as { _mode: string })._mode = m;
};

// WRITE | STREAM_MODE header = 0x2A; payload [DISABLE] => wire bytes 2A 01 00 02.
const DISABLE_CMD = buildMessage(ASM_COMMAND.WRITE, ASM_PROPERTY.STREAM_MODE, [
  STREAM_MODE.DISABLE,
]);

describe('VerisenseBleDevice.stopStreaming (best-effort)', () => {
  it('resolves and returns to idle even when the disable ACK never arrives', async () => {
    const v = new VerisenseBleDevice({ debug: false });
    const writes = attachFakeTx(v);
    const events: boolean[] = [];
    v.on<{ on: boolean }>('streaming', (e) => events.push(e.on));

    // Streaming at a high data rate; the device's ACK will be lost.
    setMode(v, 'streaming');

    await expect(v.stopStreaming()).resolves.toBeUndefined();

    expect(getMode(v)).toBe('idle');
    expect(events).toEqual([false]);

    // The disable went out exactly once, as a write-WITH-response (reliable
    // delivery) rather than the lossy write-without-response.
    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0].bytes)).toEqual([0x2a, 0x01, 0x00, 0x02]);
    expect(Array.from(writes[0].bytes)).toEqual(Array.from(DISABLE_CMD));
    expect(writes[0].withResponse).toBe(true);
  });

  it('reconciles state even if the disable write itself rejects (e.g. link dropped)', async () => {
    const v = new VerisenseBleDevice({ debug: false });
    const events: boolean[] = [];
    v.on<{ on: boolean }>('streaming', (e) => events.push(e.on));

    (v as unknown as { tx: unknown }).tx = {
      writeValue: async () => {
        throw new Error('GATT Server is disconnected');
      },
    };
    setMode(v, 'streaming');

    await expect(v.stopStreaming()).resolves.toBeUndefined();
    expect(getMode(v)).toBe('idle');
    expect(events).toEqual([false]);
  });

  it('start (ACKed) then stop (ACK lost) ends idle — full round trip', async () => {
    const v = new VerisenseBleDevice({ debug: false });
    const writes = attachFakeTx(v);
    const events: boolean[] = [];
    v.on<{ on: boolean }>('streaming', (e) => events.push(e.on));

    // startStreaming awaits the ENABLE ACK; feed it so the start resolves.
    // _pending is armed synchronously before the write awaits, so the immediate
    // feed lands on the pending request.
    const startP = v.startStreaming();
    feedStreamModeAck(v);
    await startP;

    expect(events).toEqual([true]);
    expect(getMode(v)).toBe('streaming');

    // Now stop at a high data rate: never feed the DISABLE ACK.
    await v.stopStreaming();

    expect(events).toEqual([true, false]);
    expect(getMode(v)).toBe('idle');

    // start used the normal (without-response) path; stop upgraded to with-response.
    const enableWrite = writes.find(
      (w) => w.bytes.length >= 4 && w.bytes[0] === 0x2a && w.bytes[3] === STREAM_MODE.ENABLE,
    );
    const disableWrite = writes.find(
      (w) => w.bytes.length >= 4 && w.bytes[0] === 0x2a && w.bytes[3] === STREAM_MODE.DISABLE,
    );
    expect(enableWrite?.withResponse).toBe(false);
    expect(disableWrite?.withResponse).toBe(true);
  });
});
