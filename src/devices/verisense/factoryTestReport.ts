import { csvCell } from '../../core/csv.js';
import { compareVerisenseFirmwareVersion } from './protocolUtils.js';

/**
 * Parser for the plain-text factory test report streamed by the Verisense
 * firmware (`Includes/ASM_common_source/Test/hal_factoryTest.c`), turning it
 * into a flat map of named metrics suitable for a spreadsheet row.
 *
 * Two properties drive the whole design:
 *
 * 1. **Tests are identified by line content, never by the printed
 *    `WS_TEST_00NN` number.** The IDs were renumbered at firmware v2.00.010
 *    (the LF-crystal test took 0003 and everything from the old 0003 up to
 *    0019 shifted by one), so the same number means different tests across
 *    builds while the descriptive text stayed stable. Printed IDs are still
 *    recorded per test and collected into an observed id-to-name map, which is
 *    what decodes the `Overall Result = FAIL (0x…)` bitmask — so the mask is
 *    read correctly under either numbering.
 *
 * 2. **The report format is unversioned and still changing.** Nothing here
 *    throws: unrecognized test lines become generic entries, unrecognized text
 *    is preserved verbatim in `unparsedLines`, and the caller keeps the raw
 *    report alongside the parse.
 */

/** Verdict carried by a single report line. */
export type VerisenseFactoryTestVerdict =
  'PASS' | 'FAIL' | 'WARNING' | 'NOT_APPLICABLE' | 'INFO' | 'UNKNOWN';

/** A value extracted from the report, as it should land in a spreadsheet cell. */
export type VerisenseFactoryTestMetricValue = number | string | boolean;

/** One test as it appeared in the report. */
export interface VerisenseFactoryTestResult {
  /** The `WS_TEST_00NN` number printed in *this* report, or null if the line
   * carried none. Not stable across firmware versions — see `name`. */
  id: number | null;
  /** Canonical snake_case key derived from the line's content. Stable across
   * firmware versions; this is what column names are built from. */
  name: string;
  /** Human-readable test name, e.g. `'VD6283TX Light sensor'`. */
  label: string;
  verdict: VerisenseFactoryTestVerdict;
  /** The report text for this test, sub-lines joined with `' | '`. */
  detail: string;
  metrics: Record<string, VerisenseFactoryTestMetricValue>;
}

/** MCU header block printed above the first test. */
export interface VerisenseFactoryTestMcuInfo {
  macId: string | null;
  deviceId: string | null;
  part: string | null;
  variant: string | null;
  lastResetHex: string | null;
  lastResetReasons: string | null;
  bootCount: number | null;
}

/** The indented production-config block printed by the Shimmer model test. */
export interface VerisenseFactoryTestModelInfo {
  name: string | null;
  srRevision: string | null;
  manufacturingOrder: string | null;
  macSuffix: string | null;
  advertisingPrefix: string | null;
  passkeyId: string | null;
  passkeyKind: string | null;
}

/** Overall verdict block printed just before the TEST END banner. */
export interface VerisenseFactoryTestOverall {
  /** null when the report never reached its footer (e.g. a blank board aborts
   * the run at the Shimmer model test). */
  result: 'PASS' | 'FAIL' | null;
  failMaskHex: string | null;
  failMask: number | null;
  /** Canonical names of the tests whose bits are set, resolved through the ids
   * actually observed in this report. */
  failedTestNames: string[];
}

/** Everything a single report yields. */
export interface VerisenseFactoryTestReportParsed {
  /** The TEST START banner was found. */
  ok: boolean;
  /** The TEST END banner was found — a report can be valid but truncated. */
  complete: boolean;
  /** Dotted firmware version from the `Firmware version:` line, e.g. `'2.00.024'`. */
  firmwareVersion: string | null;
  /** Which `WS_TEST_00NN` numbering this report uses, derived from the firmware
   * version. Informational: parsing never depends on it. */
  idScheme: 'legacy' | 'v2_00_010' | 'unknown';
  overall: VerisenseFactoryTestOverall;
  mcu: VerisenseFactoryTestMcuInfo;
  model: VerisenseFactoryTestModelInfo | null;
  /** Tests in the order they were printed. */
  tests: VerisenseFactoryTestResult[];
  /** Every metric merged into one flat map — one spreadsheet column per key. */
  metrics: Record<string, VerisenseFactoryTestMetricValue>;
  /** Lines no rule recognized. Never dropped, so nothing is silently lost. */
  unparsedLines: string[];
  /** Anomalies worth surfacing (repaired truncation, stripped progress dots…). */
  parserWarnings: string[];
}

/** The firmware release that renumbered the tests. */
const RENUMBER_VERSION = { major: 2, minor: 0, internal: 10 };

/**
 * Line starts that may appear glued onto the end of a previous line.
 *
 * The firmware assembles each line in a shared 128-byte buffer, and the
 * WS_TEST_0003 WARNING text is longer than that: `snprintf` truncates it and
 * the trailing CRLF is lost, so whatever is written next runs straight on. We
 * re-split on these anchors and note the repair.
 */
const REPAIR_ANCHORS = [
  / - WS_TEST_\d{4} - /g,
  /LED test \(WS_TEST_\d{4}\):/g,
  /(?:MCU|I\/O status|Battery|Shimmer model|TWIM0|TWIM1 \(part ?\d\)|SPIM2|SPIM3):/g,
  /Overall Result\s*=/g,
  /\/\/\*+/g,
];

interface Classifier {
  name: string;
  label: string;
  match: RegExp;
  /** Column holding this test's verdict. Defaults to `<name>_result`. */
  resultKey?: string;
  extract?: (body: string, out: Record<string, VerisenseFactoryTestMetricValue>) => void;
}

/**
 * Matched in order against the text following the `WS_TEST_00NN` prefix; first
 * hit wins. Every pattern keys on wording the firmware has printed stably
 * across the renumbering, not on the test number.
 */
const CLASSIFIERS: Classifier[] = [
  {
    name: 'vcore',
    label: 'VCore',
    match: /VCore/i,
    extract: (body, out) => {
      const m = /VCore\s*=\s*(-?\d+)\s*mV(?:\s*\(\s*(\d+)\s*-\s*(\d+)\s*mV\s*\))?/i.exec(body);
      if (!m) return;
      setNum(out, 'vcore_mv', m[1]);
      setNum(out, 'vcore_limit_low_mv', m[2]);
      setNum(out, 'vcore_limit_high_mv', m[3]);
    },
  },
  {
    name: 'mcu_temp',
    label: 'MCU temperature',
    match: /Temperature\s*=\s*-?\d/i,
    extract: (body, out) => {
      setNum(out, 'mcu_temp_c', /Temperature\s*=\s*(-?\d+)/i.exec(body)?.[1]);
    },
  },
  {
    name: 'lfclk',
    label: 'LF crystal',
    match: /LF crystal/i,
    extract: (body, out) => {
      setNum(out, 'lfclk_ppm', /error\s*=\s*([+-]?\d+(?:\.\d+)?)\s*ppm/i.exec(body)?.[1]);
      setNum(out, 'lfclk_s_per_day', /\(\s*([+-]?\d+(?:\.\d+)?)\s*s\/day\s*\)/i.exec(body)?.[1]);
      setNum(out, 'lfclk_limit_ppm', /limit\s*\+\/-\s*(\d+(?:\.\d+)?)\s*ppm/i.exec(body)?.[1]);
      setStr(out, 'lfclk_src', /LFCLK\s*src\s*=\s*([A-Za-z]+)/i.exec(body)?.[1]);
      setStr(out, 'lfclk_fail_reason', /not measurable\s*\(([^,)]+)/i.exec(body)?.[1]);
    },
  },
  {
    name: 'usb_power',
    label: 'USB power good',
    match: /USB (?:power good|not applicable)/i,
    extract: (body, out) => {
      const m = /USB power good\s*:\s*(Yes|No)/i.exec(body);
      if (m) out.usb_power_good = /yes/i.test(m[1]);
    },
  },
  { name: 'eeprom', label: 'CAT24M01 EEPROM', match: /EEPROM/i },
  {
    name: 'model',
    label: 'Shimmer model',
    match: /production config|^\s*(?:PASS|FAIL)\s*$/i,
  },
  {
    name: 'battery',
    label: 'VBatt',
    match: /VBatt/i,
    resultKey: 'vbatt_result',
    extract: (body, out) => {
      const m = /VBatt\s*=\s*(-?\d+)\s*mV(?:\s*\(\s*(\d+)\s*-\s*(\d+)\s*mV\s*\))?/i.exec(body);
      if (m) {
        setNum(out, 'vbatt_mv', m[1]);
        setNum(out, 'vbatt_limit_low_mv', m[2]);
        setNum(out, 'vbatt_limit_high_mv', m[3]);
      }
      // Percentage is only printed when the unit is not charging.
      setNum(out, 'batt_pct', /,\s*(\d+)\s*%/.exec(body)?.[1]);
    },
  },
  {
    name: 'charger',
    label: 'Charger status',
    match: /Charger/i,
    extract: (body, out) => {
      setStr(out, 'charger_status', /Charger status\s*:\s*(.+?)\s*$/i.exec(body)?.[1]);
    },
  },
  {
    name: 'light',
    label: 'VD6283TX Light sensor',
    match: /VD6283|Light sensor/i,
    extract: (body, out) => {
      setNum(out, 'lux', /([\d.]+)\s*Lux/i.exec(body)?.[1]);
      setNum(out, 'cct_k', /CCT\s*:\s*(\d+)\s*K/i.exec(body)?.[1]);
      const flicker = /Flicker\s*:\s*([\d.]+)\s*Hz\s*,\s*(\d+)\s*%\s*mod/i.exec(body);
      if (flicker) {
        setNum(out, 'flicker_hz', flicker[1]);
        setNum(out, 'flicker_mod_pct', flicker[2]);
        out.flicker_status = 'detected';
      } else if (/Flicker\s*:\s*link OK/i.test(body)) {
        out.flicker_status = 'link_ok_none_detected';
      } else if (/Flicker\s*:\s*FAIL\s*-\s*no signal/i.test(body)) {
        out.flicker_status = 'no_signal';
      } else if (/Flicker\s*:\s*FAIL\s*-\s*no capture/i.test(body)) {
        out.flicker_status = 'no_capture';
      }
    },
  },
  {
    name: 'skin_temp',
    label: 'Thermal sensor',
    // The firmware prints MLX90640; the part actually fitted is an MLX90632.
    match: /MLX906|Thermal sensor/i,
    extract: (body, out) => {
      setNum(out, 'mlx_ambient_c', /Ambient\s*=\s*(-?\d+)/i.exec(body)?.[1]);
      setNum(out, 'mlx_object_c', /Object\s*=\s*(-?\d+)/i.exec(body)?.[1]);
    },
  },
  {
    name: 'algo_hub',
    label: 'MAX32674C Algorithm hub',
    match: /MAX32674|Algorithm hub/i,
    resultKey: 'hub_result',
    extract: (body, out) => {
      setStr(out, 'hub_fw_version', /\(\s*v([\d.]+)\s*\)/i.exec(body)?.[1]);
      if (/Incorrect FW/i.test(body)) out.hub_fail_reason = 'incorrect_fw';
      else if (/bootloader mode/i.test(body)) out.hub_fail_reason = 'bootloader_mode';
      else if (/not responding/i.test(body)) out.hub_fail_reason = 'not_responding';
      else if (/not detected/i.test(body)) out.hub_fail_reason = 'not_detected';
    },
  },
  {
    name: 'ppg_afe',
    label: 'MAX86176 Pulse oximeter',
    match: /MAX86|Pulse oximeter/i,
    extract: (body, out) => chipDetail(body, out, 'ppg_afe'),
  },
  {
    name: 'accel2',
    label: 'LIS2DW12 Accelerometer',
    match: /LIS2DW12/i,
    extract: (body, out) => chipDetail(body, out, 'accel2'),
  },
  {
    name: 'imu',
    label: 'IMU',
    match: /LSM6DS/i,
    extract: (body, out) => chipDetail(body, out, 'imu'),
  },
  {
    name: 'mag',
    label: 'LIS2MDL Magnetometer',
    match: /LIS2MDL/i,
    extract: (body, out) => chipDetail(body, out, 'mag'),
  },
  {
    name: 'nand_health',
    label: 'NAND health test',
    match: /NAND health/i,
  },
  {
    name: 'nand',
    label: 'Main flash test',
    match: /Main flash test|read flash device ID/i,
  },
  { name: 'stf1', label: 'STF1 Flash test', match: /STF1/i },
  { name: 'stf2', label: 'STF2 Flash test', match: /STF2/i },
  { name: 'led', label: 'LED test', match: /LED test/i },
];

/** Shared shape of the IMU-class self-test lines: optional temperature in
 * parentheses plus an optional failure-reason suffix. */
function chipDetail(
  body: string,
  out: Record<string, VerisenseFactoryTestMetricValue>,
  prefix: string,
): void {
  setNum(out, `${prefix}_temp_c`, /\(\s*(-?\d+)\s*°?\s*C\s*\)/i.exec(body)?.[1]);
  const reason =
    /-\s*(Chip not detected|Signal issue|Temperature issue|DRDY\/INT issue|Unknown)/i.exec(
      body,
    )?.[1];
  if (reason) out[`${prefix}_fail_reason`] = reason.trim();
}

function num(value: string | undefined | null): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function setNum(
  out: Record<string, VerisenseFactoryTestMetricValue>,
  key: string,
  value: string | undefined | null,
): void {
  const n = num(value);
  if (n !== undefined) out[key] = n;
}

function setStr(
  out: Record<string, VerisenseFactoryTestMetricValue>,
  key: string,
  value: string | undefined | null,
): void {
  const s = value?.trim();
  if (s) out[key] = s;
}

/**
 * Fold the several ways a degree sign can reach us into a single `°`.
 *
 * The firmware emits a bare `0xB0` on some builds and UTF-8 `0xC2 0xB0` on
 * others; depending on how the transport decoded the bytes we see `°`, the
 * mojibake `Â°`, or the Unicode replacement character.
 */
function normalizeReportText(text: string): string {
  return String(text ?? '')
    .replace(/Â°/g, '°')
    .replace(/�/g, '°');
}

/** Split into lines, dropping the NAND health progress dots and re-splitting
 * lines that the firmware's 128-byte buffer glued together. */
function toLines(text: string, warnings: string[]): string[] {
  const out: string[] = [];
  let stripped = 0;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    // The NAND health test streams bare dots to keep the host's idle timer
    // alive; they arrive with no newline of their own.
    if (/^[.\s]*$/.test(raw) && /\./.test(raw)) {
      stripped += 1;
      continue;
    }
    const line = raw.replace(/\.{3,}\s*$/, '');
    for (const piece of repairLine(line, warnings)) {
      if (piece.trim()) out.push(piece);
    }
  }
  if (stripped) warnings.push(`stripped ${stripped} progress-dot line(s)`);
  return out;
}

/** Re-split one physical line wherever a known line start appears mid-line. */
function repairLine(line: string, warnings: string[]): string[] {
  let earliest = -1;
  for (const anchor of REPAIR_ANCHORS) {
    anchor.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = anchor.exec(line)) !== null) {
      if (m.index > 0 && (earliest < 0 || m.index < earliest)) earliest = m.index;
    }
  }
  if (earliest <= 0) return [line];
  warnings.push(`repaired a line truncated by the firmware buffer near column ${earliest}`);
  const head = line.slice(0, earliest);
  return [head, ...repairLine(line.slice(earliest), warnings)];
}

/** Read the verdict keyword, if any, off the text following the test id. */
function readVerdict(body: string): VerisenseFactoryTestVerdict {
  const m = /^\s*(PASS|FAIL|WARNING)\b/i.exec(body);
  if (m) return m[1].toUpperCase() as VerisenseFactoryTestVerdict;
  if (/not applicable/i.test(body)) return 'NOT_APPLICABLE';
  if (body.trim()) return 'INFO';
  return 'UNKNOWN';
}

/** Derive the numbering scheme from the reported firmware version. */
function readIdScheme(version: string | null): 'legacy' | 'v2_00_010' | 'unknown' {
  if (!version) return 'unknown';
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return 'unknown';
  const triple = {
    major: Number(m[1]),
    minor: Number(m[2]),
    internal: Number(m[3]),
  };
  return compareVerisenseFirmwareVersion(triple, RENUMBER_VERSION) >= 0 ? 'v2_00_010' : 'legacy';
}

function emptyResult(): VerisenseFactoryTestReportParsed {
  return {
    ok: false,
    complete: false,
    firmwareVersion: null,
    idScheme: 'unknown',
    overall: { result: null, failMaskHex: null, failMask: null, failedTestNames: [] },
    mcu: {
      macId: null,
      deviceId: null,
      part: null,
      variant: null,
      lastResetHex: null,
      lastResetReasons: null,
      bootCount: null,
    },
    model: null,
    tests: [],
    metrics: {},
    unparsedLines: [],
    parserWarnings: [],
  };
}

/**
 * Parse a full factory test report into structured metrics.
 *
 * Never throws: malformed or unrecognized input comes back with `ok: false`
 * and/or its lines preserved in `unparsedLines`.
 */
export function parseVerisenseFactoryTestReport(text: string): VerisenseFactoryTestReportParsed {
  const result = emptyResult();
  try {
    parseInto(normalizeReportText(text), result);
  } catch (err) {
    result.parserWarnings.push(`parser error: ${String((err as Error)?.message ?? err)}`);
  }
  return result;
}

function parseInto(text: string, result: VerisenseFactoryTestReportParsed): void {
  const warnings = result.parserWarnings;
  const lines = toLines(text, warnings);
  const metrics = result.metrics;
  /** Canonical name of the test each printed id was seen against, so the fail
   * mask can be decoded under whichever numbering this report used. */
  const nameById = new Map<number, string>();
  let ledSeen = 0;
  /** Held in an object so the assignment inside `pushTest` stays visible to
   * the type checker at every use site. */
  const open: { test: VerisenseFactoryTestResult | null } = { test: null };

  const pushTest = (test: VerisenseFactoryTestResult): void => {
    result.tests.push(test);
    if (test.id != null) nameById.set(test.id, test.name);
    open.test = test;
  };

  const addDetail = (line: string): void => {
    const test = open.test;
    if (!test) return;
    test.detail = test.detail ? `${test.detail} | ${line.trim()}` : line.trim();
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (/TEST START/.test(trimmed)) {
      result.ok = true;
      continue;
    }
    if (/TEST END/.test(trimmed)) {
      result.complete = true;
      continue;
    }

    const fw = /^Firmware version\s*:\s*v?([\d.]+)/i.exec(trimmed);
    if (fw) {
      result.firmwareVersion = fw[1];
      result.idScheme = readIdScheme(fw[1]);
      metrics.fw_version = fw[1];
      continue;
    }

    const range = /Temperature pass range set to\s*(-?\d+)\s*-\s*(-?\d+)/i.exec(trimmed);
    if (range) {
      setNum(metrics, 'temp_range_low_c', range[1]);
      setNum(metrics, 'temp_range_high_c', range[2]);
      continue;
    }

    const overall = /^Overall Result\s*=\s*(PASS|FAIL)(?:\s*\(\s*(0x[0-9A-Fa-f]+)\s*\))?/i.exec(
      trimmed,
    );
    if (overall) {
      result.overall.result = overall[1].toUpperCase() as 'PASS' | 'FAIL';
      metrics.overall_result = result.overall.result;
      if (overall[2]) {
        result.overall.failMaskHex = overall[2].toUpperCase().replace('0X', '0x');
        result.overall.failMask = Number.parseInt(overall[2], 16);
        metrics.fail_mask_hex = result.overall.failMaskHex;
      }
      continue;
    }

    // Section headers (`MCU:`, `SPIM3:` …) carry no data but end the previous
    // test's sub-line run.
    if (
      /^(?:MCU|I\/O status|Battery|Shimmer model|TWIM0|TWIM1 \(part ?\d\)|SPIM2|SPIM3)\s*:$/i.test(
        trimmed,
      )
    ) {
      open.test = null;
      continue;
    }

    if (readMcuHeaderLine(trimmed, result, metrics)) continue;

    // `LED test (WS_TEST_0019):` — the first such block is the operational
    // status LED, the second the battery LED. Ordering survives renumbering.
    const ledHeader = /^LED test\s*\(\s*WS_TEST_(\d{4})\s*\)\s*:/i.exec(trimmed);
    if (ledHeader) {
      const name = ledSeen === 0 ? 'led_status' : 'led_batt';
      ledSeen += 1;
      pushTest({
        id: Number(ledHeader[1]),
        name,
        label:
          name === 'led_status' ? 'LED test - operational status' : 'LED test - battery status',
        verdict: 'INFO',
        detail: '',
        metrics: {},
      });
      // Deliberately no `<name>_result` metric: an INFO verdict carries no
      // data (the LED test is operator-visual narration), and which suite ran
      // is already recorded by the caller's factory-test-type column. The
      // verdict is still on the tests[] entry for anyone who wants it.
      continue;
    }

    const idLine = /^-?\s*WS_TEST_(\d{4})\s*-\s*(.*)$/i.exec(trimmed.replace(/^-\s*/, '- '));
    if (idLine) {
      const id = Number(idLine[1]);
      const body = idLine[2] ?? '';
      const verdict = readVerdict(body);
      const classifier = CLASSIFIERS.find((c) => c.match.test(body));

      let name = classifier?.name ?? `ws_test_${idLine[1]}`;
      let label = classifier?.label ?? `WS_TEST_${idLine[1]}`;
      if (name === 'led') {
        // Not-applicable LED lines come through the id path rather than as a
        // `LED test (…):` header.
        name = ledSeen === 0 ? 'led_status' : 'led_batt';
        label =
          name === 'led_status' ? 'LED test - operational status' : 'LED test - battery status';
        ledSeen += 1;
      }

      const testMetrics: Record<string, VerisenseFactoryTestMetricValue> = {};
      classifier?.extract?.(body, testMetrics);
      if (!classifier) scrapeGenericMetrics(body, name, testMetrics);

      // A verdict column is only worth a spreadsheet cell when it can vary:
      // PASS/FAIL/WARNING record an outcome and NOT_APPLICABLE records a
      // model gate, but INFO just means "an informational line printed" — its
      // substance is already in that line's own metrics (usb_power_good,
      // charger_status, ...), so emitting it would waste a column per test.
      if (verdict !== 'INFO') {
        const resultKey = classifier?.resultKey ?? `${name}_result`;
        testMetrics[resultKey] = verdict;
      }

      pushTest({ id, name, label, verdict, detail: body.trim(), metrics: testMetrics });
      Object.assign(metrics, testMetrics);
      continue;
    }

    if (readSubLine(trimmed, result, metrics, open.test, addDetail)) continue;

    // LED narration (`- All LEDs off`, `- Left Red LED on`) belongs to the LED
    // test currently open.
    if (open.test && /^-\s*(All|Left|Right)\b.*LED/i.test(trimmed)) {
      addDetail(trimmed.replace(/^-\s*/, ''));
      continue;
    }

    result.unparsedLines.push(line);
  }

  // Decode the fail mask through the ids this report actually used.
  if (result.overall.failMask != null) {
    const names: string[] = [];
    for (let bit = 0; bit < 32; bit += 1) {
      if (!(result.overall.failMask & (1 << bit))) continue;
      const id = bit + 1;
      names.push(nameById.get(id) ?? `ws_test_${String(id).padStart(4, '0')}`);
    }
    result.overall.failedTestNames = names;
  }
}

/** MCU identification lines printed above the first test. */
function readMcuHeaderLine(
  trimmed: string,
  result: VerisenseFactoryTestReportParsed,
  metrics: Record<string, VerisenseFactoryTestMetricValue>,
): boolean {
  const mac = /^-?\s*MAC ID\s*:\s*([0-9A-Fa-f]+)/.exec(trimmed);
  if (mac) {
    result.mcu.macId = mac[1].toUpperCase();
    // Named ble_mac, not mac_id: this is the full 12-hex BLE MAC from the
    // report, distinct from the production config's 4-hex "MAC ID" suffix that
    // callers pass as a mac_id meta column. Sharing the name collided the two.
    metrics.ble_mac = result.mcu.macId;
    return true;
  }
  const dev = /^Device ID\s*:\s*(\S+)/i.exec(trimmed);
  if (dev) {
    result.mcu.deviceId = dev[1];
    metrics.device_id = dev[1];
    return true;
  }
  const part = /^Part\s*:\s*(\S+?)\s*,\s*Variant\s*:\s*(\S+)/i.exec(trimmed);
  if (part) {
    result.mcu.part = part[1];
    result.mcu.variant = part[2];
    metrics.mcu_part = part[1];
    metrics.mcu_variant = part[2];
    return true;
  }
  const reset = /^Last reset\s*:\s*(0x[0-9A-Fa-f]+)\s*(.*?)\s*,\s*boot count\s*=\s*(\d+)/i.exec(
    trimmed,
  );
  if (reset) {
    result.mcu.lastResetHex = reset[1];
    result.mcu.lastResetReasons = reset[2].replace(/^\(|\)$/g, '').trim() || null;
    result.mcu.bootCount = Number(reset[3]);
    metrics.last_reset_hex = reset[1];
    if (result.mcu.lastResetReasons) metrics.last_reset_reasons = result.mcu.lastResetReasons;
    setNum(metrics, 'boot_count', reset[3]);
    return true;
  }
  return false;
}

/**
 * Indented continuation lines. These are dispatched on their own wording
 * rather than on which test is open, so a missing parent line never
 * misattributes them.
 */
function readSubLine(
  trimmed: string,
  result: VerisenseFactoryTestReportParsed,
  metrics: Record<string, VerisenseFactoryTestMetricValue>,
  current: VerisenseFactoryTestResult | null,
  addDetail: (line: string) => void,
): boolean {
  const put = (key: string, value: VerisenseFactoryTestMetricValue): void => {
    metrics[key] = value;
    if (current) current.metrics[key] = value;
  };

  // --- Shimmer model block ---
  const name = /^Name\s*:\s*(.+?)(?:\s*\(\s*(SR[\d-]+)\s*\))?\s*$/i.exec(trimmed);
  if (name) {
    result.model ??= emptyModel();
    result.model.name = name[1].trim();
    put('model_name', result.model.name);
    if (name[2]) {
      result.model.srRevision = name[2];
      put('model_sr_revision', name[2]);
    }
    addDetail(trimmed);
    return true;
  }
  const mo = /^Manufacturing Order\s*\|\s*MAC\s*:\s*([0-9A-Fa-f]+)\s*\|\s*([0-9A-Fa-f]+)/i.exec(
    trimmed,
  );
  if (mo) {
    result.model ??= emptyModel();
    result.model.manufacturingOrder = mo[1].toUpperCase();
    result.model.macSuffix = mo[2].toUpperCase();
    put('model_mo', result.model.manufacturingOrder);
    put('model_mac_suffix', result.model.macSuffix);
    addDetail(trimmed);
    return true;
  }
  const advPrefix = /^Advertising Prefix\s*:\s*(.+?)\s*$/i.exec(trimmed);
  if (advPrefix) {
    result.model ??= emptyModel();
    result.model.advertisingPrefix = advPrefix[1];
    put('adv_prefix', advPrefix[1]);
    addDetail(trimmed);
    return true;
  }
  const passkeyId = /^Passkey ID\s*:\s*(\S+)\s*(?:\(([^)]*)\))?/i.exec(trimmed);
  if (passkeyId) {
    result.model ??= emptyModel();
    result.model.passkeyId = passkeyId[1];
    put('passkey_id', passkeyId[1]);
    if (passkeyId[2]) {
      result.model.passkeyKind = passkeyId[2].trim();
      put('passkey_kind', result.model.passkeyKind);
    }
    addDetail(trimmed);
    return true;
  }
  // The passkey value itself is a device secret — record only that one is set.
  if (/^Passkey\s*:/i.test(trimmed)) {
    addDetail('Passkey: (not recorded)');
    return true;
  }

  // --- Main flash geometry ---
  const manufacturer = /^Manufacturer\s*=\s*(.+?)\s*$/i.exec(trimmed);
  if (manufacturer) {
    put('nand_manufacturer', manufacturer[1]);
    addDetail(trimmed);
    return true;
  }
  const model = /^Model\s*=\s*(.+?)\s*$/i.exec(trimmed);
  if (model) {
    put('nand_model', model[1]);
    addDetail(trimmed);
    return true;
  }
  const size = /^Size\s*=\s*(\d+)\s*MB/i.exec(trimmed);
  if (size) {
    put('nand_size_mb', Number(size[1]));
    addDetail(trimmed);
    return true;
  }

  // --- NAND health ---
  const census = /^Bad-block census\s*=\s*(\d+)\s*of\s*(\d+)\s*\(\s*limit\s*(\d+)\s*\)/i.exec(
    trimmed,
  );
  if (census) {
    put('nand_bad_blocks', Number(census[1]));
    put('nand_bad_block_total', Number(census[2]));
    put('nand_bad_block_limit', Number(census[3]));
    addDetail(trimmed);
    return true;
  }
  const stress =
    /^Stress\s*=\s*(\d+)\s*blocks\s*\/\s*(\d+)\s*page checks(?:\s*\(\s*(\d+)\s*sampled blocks skipped bad\s*\))?/i.exec(
      trimmed,
    );
  if (stress) {
    put('nand_stress_blocks', Number(stress[1]));
    put('nand_page_checks', Number(stress[2]));
    if (stress[3] != null) put('nand_blocks_skipped', Number(stress[3]));
    addDetail(trimmed);
    return true;
  }
  const pages =
    /^Corrupt pages\s*=\s*(\d+)\s*,\s*unstable pages\s*=\s*(\d+)\s*,\s*erase\/write fails\s*=\s*(\d+)\s*\/\s*(\d+)/i.exec(
      trimmed,
    );
  if (pages) {
    put('nand_corrupt_pages', Number(pages[1]));
    put('nand_unstable_pages', Number(pages[2]));
    put('nand_erase_write_fails', `${pages[3]}/${pages[4]}`);
    addDetail(trimmed);
    return true;
  }
  // Progress line for the health test; the verdict follows separately.
  if (/^NAND health\s*:/i.test(trimmed)) return true;

  return false;
}

function emptyModel(): VerisenseFactoryTestModelInfo {
  return {
    name: null,
    srRevision: null,
    manufacturingOrder: null,
    macSuffix: null,
    advertisingPrefix: null,
    passkeyId: null,
    passkeyKind: null,
  };
}

/**
 * Fallback for a test this build of the SDK has never seen: keep any
 * `Key = value` pairs so a firmware change still lands data in the sheet.
 */
function scrapeGenericMetrics(
  body: string,
  name: string,
  out: Record<string, VerisenseFactoryTestMetricValue>,
): void {
  const re = /([A-Za-z][A-Za-z0-9 _-]{0,40}?)\s*=\s*([-+]?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const key = `${name}_${m[1]
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')}`;
    setNum(out, key, m[2]);
  }
}

/**
 * Render a parsed report as two CSV rows (header, values): the caller's `meta`
 * columns first, then the parsed metrics sorted by name. A metric whose name
 * collides with a meta column is dropped in favour of the meta value — the
 * caller's identity columns are authoritative, and a duplicated header name
 * breaks most CSV consumers.
 */
export function verisenseFactoryTestReportToCsvRows(
  parsed: VerisenseFactoryTestReportParsed,
  meta: Record<string, string | number | boolean | null> = {},
): string[] {
  const metaKeys = Object.keys(meta);
  const metaKeySet = new Set(metaKeys);
  const metricKeys = Object.keys(parsed?.metrics ?? {})
    .filter((k) => !metaKeySet.has(k))
    .sort();
  const header = [...metaKeys, ...metricKeys].map(csvCell).join(',');
  const values = [...metaKeys.map((k) => meta[k]), ...metricKeys.map((k) => parsed.metrics[k])]
    .map(csvCell)
    .join(',');
  return [header, values];
}
