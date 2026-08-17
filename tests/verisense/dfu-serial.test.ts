import { describe, it, expect } from 'vitest';
import {
  SLIP_END,
  SLIP_ESC,
  SLIP_ESC_END,
  SLIP_ESC_ESC,
  slipEncode,
  SlipDecoder,
  crc32,
  SERIAL_DFU_OP,
  SERIAL_DFU_OBJECT_TYPE,
  VERISENSE_USB_DFU_PORT_FILTERS,
  isUsbDfuUnsupportedError,
  VerisenseSerialDfu,
  type SerialDfuTransportLike,
} from '../../src/devices/verisense/dfuSerial.js';

describe('SLIP codec', () => {
  it('encodes END and ESC bytes and terminates with END', () => {
    const encoded = slipEncode([0x01, SLIP_END, SLIP_ESC, 0x02]);
    expect(Array.from(encoded)).toEqual([
      0x01,
      SLIP_ESC,
      SLIP_ESC_END,
      SLIP_ESC,
      SLIP_ESC_ESC,
      0x02,
      SLIP_END,
    ]);
  });

  it('round-trips arbitrary bytes through encode/decode', () => {
    const frame = Uint8Array.from({ length: 512 }, (_, i) => i % 256);
    const decoder = new SlipDecoder();
    const frames = decoder.push(slipEncode(frame));
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0])).toEqual(Array.from(frame));
  });

  it('reassembles frames split across chunks and drops empty frames', () => {
    const decoder = new SlipDecoder();
    const encoded = slipEncode([0xaa, SLIP_END, 0xbb]);
    const out: Uint8Array[] = [];
    // one byte at a time, with stray leading ENDs
    out.push(...decoder.push(Uint8Array.from([SLIP_END, SLIP_END])));
    for (const byte of encoded) out.push(...decoder.push(Uint8Array.from([byte])));
    expect(out).toHaveLength(1);
    expect(Array.from(out[0])).toEqual([0xaa, SLIP_END, 0xbb]);
  });
});

describe('crc32', () => {
  it('matches the IEEE test vector', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes)).toBe(0xcbf43926);
  });

  it('is continuable via seed', () => {
    const bytes = new TextEncoder().encode('123456789');
    const first = crc32(bytes.subarray(0, 4));
    expect(crc32(bytes.subarray(4), first)).toBe(0xcbf43926);
  });

  it('returns 0 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('constants', () => {
  it('filters target the bootloader DFU port, not the application port', () => {
    expect(VERISENSE_USB_DFU_PORT_FILTERS).toEqual([{ usbVendorId: 0x1915, usbProductId: 0x521f }]);
  });

  it('classifies NACK rejections as USB-DFU-unsupported', () => {
    expect(isUsbDfuUnsupportedError(new Error('NACK command=0x70 property=0x6'))).toBe(true);
    expect(isUsbDfuUnsupportedError(new Error('Request timeout'))).toBe(false);
  });
});

/**
 * A scripted mock of the bootloader's serial DFU endpoint: SLIP-decodes
 * requests, keeps object state, and replies like nrf_dfu_req_handler with
 * PRN 0. Configurable initial select state to exercise resume paths.
 */
class MockSerialBootloader implements SerialDfuTransportLike {
  mtu = 2051; // matches nrf_dfu_serial_usb's SLIP_MTU for RX_BUF_SIZE 1024
  maxObjectSize = 4096;
  initMaxSize = 512;
  received: { init: number[]; firmware: number[] } = { init: [], firmware: [] };
  executes: string[] = [];
  createdSizes: number[] = [];
  writesSeen: number[] = []; // per OBJECT_WRITE frame payload length
  /** Pre-seeded firmware bytes to simulate an interrupted earlier transfer. */
  preloadedFirmware: number[] = [];
  /** When set, corrupt the first N firmware objects' CRC responses. */
  corruptFirstObjects = 0;

  private _notify: ((data: Uint8Array) => void) | null = null;
  private _decoder = new SlipDecoder();
  private _selected: 'init' | 'firmware' | null = null;
  private _objectStart = 0;
  private _corrupted = 0;
  /** Length of firmware committed by Execute; CREATE rolls back to here
   * (mirrors the bootloader: only the current, unexecuted object is
   * replaceable). */
  private _executedLength = 0;

  onNotify(cb: (data: Uint8Array) => void): () => void {
    this._notify = cb;
    return () => {
      this._notify = null;
    };
  }

  async write(data: Uint8Array): Promise<void> {
    for (const frame of this._decoder.push(data)) this._handle(frame);
  }

  private _respond(opcode: number, result: number, payload: number[] = []): void {
    const frame = Uint8Array.from([SERIAL_DFU_OP.RESPONSE, opcode, result, ...payload]);
    // Split the SLIP stream into two chunks to exercise reassembly.
    const encoded = slipEncode(frame);
    const mid = Math.max(1, Math.floor(encoded.length / 2));
    this._notify?.(encoded.subarray(0, mid));
    this._notify?.(encoded.subarray(mid));
  }

  private _u32(v: number): number[] {
    return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  }

  private _firmwareBytes(): Uint8Array {
    return Uint8Array.from(
      this.preloadedFirmware.length ? this.preloadedFirmware : this.received.firmware,
    );
  }

  private _handle(frame: Uint8Array): void {
    const op = frame[0];
    switch (op) {
      case SERIAL_DFU_OP.PING:
        this._respond(op, 0x01, [frame[1]]);
        break;
      case SERIAL_DFU_OP.RECEIPT_NOTIF_SET:
        this._respond(op, 0x01);
        break;
      case SERIAL_DFU_OP.MTU_GET:
        this._respond(op, 0x01, [this.mtu & 0xff, (this.mtu >>> 8) & 0xff]);
        break;
      case SERIAL_DFU_OP.OBJECT_SELECT: {
        const isInit = frame[1] === SERIAL_DFU_OBJECT_TYPE.COMMAND;
        this._selected = isInit ? 'init' : 'firmware';
        if (isInit) {
          const bytes = Uint8Array.from(this.received.init);
          this._respond(op, 0x01, [
            ...this._u32(this.initMaxSize),
            ...this._u32(bytes.length),
            ...this._u32(crc32(bytes)),
          ]);
        } else {
          if (this.preloadedFirmware.length) {
            this.received.firmware = [...this.preloadedFirmware];
            // Whole preloaded objects were executed by the earlier attempt;
            // a trailing partial object is written but not executed.
            this._executedLength =
              Math.floor(this.preloadedFirmware.length / this.maxObjectSize) * this.maxObjectSize;
            this.preloadedFirmware = [];
          }
          const bytes = this._firmwareBytes();
          this._respond(op, 0x01, [
            ...this._u32(this.maxObjectSize),
            ...this._u32(bytes.length),
            ...this._u32(crc32(bytes)),
          ]);
        }
        break;
      }
      case SERIAL_DFU_OP.OBJECT_CREATE: {
        const size = frame[2] | (frame[3] << 8) | (frame[4] << 16) | (frame[5] << 24);
        this.createdSizes.push(size);
        const isInit = frame[1] === SERIAL_DFU_OBJECT_TYPE.COMMAND;
        this._selected = isInit ? 'init' : 'firmware';
        if (isInit) {
          this.received.init = [];
          this._objectStart = 0;
        } else {
          // CREATE replaces the current unexecuted object: roll back to the
          // last executed boundary (mirrors the bootloader's erase).
          this.received.firmware = this.received.firmware.slice(0, this._executedLength);
          this._objectStart = this._executedLength;
        }
        this._respond(op, 0x01);
        break;
      }
      case SERIAL_DFU_OP.OBJECT_WRITE: {
        const payload = Array.from(frame.subarray(1));
        this.writesSeen.push(payload.length);
        if (this._selected === 'init') this.received.init.push(...payload);
        else this.received.firmware.push(...payload);
        break; // PRN 0: no response
      }
      case SERIAL_DFU_OP.CRC_GET: {
        const bytes =
          this._selected === 'init'
            ? Uint8Array.from(this.received.init)
            : Uint8Array.from(this.received.firmware);
        let crc = crc32(bytes);
        if (this._selected === 'firmware' && this._corrupted < this.corruptFirstObjects) {
          this._corrupted++;
          // Roll the transfer back to the object boundary, as a real CRC
          // failure would make the client re-create this object.
          this.received.firmware = this.received.firmware.slice(0, this._objectStart);
          crc ^= 0xdeadbeef;
        }
        this._respond(op, 0x01, [...this._u32(bytes.length), ...this._u32(crc)]);
        break;
      }
      case SERIAL_DFU_OP.OBJECT_EXECUTE:
        this.executes.push(this._selected ?? '?');
        if (this._selected === 'firmware') this._executedLength = this.received.firmware.length;
        this._respond(op, 0x01);
        break;
      default:
        this._respond(op, 0x02); // opcode not supported
    }
  }
}

function makeImage(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 7 + 13) % 256);
}

describe('VerisenseSerialDfu', () => {
  it('transfers init + firmware with correct chunking and executes', async () => {
    const mock = new MockSerialBootloader();
    const progress: number[] = [];
    const dfu = new VerisenseSerialDfu(mock, {
      onProgress: (p) => {
        if (p.object === 'firmware') progress.push(p.currentBytes);
      },
    });
    const init = makeImage(141);
    const image = makeImage(4096 * 2 + 500); // two full objects + one partial
    await dfu.update(init.buffer as ArrayBuffer, image.buffer as ArrayBuffer);

    expect(Uint8Array.from(mock.received.init)).toEqual(init);
    expect(Uint8Array.from(mock.received.firmware)).toEqual(image);
    expect(mock.executes).toEqual(['init', 'firmware', 'firmware', 'firmware']);
    expect(mock.createdSizes).toEqual([141, 4096, 4096, 500]);
    // maxWriteSize for MTU 2051 = 1024
    expect(Math.max(...mock.writesSeen)).toBe(1024);
    // progress is monotonic and ends at the image size
    expect(progress.at(-1)).toBe(image.length);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('skips a fully transferred init packet and just executes it', async () => {
    const mock = new MockSerialBootloader();
    const init = makeImage(141);
    mock.received.init = Array.from(init);
    const dfu = new VerisenseSerialDfu(mock);
    await dfu.update(init.buffer as ArrayBuffer, makeImage(100).buffer as ArrayBuffer);
    // No init create happened; sizes are only the single 100-byte data object.
    expect(mock.createdSizes).toEqual([100]);
    expect(mock.executes[0]).toBe('init');
  });

  it('resumes an interrupted firmware transfer from the object boundary', async () => {
    const mock = new MockSerialBootloader();
    const image = makeImage(4096 * 3);
    // 1.5 objects already on the device from an interrupted attempt
    mock.preloadedFirmware = Array.from(image.subarray(0, 4096 + 2048));
    const dfu = new VerisenseSerialDfu(mock);
    await dfu.update(makeImage(141).buffer as ArrayBuffer, image.buffer as ArrayBuffer);
    // Only objects 2 and 3 are re-created (the partial second object restarts
    // at its boundary); object 1 is never resent.
    expect(mock.createdSizes.filter((s) => s === 4096).length).toBe(2);
    expect(Uint8Array.from(mock.received.firmware)).toEqual(image);
  });

  it('restarts from zero when the device-reported CRC does not match', async () => {
    const mock = new MockSerialBootloader();
    const image = makeImage(4096);
    mock.preloadedFirmware = Array.from(makeImage(2048).map((b) => b ^ 0xff));
    const dfu = new VerisenseSerialDfu(mock);
    await dfu.update(makeImage(141).buffer as ArrayBuffer, image.buffer as ArrayBuffer);
    expect(Uint8Array.from(mock.received.firmware)).toEqual(image);
  });

  it('re-sends an object whose CRC fails, then succeeds', async () => {
    const mock = new MockSerialBootloader();
    mock.corruptFirstObjects = 1;
    const image = makeImage(4096 + 100);
    const dfu = new VerisenseSerialDfu(mock);
    await dfu.update(makeImage(141).buffer as ArrayBuffer, image.buffer as ArrayBuffer);
    // First object created twice (initial attempt + retry), second once.
    expect(mock.createdSizes).toEqual([141, 4096, 4096, 100]);
    expect(Uint8Array.from(mock.received.firmware)).toEqual(image);
  });

  it('fails after exhausting object attempts', async () => {
    const mock = new MockSerialBootloader();
    mock.corruptFirstObjects = 99;
    const dfu = new VerisenseSerialDfu(mock, { objectAttempts: 2, requestTimeoutMs: 500 });
    await expect(
      dfu.update(makeImage(141).buffer as ArrayBuffer, makeImage(4096).buffer as ArrayBuffer),
    ).rejects.toThrow(/CRC mismatch/i);
  });

  it('surfaces extended errors with a readable message', async () => {
    const mock = new MockSerialBootloader();
    // Make Execute of the init packet fail with extended error 0x0C
    // (signature verification failed).
    const original = mock['_handle'].bind(mock) as (frame: Uint8Array) => void;
    (mock as unknown as { _handle: (frame: Uint8Array) => void })._handle = (frame) => {
      if (frame[0] === SERIAL_DFU_OP.OBJECT_EXECUTE) {
        (
          mock as unknown as {
            _respond: (op: number, result: number, payload?: number[]) => void;
          }
        )._respond(SERIAL_DFU_OP.OBJECT_EXECUTE, 0x0b, [0x0c]);
        return;
      }
      original(frame);
    };
    const dfu = new VerisenseSerialDfu(mock, { requestTimeoutMs: 500 });
    await expect(
      dfu.update(makeImage(10).buffer as ArrayBuffer, makeImage(10).buffer as ArrayBuffer),
    ).rejects.toThrow(/signature verification failed/i);
  });

  it('rejects on ping mismatch', async () => {
    const mock = new MockSerialBootloader();
    const respond = (
      mock as unknown as {
        _respond: (op: number, result: number, payload?: number[]) => void;
      }
    )._respond.bind(mock);
    (mock as unknown as { _handle: (frame: Uint8Array) => void })._handle = (frame) => {
      if (frame[0] === SERIAL_DFU_OP.PING) {
        respond(SERIAL_DFU_OP.PING, 0x01, [(frame[1] + 1) & 0xff]);
      }
    };
    const dfu = new VerisenseSerialDfu(mock, { requestTimeoutMs: 500 });
    await expect(
      dfu.update(makeImage(10).buffer as ArrayBuffer, makeImage(10).buffer as ArrayBuffer),
    ).rejects.toThrow(/ping mismatch/i);
  });

  it('times out when the device stops responding', async () => {
    const silent: SerialDfuTransportLike = {
      write: async () => {},
      onNotify: () => () => {},
    };
    const dfu = new VerisenseSerialDfu(silent, { requestTimeoutMs: 50 });
    await expect(
      dfu.update(makeImage(10).buffer as ArrayBuffer, makeImage(10).buffer as ArrayBuffer),
    ).rejects.toThrow(/timed out/i);
  });
});
