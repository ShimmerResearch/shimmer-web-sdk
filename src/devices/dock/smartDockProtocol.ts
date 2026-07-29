/**
 * Pure codec for the Shimmer **SmartDock** (Base-6 / Base-15) multi-slot base
 * command layer.
 *
 * This is the *base-level* protocol a SmartDock speaks over its FTDI UART — it
 * is entirely distinct from the per-Shimmer binary `$`-header UART protocol in
 * `./protocol.ts` (D1). The base commands are short **ASCII** strings
 * terminated with `$`; the base replies with `\r\n`-terminated ASCII lines. The
 * SmartDock switches which physical slot (docked Shimmer) is routed onto the
 * *separate* per-Shimmer UART channel, so multi-slot support is: drive these
 * ASCII base commands to enumerate/select a slot, then speak the D1 binary
 * protocol to the now-active slot.
 *
 * Ported from the Java driver (read-only oracle):
 *   com.shimmerresearch.managers.dockManager.SmartDockUart
 *     (SmartDockUart.java:44-65   — BASE_CMD ASCII command strings)
 *     (SmartDockUart.java:194-242 — set active slot / connection type)
 *     (SmartDockUart.java:793-869 — version / active-slot response parse)
 *   com.shimmerresearch.managers.dockManager.SmartDockUartListener
 *     (SmartDockUartListener.java:62-296 — `\r\n` line framing + response
 *      classification by leading char; the `Q,<map>` / `V,...` / `P,NN` shapes)
 *   com.shimmerresearch.comms.wiredProtocol.SmartDockActiveSlotDetails
 *     (SmartDockActiveSlotDetails.java:13-26 — connection types)
 *   com.shimmerresearch.managers.dockManager.SmartDockVerInfoDetails
 *     (SmartDockVerInfoDetails.java:11-31 — HW/FW version fields)
 *   com.shimmerresearch.driverUtilities.HwDriverShimmerDeviceDetails
 *     (HwDriverShimmerDeviceDetails.java:248-250 BASE_HARDWARE_IDS; :313-321
 *      slot counts BASE15→15, BASE6→6)
 *
 * Everything here is side-effect-free so it can be unit-tested with fixtures and
 * reused by {@link SmartDockClient} regardless of the byte pipe underneath.
 */

/** ASCII carriage-return + line-feed — every base response line ends with this. */
export const SMARTDOCK_LINE_TERMINATOR = '\r\n';

/**
 * SmartDock connection type for a slot select (SmartDockActiveSlotDetails.java:13-15).
 * D2 is read-only and only ever uses `WITHOUT_SD_CARD` (partial connect, enough
 * to read the docked Shimmer over the per-Shimmer UART); `WITH_SD_CARD` (full
 * connect for mass-storage) is defined for completeness but NOT driven.
 */
export const SMARTDOCK_CONNECTION_TYPE = Object.freeze({
  DISCONNECTED: 0,
  WITH_SD_CARD: 1,
  WITHOUT_SD_CARD: 2,
} as const);
export type SmartDockConnectionType =
  (typeof SMARTDOCK_CONNECTION_TYPE)[keyof typeof SMARTDOCK_CONNECTION_TYPE];

/**
 * SmartDock base ASCII commands (SmartDockUart.java:44-65). Each is sent as-is
 * over the base UART; a `$` terminates the command. Slot-select commands append
 * `,NN$` (two-digit zero-padded slot, `%02d`, SmartDockUart.java:231).
 *
 * Only the READ-ONLY subset needed for D2 (version, occupancy query, slot
 * select without SD, disconnect) is surfaced as a driven command; the BSL-mask
 * / GPIO / reset / indicator-LED commands in the Java table are deliberately
 * omitted (out of scope, and several are write/flash-adjacent).
 */
export const SMARTDOCK_BASE_CMD = Object.freeze({
  /** `SDV$` → version info. */
  GET_VERSION: 'SDV$',
  /** `SDQ$` → per-slot occupancy bitmap. */
  QUERY_CONNECTED_SLOTS: 'SDQ$',
  /** `SDP$` → current active slot (without-SD form). */
  GET_ACTIVE_SLOT: 'SDP$',
  /** `SDP` prefix → set active slot WITHOUT SD access (append `,NN$`). */
  SET_SLOT_WITHOUT_SD: 'SDP',
  /** `SDC` prefix → set active slot WITH SD access (append `,NN$`). Not driven in D2. */
  SET_SLOT_WITH_SD: 'SDC',
  /** `SDD$` → disconnect all slots. */
  DISCONNECT_ALL: 'SDD$',
} as const);

/**
 * SmartDock request/response timing, ported from
 * com.shimmerresearch.managers.dockManager.SmartDock (SmartDock.java):
 * - `SMARTDOCK_RESPONSE_TIMEOUT` = 1000 ms (:66) — normal base command reply.
 * - `SMARTDOCK_RESPONSE_TIMEOUT_SLOT_CHANGE` = 10000 ms (:67) — slot switch.
 * and com.shimmerresearch.managers.dockManager.AbstractDock:
 * - `SLOT_CHANGEOVER_DELAY_WITHOUT_SD_CARD` = 1500 ms (AbstractDock.java:96) —
 *   settle delay after a without-SD slot change before talking to the Shimmer.
 * - `CMD_RETRY_ATTEMPTS` = 2 (SmartDockUart.java:30).
 */
export const SMARTDOCK_DEFAULTS = Object.freeze({
  RESPONSE_TIMEOUT_MS: 1000,
  SLOT_CHANGE_TIMEOUT_MS: 10000,
  SLOT_CHANGEOVER_DELAY_MS: 1500,
  CMD_RETRY_ATTEMPTS: 2,
});

/**
 * Base hardware IDs from the version response's hardware-version field
 * (HwDriverShimmerDeviceDetails.java:248-250 `BASE_HARDWARE_IDS`).
 */
export const BASE_HARDWARE_IDS = Object.freeze({
  BASE15U: 1,
  BASE6U: 2,
} as const);

/** The SmartDock family a base belongs to (derived from its hardware-version). */
export type SmartDockHardwareType = 'base6' | 'base15' | 'basic' | 'unknown';

/**
 * Map a base hardware-version byte to a family + slot count
 * (HwDriverShimmerDeviceDetails.java:313-321: BASE15→15 slots, BASE6→6 slots,
 * BASICDOCK→1). NB: in the Java driver the slot count actually comes from the
 * USB device descriptor, not the version byte — see the SmartDock README
 * hardware-verify note.
 */
export function baseHardwareType(hardwareVersion: number): {
  hardwareType: SmartDockHardwareType;
  slotCount: number;
} {
  switch (hardwareVersion) {
    case BASE_HARDWARE_IDS.BASE15U:
      return { hardwareType: 'base15', slotCount: 15 };
    case BASE_HARDWARE_IDS.BASE6U:
      return { hardwareType: 'base6', slotCount: 6 };
    default:
      return { hardwareType: 'unknown', slotCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// TX — command assembly
// ---------------------------------------------------------------------------

const ASCII = new TextEncoder();

/** Encode a base ASCII command string to bytes (UTF-8 == ASCII for this set). */
export function buildBaseCommand(cmd: string): Uint8Array {
  return ASCII.encode(cmd);
}

/**
 * Build a slot-select command: `SDP,NN$` (without SD) or `SDC,NN$` (with SD),
 * or `SDD$` (disconnect all). Slot is formatted `%02d`
 * (SmartDockUart.java:194-231). Slot values 1..15 (1-based, matching the UI /
 * the Java `SmartDockActiveSlotDetails.mSlot`).
 */
export function buildSelectSlotCommand(
  slot: number,
  connectionType: SmartDockConnectionType,
): Uint8Array {
  if (connectionType === SMARTDOCK_CONNECTION_TYPE.DISCONNECTED) {
    return buildBaseCommand(SMARTDOCK_BASE_CMD.DISCONNECT_ALL);
  }
  const prefix =
    connectionType === SMARTDOCK_CONNECTION_TYPE.WITH_SD_CARD
      ? SMARTDOCK_BASE_CMD.SET_SLOT_WITH_SD
      : SMARTDOCK_BASE_CMD.SET_SLOT_WITHOUT_SD;
  const nn = String(slot).padStart(2, '0');
  return buildBaseCommand(`${prefix},${nn}$`);
}

// ---------------------------------------------------------------------------
// RX — `\r\n` line framing over the unframed serial byte stream
// ---------------------------------------------------------------------------

const ASCII_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * Extract the first complete `\r\n`-terminated line from an accumulated ASCII
 * buffer, returning the line (WITHOUT the terminator) and the remaining bytes,
 * or null when no complete line is buffered yet.
 *
 * This is the base-channel analogue of the D1 `wiredPacketLength` framing: the
 * SmartDock UART is an unframed serial byte stream, so the client accumulates
 * inbound bytes and pulls out whole lines. Mirrors the `indexOf("\r\n")` split
 * in SmartDockUartListener.java:62-67.
 */
export function extractBaseLine(buf: Uint8Array): { line: string; rest: Uint8Array } | null {
  // Find CR LF (0x0d 0x0a).
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
      const line = ASCII_DECODER.decode(buf.subarray(0, i));
      const rest = buf.subarray(i + 2);
      return { line, rest: rest.length ? new Uint8Array(rest) : new Uint8Array(0) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response parsers (classify by leading character, per the Java listener)
// ---------------------------------------------------------------------------

/** The kinds of base response line we recognise. */
export type SmartDockResponseKind =
  | 'version'
  | 'occupancy'
  | 'slotWithoutSd'
  | 'slotWithSd'
  | 'disconnected'
  | 'error'
  | 'boot'
  | 'unknown';

/** Parsed SmartDock HW/FW version (SmartDockVerInfoDetails.java). */
export interface SmartDockVersionInfo {
  hardwareVersion: number;
  firmwareIdentifier: number;
  firmwareVersionMajor: number;
  firmwareVersionMinor: number;
  firmwareVersionInternal: number;
}

/** Parsed active-slot response (SmartDockActiveSlotDetails). */
export interface SmartDockActiveSlot {
  /** 1-based slot number, or -1 when disconnected. */
  slot: number;
  connectionType: SmartDockConnectionType;
}

/**
 * Classify a base response line by its leading character
 * (SmartDockUartListener.java:71-296). Used to route a line to the awaiting
 * operation and to discard unrelated / garbage lines (resync discipline).
 */
export function classifyBaseResponse(line: string): SmartDockResponseKind {
  if (line.length === 0) return 'unknown';
  if (line === 'E') return 'error';
  const c = line.charAt(0);
  const hasComma = line.charAt(1) === ',';
  if (c === 'V' && hasComma) return 'version';
  if (c === 'Q' && hasComma) return 'occupancy';
  if (c === 'S' && hasComma) return 'occupancy'; // auto-notify slot map, same shape
  if (c === 'P' && hasComma) return 'slotWithoutSd';
  if (c === 'C' && hasComma) return 'slotWithSd';
  if (c === 'C' || c === 'D') return 'disconnected';
  if (line.includes('Shimmer SmartDock Initialised')) return 'boot';
  return 'unknown';
}

/**
 * Parse a `V,<hw>,<fwId>,<major>,<minor>,<internal>` version line
 * (SmartDockUart.java:796-806). Returns null when malformed (wrong prefix or not
 * exactly 5 comma-separated integers after `V,`).
 */
export function parseSmartDockVersion(line: string): SmartDockVersionInfo | null {
  if (classifyBaseResponse(line) !== 'version') return null;
  const parts = line.slice(2).split(',');
  if (parts.length !== 5) return null;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return {
    hardwareVersion: nums[0],
    firmwareIdentifier: nums[1],
    firmwareVersionMajor: nums[2],
    firmwareVersionMinor: nums[3],
    firmwareVersionInternal: nums[4],
  };
}

/**
 * Parse a slot-occupancy line `Q,<map>` (or auto-notify `S,<map>`) into a
 * per-slot boolean array (SmartDockUartListener.java:140-181). Each map char is
 * ASCII `'0'`/`'1'`; index 0 → slot 1, etc. The map length is the base's slot
 * count. Returns null when malformed.
 *
 * NB: the Java `remapSlotsSmartDockToUi` remap for the BASE15U *prototype*
 * board (firmware 1.0.0.≤5) is deliberately NOT applied here — it only affects
 * pre-production hardware; see the README hardware-verify note.
 */
export function parseSlotOccupancy(line: string): boolean[] | null {
  if (classifyBaseResponse(line) !== 'occupancy') return null;
  const map = line.slice(2);
  if (map.length === 0) return null;
  const out: boolean[] = [];
  for (const ch of map) {
    if (ch !== '0' && ch !== '1') return null;
    out.push(ch === '1');
  }
  return out;
}

/**
 * Parse an active-slot response line into slot + connection type
 * (SmartDockUart.java:810-869):
 * - `P,NN` → WITHOUT_SD, slot NN
 * - `C,NN` → WITH_SD, slot NN
 * - `C` / `D` → DISCONNECTED, slot -1
 * Returns null when the numeric slot is malformed.
 */
export function parseActiveSlot(line: string): SmartDockActiveSlot | null {
  const kind = classifyBaseResponse(line);
  if (kind === 'disconnected') {
    return { slot: -1, connectionType: SMARTDOCK_CONNECTION_TYPE.DISCONNECTED };
  }
  if (kind === 'slotWithoutSd' || kind === 'slotWithSd') {
    const slotStr = line.slice(2);
    if (!/^\d+$/.test(slotStr)) return null;
    return {
      slot: Number.parseInt(slotStr, 10),
      connectionType:
        kind === 'slotWithSd'
          ? SMARTDOCK_CONNECTION_TYPE.WITH_SD_CARD
          : SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD,
    };
  }
  return null;
}
