/**
 * Verisense Nordic Secure-DFU over USB CDC serial (Web Serial).
 *
 * The combined BLE+USB bootloader (v3) exposes Nordic's serial DFU transport
 * on its own USB CDC port (VID 0x1915 / PID 0x521F, product "Verisense DFU"),
 * carrying the same secure-DFU request handler as BLE — same signed `.zip`
 * packages, same object/CRC/execute protocol — but framed with SLIP
 * (RFC 1055) instead of GATT characteristics.
 *
 * This module is self-contained (no dependency on the vendored
 * `web-bluetooth-dfu` scripts): SLIP codec, CRC-32, and the serial secure-DFU
 * state machine. The byte transport is injected structurally and
 * {@link WebSerialTransport} satisfies it directly. Package parsing stays with
 * the vendored `SecureDfuPackage` (see `VerisenseDfuPackage` in `dfu.ts`) —
 * the `initData`/`imageData` buffers it yields are exactly what
 * {@link VerisenseSerialDfu.update} consumes.
 *
 * Flow (mirrors nrfutil's `dfu usb-serial`): ping → PRN 0 → MTU → command
 * object (init packet) → data objects (firmware, `max_size` chunks, each
 * CRC-validated before Execute). Writes carry no per-write response at PRN 0 —
 * USB CDC is a reliable stream — so validation happens per object via CRC_GET.
 * Interrupted transfers resume from the last completed object when the
 * device-reported CRC matches ours.
 */

// ── SLIP framing (RFC 1055, as used by Nordic's serial DFU) ────────────────

export const SLIP_END = 0xc0;
export const SLIP_ESC = 0xdb;
export const SLIP_ESC_END = 0xdc;
export const SLIP_ESC_ESC = 0xdd;

/** SLIP-encode one frame (terminating END appended; none prepended, matching
 * Nordic's encoder). */
export function slipEncode(frame: Uint8Array | number[]): Uint8Array {
  const out: number[] = [];
  for (const byte of frame) {
    if (byte === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END);
    else if (byte === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC);
    else out.push(byte);
  }
  out.push(SLIP_END);
  return Uint8Array.from(out);
}

/**
 * Streaming SLIP decoder: feed arbitrary chunks, get back completed frames.
 * Empty frames (back-to-back ENDs) are dropped, matching Nordic's decoder.
 */
export class SlipDecoder {
  private _frame: number[] = [];
  private _escaped = false;

  /** Decode a chunk; returns every frame completed by it (possibly none). */
  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (const byte of chunk) {
      if (this._escaped) {
        this._escaped = false;
        if (byte === SLIP_ESC_END) this._frame.push(SLIP_END);
        else if (byte === SLIP_ESC_ESC) this._frame.push(SLIP_ESC);
        // Invalid escape: RFC 1055 leaves the byte in place; keep it so a
        // corrupt frame fails its response check rather than desyncing.
        else this._frame.push(byte);
      } else if (byte === SLIP_ESC) {
        this._escaped = true;
      } else if (byte === SLIP_END) {
        if (this._frame.length > 0) frames.push(Uint8Array.from(this._frame));
        this._frame = [];
      } else {
        this._frame.push(byte);
      }
    }
    return frames;
  }

  reset(): void {
    this._frame = [];
    this._escaped = false;
  }
}

// ── CRC-32 (IEEE 802.3, the polynomial Nordic's DFU uses) ──────────────────

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of `data`, continuing from `seed` (pass a previous crc32 result to
 * extend it). Returns an unsigned 32-bit value. */
export function crc32(data: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

// ── Serial secure-DFU protocol constants ────────────────────────────────────

/** Request opcodes (identical to the BLE control-point opcodes; over serial,
 * data writes are the explicit OBJECT_WRITE opcode instead of a second
 * characteristic). */
export const SERIAL_DFU_OP = Object.freeze({
  OBJECT_CREATE: 0x01,
  RECEIPT_NOTIF_SET: 0x02,
  CRC_GET: 0x03,
  OBJECT_EXECUTE: 0x04,
  OBJECT_SELECT: 0x06,
  MTU_GET: 0x07,
  OBJECT_WRITE: 0x08,
  PING: 0x09,
  RESPONSE: 0x60,
});

export const SERIAL_DFU_OBJECT_TYPE = Object.freeze({
  COMMAND: 0x01, // init packet
  DATA: 0x02, // firmware image
});

/** Result codes carried in responses (nrf_dfu_response_t). */
export const SERIAL_DFU_RESULT_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0x00: 'Invalid opcode',
  0x01: 'Success',
  0x02: 'Opcode not supported',
  0x03: 'Invalid parameter',
  0x04: 'Insufficient resources',
  0x05: 'Invalid object',
  0x07: 'Unsupported object type',
  0x08: 'Operation not permitted',
  0x0a: 'Operation failed',
  0x0b: 'Extended error',
});

/** Extended-error codes (nrf_dfu_ext_error_code_t) that follow result 0x0B. */
export const SERIAL_DFU_EXTENDED_ERROR_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0x00: 'No error',
  0x01: 'Invalid error code',
  0x02: 'Wrong command format',
  0x03: 'Unknown command',
  0x04: 'Init command invalid',
  0x05: 'Firmware version too low',
  0x06: 'Hardware version mismatch',
  0x07: 'SoftDevice version mismatch',
  0x08: 'Signature missing',
  0x09: 'Wrong hash type',
  0x0a: 'Hash calculation failed',
  0x0b: 'Wrong signature type',
  0x0c: 'Signature verification failed',
  0x0d: 'Insufficient space',
});

/**
 * The v3 bootloader's USB identity in DFU mode. Deliberately distinct from
 * the application's CDC port (0x1915/0x520F) so a Web Serial picker — which
 * can only filter on VID/PID — shows exactly the bootloader.
 */
export const VERISENSE_USB_DFU_VID = 0x1915;
export const VERISENSE_USB_DFU_PID = 0x521f;

/** `navigator.serial.requestPort()` filters for the bootloader's DFU port. */
export const VERISENSE_USB_DFU_PORT_FILTERS: ReadonlyArray<{
  usbVendorId: number;
  usbProductId: number;
}> = Object.freeze([
  Object.freeze({ usbVendorId: VERISENSE_USB_DFU_VID, usbProductId: VERISENSE_USB_DFU_PID }),
]);

/**
 * After the firmware ACKs a `DFU_MODE` request received over USB it reboots
 * ~300 ms later (the delay lets the ACK drain), the application port
 * disappears, and the bootloader enumerates as 0x1915/0x521F. Give the OS a
 * moment to enumerate before offering the picker.
 */
export const VERISENSE_USB_DFU_REENUMERATION_DELAY_MS = 2000;

/**
 * True when a `DFU_MODE` property-write rejection means the unit cannot enter
 * DFU mode from USB: firmware on a BLE-only (v2) bootloader NACKs the request
 * (the reboot would strand the device off the bus until the bootloader's
 * inactivity timeout). The caller should fall back to the BLE DFU flow.
 *
 * Keyed on the DFU_MODE property code (0x6) in the client's NACK message
 * ("Device returned NACK command=0x.. property=0x6", unpadded hex — see
 * `validatePendingResponse` in requestValidation.ts) so NACKs from unrelated
 * requests are never misclassified as "USB DFU unsupported".
 */
export function isUsbDfuUnsupportedError(error: unknown): boolean {
  return /NACK.*property=0x0?6\b/i.test(String(error));
}

// ── Transport + options ─────────────────────────────────────────────────────

/** The slice of {@link WebSerialTransport} this module drives (structural, so
 * tests can supply a mock and no import cycle is created). */
export interface SerialDfuTransportLike {
  write(data: Uint8Array): Promise<void>;
  onNotify(cb: (data: Uint8Array) => void): () => void;
}

export interface VerisenseSerialDfuProgress {
  object: 'init' | 'firmware';
  totalBytes: number;
  currentBytes: number;
}

export interface VerisenseSerialDfuOptions {
  /** User-facing progress text (same role as the BLE flow's onStatus). */
  onStatus?: (message: string) => void;
  /** Byte-level transfer progress (same field names as the vendored
   * `SecureDfu` "progress" events, so UI code is shared). */
  onProgress?: (progress: VerisenseSerialDfuProgress) => void;
  /** Diagnostic log lines (protocol chatter; not for end users). */
  onLog?: (message: string) => void;
  /**
   * Bound on each request/response exchange. Execute of the final data object
   * covers the bootloader's signature verification and can take several
   * seconds; the default is generous because USB itself is not the
   * bottleneck.
   */
  requestTimeoutMs?: number;
  /** Attempts per data object before giving up (a CRC mismatch re-creates and
   * re-sends just that object). */
  objectAttempts?: number;
}

export const VERISENSE_SERIAL_DFU_REQUEST_TIMEOUT_MS = 15000;
export const VERISENSE_SERIAL_DFU_OBJECT_ATTEMPTS = 3;

// ── The DFU driver ──────────────────────────────────────────────────────────

interface PendingRequest {
  opcode: number;
  resolve: (payload: Uint8Array) => void;
  reject: (error: Error) => void;
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function readU32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) +
    bytes[offset + 3] * 0x1000000
  );
}

function opcodeName(opcode: number): string {
  for (const [name, value] of Object.entries(SERIAL_DFU_OP)) {
    if (value === opcode) return name;
  }
  return `0x${opcode.toString(16)}`;
}

/**
 * Nordic secure DFU over a SLIP-framed serial byte stream.
 *
 * One instance drives one transfer session; construct it around a connected
 * transport whose port is the bootloader's DFU port (see
 * {@link VERISENSE_USB_DFU_PORT_FILTERS}) and call {@link update} with the
 * `initData`/`imageData` of each image in the package (base image first when
 * present, application after — same ordering as `runVerisenseDfuUpdate`).
 */
export class VerisenseSerialDfu {
  private readonly _transport: SerialDfuTransportLike;
  private readonly _options: VerisenseSerialDfuOptions;
  private readonly _decoder = new SlipDecoder();
  private _pending: PendingRequest | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _mtu = 0;

  constructor(transport: SerialDfuTransportLike, options: VerisenseSerialDfuOptions = {}) {
    this._transport = transport;
    this._options = options;
  }

  /** Max unencoded bytes per OBJECT_WRITE frame: worst-case SLIP encoding
   * doubles every byte, plus the terminating END, minus the opcode byte
   * (matches nrfutil's `(mtu - 1) // 2 - 1`). */
  get maxWriteSize(): number {
    return Math.floor((this._mtu - 1) / 2) - 1;
  }

  /**
   * Transfer one image (init packet + firmware binary). Resolves when the
   * final Execute is acknowledged — for an application image that is the
   * point where the bootloader resets to activate it, which also drops the
   * serial port; the caller should expect the port to disappear.
   */
  async update(init: ArrayBuffer, image: ArrayBuffer): Promise<void> {
    if (this._unsubscribe) throw new Error('A transfer is already in progress');
    this._decoder.reset();
    this._unsubscribe = this._transport.onNotify((chunk) => this._onData(chunk));
    try {
      await this._handshake();
      await this._transferInit(new Uint8Array(init));
      await this._transferFirmware(new Uint8Array(image));
    } finally {
      this._unsubscribe?.();
      this._unsubscribe = null;
      const pending = this._pending;
      this._pending = null;
      pending?.reject(new Error('Transfer closed'));
    }
  }

  // ── protocol steps ────────────────────────────────────────────────────────

  private async _handshake(): Promise<void> {
    const pingId = Math.floor(Math.random() * 256);
    const pong = await this._request(SERIAL_DFU_OP.PING, [pingId]);
    if (pong.length < 1 || pong[0] !== pingId) {
      throw new Error(`DFU ping mismatch (sent ${pingId}, got ${pong[0] ?? 'nothing'})`);
    }
    // PRN 0: no per-write receipts — USB CDC is reliable; objects are
    // CRC-validated explicitly before Execute.
    await this._request(SERIAL_DFU_OP.RECEIPT_NOTIF_SET, u16le(0));
    const mtuRsp = await this._request(SERIAL_DFU_OP.MTU_GET);
    if (mtuRsp.length < 2) throw new Error('DFU MTU response too short');
    this._mtu = mtuRsp[0] | (mtuRsp[1] << 8);
    if (this.maxWriteSize < 1) throw new Error(`DFU MTU unusable (${this._mtu})`);
    this._options.onLog?.(`serial DFU ready: mtu=${this._mtu} maxWrite=${this.maxWriteSize}`);
  }

  private async _transferInit(init: Uint8Array): Promise<void> {
    this._options.onStatus?.('Transferring init packet...');
    const sel = await this._select(SERIAL_DFU_OBJECT_TYPE.COMMAND);
    if (sel.offset === init.length && sel.crc === crc32(init)) {
      // Same init packet already transferred (interrupted attempt): just
      // (re-)execute it.
      this._options.onLog?.('init packet already transferred; executing');
      await this._request(SERIAL_DFU_OP.OBJECT_EXECUTE);
      return;
    }
    if (init.length > sel.maxSize) {
      throw new Error(`Init packet too large (${init.length} > ${sel.maxSize})`);
    }
    await this._request(SERIAL_DFU_OP.OBJECT_CREATE, [
      SERIAL_DFU_OBJECT_TYPE.COMMAND,
      ...u32le(init.length),
    ]);
    await this._writeData(init, 'init', init.length, 0);
    const { offset, crc } = await this._crcGet();
    if (offset !== init.length || crc !== crc32(init)) {
      throw new Error(
        `Init packet CRC mismatch (offset ${offset}/${init.length}, crc 0x${crc.toString(16)})`,
      );
    }
    await this._request(SERIAL_DFU_OP.OBJECT_EXECUTE);
  }

  private async _transferFirmware(image: Uint8Array): Promise<void> {
    const sel = await this._select(SERIAL_DFU_OBJECT_TYPE.DATA);
    const attempts = this._options.objectAttempts ?? VERISENSE_SERIAL_DFU_OBJECT_ATTEMPTS;

    // Resume: trust the device-reported offset only when our CRC of that
    // prefix matches. The write position cannot be rewound arbitrarily —
    // OBJECT_CREATE always (re)creates at the device's current position, so
    // only the current (unexecuted) object can be rolled back. That is also
    // sufficient: executed objects were CRC-validated before Execute, and
    // executing a *different* image's init packet resets the stored progress
    // to zero, so a mismatch can only live in the unexecuted tail (any deeper
    // corruption surfaces as an object CRC failure below).
    let startOffset = 0;
    if (sel.offset > 0 && sel.offset <= image.length) {
      const prefixMatches = crc32(image.subarray(0, sel.offset)) === sel.crc;
      if (prefixMatches && sel.offset === image.length) {
        this._options.onLog?.('firmware already transferred; executing');
        await this._request(SERIAL_DFU_OP.OBJECT_EXECUTE);
        return;
      }
      if (prefixMatches) {
        // Partial object: re-create it from its boundary. Boundary offset:
        // continue with the next object.
        startOffset = sel.offset - (sel.offset % sel.maxSize);
      } else {
        const remainder = sel.offset % sel.maxSize;
        startOffset =
          sel.offset - (remainder !== 0 ? remainder : Math.min(sel.maxSize, sel.offset));
        this._options.onLog?.(
          `device-reported firmware CRC mismatch at ${sel.offset}; rolling back to ${startOffset}`,
        );
      }
      if (startOffset > 0) {
        this._options.onStatus?.(`Resuming firmware transfer at ${startOffset} bytes...`);
      }
    }

    this._options.onStatus?.('Transferring firmware image...');
    this._options.onProgress?.({
      object: 'firmware',
      totalBytes: image.length,
      currentBytes: startOffset,
    });

    for (let offset = startOffset; offset < image.length; offset += sel.maxSize) {
      const chunk = image.subarray(offset, Math.min(offset + sel.maxSize, image.length));
      let lastError: Error | null = null;
      let done = false;
      for (let attempt = 1; attempt <= attempts && !done; attempt++) {
        if (attempt > 1) {
          this._options.onLog?.(
            `re-sending object at ${offset} (attempt ${attempt} of ${attempts})`,
          );
        }
        await this._request(SERIAL_DFU_OP.OBJECT_CREATE, [
          SERIAL_DFU_OBJECT_TYPE.DATA,
          ...u32le(chunk.length),
        ]);
        await this._writeData(chunk, 'firmware', image.length, offset);
        const { offset: devOffset, crc } = await this._crcGet();
        const expectedCrc = crc32(image.subarray(0, offset + chunk.length));
        if (devOffset === offset + chunk.length && crc === expectedCrc) {
          await this._request(SERIAL_DFU_OP.OBJECT_EXECUTE);
          done = true;
        } else {
          lastError = new Error(
            `Object CRC mismatch at ${offset} (device offset ${devOffset}, crc 0x${crc.toString(16)})`,
          );
        }
      }
      if (!done) throw lastError ?? new Error(`Object transfer failed at ${offset}`);
    }
    this._options.onStatus?.('Firmware transfer complete.');
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private async _writeData(
    data: Uint8Array,
    object: 'init' | 'firmware',
    totalBytes: number,
    baseOffset: number,
  ): Promise<void> {
    const sliceSize = this.maxWriteSize;
    for (let pos = 0; pos < data.length; pos += sliceSize) {
      const slice = data.subarray(pos, Math.min(pos + sliceSize, data.length));
      const frame = new Uint8Array(1 + slice.length);
      frame[0] = SERIAL_DFU_OP.OBJECT_WRITE;
      frame.set(slice, 1);
      await this._transport.write(slipEncode(frame));
      this._options.onProgress?.({
        object,
        totalBytes,
        currentBytes: baseOffset + pos + slice.length,
      });
    }
  }

  private async _select(
    objectType: number,
  ): Promise<{ maxSize: number; offset: number; crc: number }> {
    const rsp = await this._request(SERIAL_DFU_OP.OBJECT_SELECT, [objectType]);
    if (rsp.length < 12) throw new Error('DFU select response too short');
    return { maxSize: readU32le(rsp, 0), offset: readU32le(rsp, 4), crc: readU32le(rsp, 8) };
  }

  private async _crcGet(): Promise<{ offset: number; crc: number }> {
    const rsp = await this._request(SERIAL_DFU_OP.CRC_GET);
    if (rsp.length < 8) throw new Error('DFU CRC response too short');
    return { offset: readU32le(rsp, 0), crc: readU32le(rsp, 4) };
  }

  private _request(
    opcode: number,
    params: Uint8Array | number[] = [],
    timeoutMs?: number,
  ): Promise<Uint8Array> {
    if (this._pending) {
      return Promise.reject(new Error('A DFU request is already pending'));
    }
    const effectiveTimeout =
      timeoutMs ?? this._options.requestTimeoutMs ?? VERISENSE_SERIAL_DFU_REQUEST_TIMEOUT_MS;
    const frame = new Uint8Array(1 + params.length);
    frame[0] = opcode;
    frame.set(params instanceof Uint8Array ? params : Uint8Array.from(params), 1);

    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error(`DFU ${opcodeName(opcode)} timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      this._pending = {
        opcode,
        resolve: (payload) => {
          clearTimeout(timer);
          this._pending = null;
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timer);
          this._pending = null;
          reject(error);
        },
      };
      this._transport.write(slipEncode(frame)).catch((error: unknown) => {
        this._pending?.reject(new Error(`DFU ${opcodeName(opcode)} write failed: ${error}`));
      });
    });
  }

  private _onData(chunk: Uint8Array): void {
    for (const frame of this._decoder.push(chunk)) {
      const pending = this._pending;
      if (!pending) {
        this._options.onLog?.(`unexpected DFU frame (${frame.length} bytes) with no request`);
        continue;
      }
      if (frame.length < 3 || frame[0] !== SERIAL_DFU_OP.RESPONSE || frame[1] !== pending.opcode) {
        this._options.onLog?.(
          `ignoring DFU frame [${Array.from(frame.slice(0, 4))
            .map((b) => `0x${b.toString(16)}`)
            .join(', ')}...] while waiting for ${opcodeName(pending.opcode)}`,
        );
        continue;
      }
      const result = frame[2];
      if (result === 0x01) {
        pending.resolve(frame.subarray(3));
        continue;
      }
      let message = SERIAL_DFU_RESULT_NAMES[result] ?? `Unknown result 0x${result.toString(16)}`;
      if (result === 0x0b && frame.length >= 4) {
        const ext = frame[3];
        message = `${SERIAL_DFU_EXTENDED_ERROR_NAMES[ext] ?? `Extended error 0x${ext.toString(16)}`}`;
      }
      pending.reject(new Error(`DFU ${opcodeName(pending.opcode)} failed: ${message}`));
    }
  }
}
