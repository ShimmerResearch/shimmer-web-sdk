/**
 * What a Shimmer says about itself when asked: which Bluetooth module it
 * carries, and which board it is.
 *
 * The VALUES are the same whichever way a host reaches the sensor: one set of
 * SR codes, one set of module version strings, arriving over BLE, classic
 * Bluetooth and the dock alike. That is why the tables and the formatting live
 * here rather than inside a client.
 *
 * Two clients read them today — `Shimmer3RClient` and `WiredShimmerClient`.
 * `Shimmer3Client`, the classic-Bluetooth-only client, does not: it has no
 * identity reads of its own yet. Nothing here is Shimmer3R-specific, so it is
 * a matter of adding the two reads rather than of extending this module.
 */

/** Shimmer platform, from the hardware id the sensor reports. */
export const SHIMMER_PLATFORM_NAMES: Readonly<Record<number, string>> = Object.freeze({
  3: 'Shimmer3',
  10: 'Shimmer3R',
});

/**
 * SR code → board name, from the Java driver's `mMapOfShimmerHardware`
 * (`ShimmerVerDetails.java:136-169`), whose codes match the firmware's own
 * `SR_BOARD_CODES` enum (`Boards/shimmer_boards.h:26-43`) exactly.
 *
 * These are NOT Shimmer3-only. A Shimmer3R reports the same codes for the
 * same sensor configurations — the firmware tests for them without regard to
 * platform, and in one place explicitly pairs `HW_ID_SHIMMER3R` with
 * `EXP_BRD_EXG_UNIFIED` (`Boards/shimmer_boards.c:136-137`).
 *
 * Codes 56-59 and 61-68 (ShimmerGQ, Shimmer4, ECGmd and the Verisense family)
 * are in the Java map but omitted here: they are other product lines, this SDK
 * addresses them through their own clients, and a Shimmer3-family sensor
 * reporting one of them would be a fault worth showing raw rather than naming.
 */
export const SHIMMER_SR_BOARD_NAMES: Readonly<Record<number, string>> = Object.freeze({
  8: 'Bridge Amplifier+',
  9: 'Span',
  14: 'GSR+',
  31: 'IMU',
  36: 'PROTO3 Mini',
  37: 'ECG/EMG',
  38: 'PROTO3 Deluxe',
  41: 'Base15U',
  42: 'Base6U',
  44: '200g Accel',
  46: 'GPS',
  47: 'ECG/EMG/Resp',
  48: 'GSR+',
  49: 'Bridge Amplifier+',
  55: 'High-g Accel',
});

/** The three bytes at the start of the daughter-card id page. */
export interface ShimmerSrBoard {
  boardId: number;
  boardRev: number;
  specialRev: number;
}

/**
 * `SR48-3-0` — the form Shimmer's own product documentation and labels use.
 *
 * The Java driver's `getBoardVerString()` (`ExpansionBoardDetails.java:100-102`)
 * joins the same three numbers with dots instead. Hyphens are used here
 * because that is what is printed on the boards.
 */
export function formatShimmerSrCode(board: ShimmerSrBoard): string {
  return `SR${board.boardId}-${board.boardRev}-${board.specialRev}`;
}

/**
 * True when the daughter-card id page holds a real board rather than one of
 * the two "nothing here" patterns — all zeroes (never written) or all 0xFF
 * (erased). Port of `isExpansionBoardValid()`
 * (`ExpansionBoardDetails.java:104-111`).
 */
export function isShimmerSrBoardValid(
  board: ShimmerSrBoard | null | undefined,
): board is ShimmerSrBoard {
  if (!board) return false;
  const { boardId, boardRev, specialRev } = board;
  if (boardId === 0 && boardRev === 0 && specialRev === 0) return false;
  if (boardId === 0xff && boardRev === 0xff && specialRev === 0xff) return false;
  return true;
}

/** A sensor's board identity, ready to render. */
export interface ShimmerHardwareDescription {
  /** `'Shimmer3'` / `'Shimmer3R'`, or null when the hardware id is unknown. */
  platform: string | null;
  /** `'GSR+'`, or null when the SR code is not in {@link SHIMMER_SR_BOARD_NAMES}. */
  boardName: string | null;
  /** `'SR48-3-0'`, or null when no valid board was read. */
  srCode: string | null;
  /**
   * Everything known, as one line: `'Shimmer3R GSR+ (SR48-3-0)'`. Degrades a
   * piece at a time — an unnamed SR code gives `'Shimmer3R (SR52-1-0)'`, no
   * board at all gives `'Shimmer3R'`, a hardware id outside
   * {@link SHIMMER_PLATFORM_NAMES} gives `'hardware id 7 GSR+ (SR48-3-0)'`, a
   * board with no platform gives `'GSR+ (SR48-3-0)'`, and nothing known at all
   * gives `'unknown hardware'`.
   */
  label: string;
}

/**
 * Describe a sensor's hardware for display: platform, board name and SR code.
 *
 * Every part is optional because every part can be missing in practice — an
 * older firmware that does not answer the hardware-version command, a board
 * whose id page was never written, an SR code newer than this table.
 */
export function describeShimmerHardware(
  hardwareVersion: number | null | undefined,
  board?: ShimmerSrBoard | null,
): ShimmerHardwareDescription {
  const platform =
    hardwareVersion == null ? null : (SHIMMER_PLATFORM_NAMES[hardwareVersion] ?? null);
  const valid = isShimmerSrBoardValid(board) ? board : null;
  const boardName = valid ? (SHIMMER_SR_BOARD_NAMES[valid.boardId] ?? null) : null;
  const srCode = valid ? formatShimmerSrCode(valid) : null;

  /* A sensor that will not say which platform it is still has a board, and
   * "unknown hardware GSR+ (SR48-3-0)" reads like a fault rather than a
   * description. When there is no platform to lead with, the board name leads
   * instead; a known-but-unnamed hardware id is kept, because the number is
   * real information. */
  let head: string | null = platform;
  if (!head && hardwareVersion != null) head = `hardware id ${hardwareVersion}`;

  let named: string;
  if (head) named = boardName ? `${head} ${boardName}` : head;
  else named = boardName ?? 'unknown hardware';

  const label = srCode ? `${named} (${srCode})` : named;

  return { platform, boardName, srCode, label };
}

// ---------------------------------------------------------------------------
// Bluetooth module version
// ---------------------------------------------------------------------------

/** Which module answered the version query. */
export type BluetoothModuleFamily = 'rn41' | 'rn42' | 'rn4678' | 'cyw20820' | 'unknown';

/**
 * One row of the known-module table: the substring to look for, and what to
 * call the module when it is found.
 */
export interface BluetoothModuleVersionEntry {
  /** Substring searched for in the module's own reply. */
  match: string;
  family: BluetoothModuleFamily;
  model: string;
  version: string;
}

/**
 * The Bluetooth module replies the Shimmer3 firmware is known to capture,
 * ported from the Java driver's `BT_MODULE_VERSION` enum
 * (`BluetoothModuleVersionDetails.java:15-39`) — its middle column is the
 * substring, its third column the user-facing name.
 *
 * Two of the Java names disagree with the reply they are matched against and
 * are corrected here, because a host that shows a version the module did not
 * report is worse than one that shows none:
 *
 * - `RN4678 V1.13.5` was labelled `v1.15.5`
 * - `RN4678 V1.22` was labelled `v1.23`, the same as the entry below it
 *
 * HARDWARE-VERIFY: transcribed from the Java table, not from modules of each
 * revision. The substrings are what matter and they come from the modules'
 * own datasheet-documented replies, but only RN4678 v1.23 and the CYW20820
 * have been seen by this SDK.
 */
export const BLUETOOTH_MODULE_VERSIONS: readonly BluetoothModuleVersionEntry[] = Object.freeze([
  { match: 'Ver 4.77 RN-42', family: 'rn42', model: 'RN42', version: '4.77' },
  { match: 'Ver 6.15 04', family: 'rn42', model: 'RN42', version: '6.15' },
  { match: 'Ver 4.77 05', family: 'rn41', model: 'RN41', version: '4.77' },
  { match: 'RN4678 V1.00.5', family: 'rn4678', model: 'RN4678', version: '1.00.5' },
  { match: 'RN4678 V1.11.00', family: 'rn4678', model: 'RN4678', version: '1.11.0' },
  { match: 'RN4678 V1.13.5', family: 'rn4678', model: 'RN4678', version: '1.13.5' },
  { match: 'RN4678 V1.22', family: 'rn4678', model: 'RN4678', version: '1.22' },
  { match: 'RN4678 V1.23', family: 'rn4678', model: 'RN4678', version: '1.23' },
]);

/** Extra fields the CYW20820 reports alongside its application version. */
export interface Cyw20820VersionDetails {
  /** Stack build, as the firmware prints it: `0x00000000`. */
  stack: string;
  /** EZ-Serial protocol version: `0x0000`. */
  protocol: string;
  /** Module hardware revision: `0x00`. */
  hardware: string;
}

/** A parsed answer to the Bluetooth-module version query. */
export interface BluetoothModuleVersion {
  /** Exactly what the sensor reported, control characters and all. */
  raw: string;
  family: BluetoothModuleFamily;
  /** `'RN4678'` / `'CYW20820'`, or null when the reply is not recognised. */
  model: string | null;
  /** `'1.23'` / `'1.4.18.18'`, or null when the reply is not recognised. */
  version: string | null;
  /**
   * What to show a user. A recognised module gives `'RN4678 v1.23'`; an
   * unrecognised non-empty reply gives the reply itself, trimmed, because it
   * is more informative than "unknown"; an empty reply gives
   * `'not reported'`.
   */
  label: string;
  /** Present only for the CYW20820. */
  details?: Cyw20820VersionDetails;
}

/**
 * The Shimmer3R's reply, built by
 * `BT_generateCyw20820FirmwareVersionStr()` (`CYW20820.c:1893-1903`):
 *
 * ```
 * CYW20820 app=v01.04.18.18, stack=0x00000000, protocol=0x0000, hardware=0x00
 * ```
 *
 * The four application fields are printed `%02d`, so the leading zeroes are
 * formatting rather than meaning and are dropped for display — `v1.4.18.18`,
 * which is how the module's own documentation writes it.
 */
const CYW20820_PATTERN =
  /CYW20820\s+app=v(\d+)\.(\d+)\.(\d+)\.(\d+),\s*stack=(0x[0-9a-f]+),\s*protocol=(0x[0-9a-f]+),\s*hardware=(0x[0-9a-f]+)/i;

/**
 * Parse the reply to `GET_BT_VERSION_STR_COMMAND` (0xA1).
 *
 * The reply is whatever the Bluetooth module said when the firmware asked it,
 * passed through unaltered apart from the RN4678's trailing `CMD>` prompt,
 * which the firmware strips (`Comms/shimmer_bt_uart.c:442-458`). So there is
 * no single grammar: an RN module answers with a Roving Networks / Microchip
 * banner, and a Shimmer3R answers with a line the Shimmer firmware composes
 * itself from the CYW20820's binary version record.
 *
 * Never throws, and the signature says so: `null` and `undefined` are accepted
 * because this parses a payload read off a device, and the SDK is consumed from
 * plain JavaScript as well as TypeScript. A caller should not need a cast to
 * hand it whatever a read actually produced.
 *
 * An unrecognised reply is returned with `family: 'unknown'` and
 * the raw text as its label — the Java equivalent has a bug here that returns
 * an empty name instead (its `NOT_READ` row carries an empty comparison
 * string, which `String.contains` matches against every input, so an
 * unrecognised module is reported as "not read"). What the module actually
 * said is the most useful thing a host can show.
 */
export function parseBluetoothModuleVersion(
  raw: string | Uint8Array | null | undefined,
): BluetoothModuleVersion {
  let text = '';
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw) {
    /* latin1, byte for byte, matching how the rest of this SDK reads ASCII out
     * of firmware payloads. A TextDecoder would substitute U+FFFD for the high
     * bytes a garbled reply can carry, and that substitution would then be
     * shown to a user as the module's name. */
    for (const b of raw) text += String.fromCharCode(b);
  }
  const trimmed = text.replace(/\0+$/, '').trim();

  const cyw = CYW20820_PATTERN.exec(trimmed);
  if (cyw) {
    const version = [cyw[1], cyw[2], cyw[3], cyw[4]].map((n) => String(Number(n))).join('.');
    return {
      raw: text,
      family: 'cyw20820',
      model: 'CYW20820',
      version,
      label: `CYW20820 v${version}`,
      details: {
        stack: cyw[5].toLowerCase(),
        protocol: cyw[6].toLowerCase(),
        hardware: cyw[7].toLowerCase(),
      },
    };
  }

  /* First match wins, and the RN-42 rows are ordered before the RN41 one they
   * would otherwise be shadowed by: "Ver 4.77 RN-42 01/05/10" also contains
   * "Ver 4.77 05" from the RN41 row. The Java loop takes the LAST match
   * instead and gets this right only because of where the rows happen to sit
   * in its enum. */
  for (const entry of BLUETOOTH_MODULE_VERSIONS) {
    if (trimmed.includes(entry.match)) {
      return {
        raw: text,
        family: entry.family,
        model: entry.model,
        version: entry.version,
        label: `${entry.model} v${entry.version}`,
      };
    }
  }

  return {
    raw: text,
    family: 'unknown',
    model: null,
    version: null,
    label: trimmed.length ? trimmed : 'not reported',
  };
}
