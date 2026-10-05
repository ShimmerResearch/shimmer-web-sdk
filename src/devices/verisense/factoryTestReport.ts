import {
  chipDetail,
  emptyFactoryTestOverall,
  factoryTestReportToCsvRows,
  parseFactoryTestReport,
  setNum,
  setStr,
  type FactoryTestClassifier,
  type FactoryTestGrammar,
  type FactoryTestLineContext,
  type FactoryTestMetricValue,
  type FactoryTestOverall,
  type FactoryTestReportParsedBase,
  type FactoryTestResult,
  type FactoryTestVerdict,
} from '../factoryTest/report.js';
import { compareVerisenseFirmwareVersion } from './protocolUtils.js';

/**
 * Verisense grammar for the shared factory-test report parser.
 *
 * The report is printed by `Includes/ASM_common_source/Test/hal_factoryTest.c`.
 * Everything generic about it — the banners, the verdict tiers, the truncation
 * repair, the `Overall Result` bitmask decode and the CSV writer — now lives in
 * `../factoryTest/report.ts`, shared with the Shimmer3/3R families. What is
 * left here is what only Verisense prints: the `WS_TEST_` numbering, the
 * twenty content rules, the MCU header block and the indented production-config
 * and NAND blocks.
 *
 * Two properties drive the design, and both are Verisense's:
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
export type VerisenseFactoryTestVerdict = FactoryTestVerdict;

/** A value extracted from the report, as it should land in a spreadsheet cell. */
export type VerisenseFactoryTestMetricValue = FactoryTestMetricValue;

/** One test as it appeared in the report. */
export type VerisenseFactoryTestResult = FactoryTestResult;

/** Overall verdict block printed just before the TEST END banner. */
export type VerisenseFactoryTestOverall = FactoryTestOverall;

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

/** Everything a single report yields. */
export interface VerisenseFactoryTestReportParsed extends FactoryTestReportParsedBase {
  /** Which `WS_TEST_00NN` numbering this report uses, derived from the firmware
   * version. Informational: parsing never depends on it. */
  idScheme: 'legacy' | 'v2_00_010' | 'unknown';
  mcu: VerisenseFactoryTestMcuInfo;
  model: VerisenseFactoryTestModelInfo | null;
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

/**
 * Matched in order against the text following the `WS_TEST_00NN` prefix; first
 * hit wins. Every pattern keys on wording the firmware has printed stably
 * across the renumbering, not on the test number.
 */
const CLASSIFIERS: FactoryTestClassifier[] = [
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

/** MCU identification lines printed above the first test. */
function readMcuHeaderLine(
  trimmed: string,
  ctx: FactoryTestLineContext<VerisenseFactoryTestReportParsed>,
): boolean {
  const { result, metrics } = ctx;
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
 * Indented continuation lines, dispatched on their own wording rather than on
 * which test is open. A value always lands in the GLOBAL metrics map under its
 * own name, so the flat map is correct even when the parent line went missing;
 * it is additionally attached to the currently open test's entry when one
 * exists, so a stray sub-line after an unrelated test would show up on that
 * test's `metrics`/`detail` (the tests[] attachment is best-effort context,
 * not the source of truth).
 */
function readSubLine(
  trimmed: string,
  ctx: FactoryTestLineContext<VerisenseFactoryTestReportParsed>,
): boolean {
  const { result, metrics, current, addDetail } = ctx;
  const put = (key: string, value: FactoryTestMetricValue): void => {
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

/**
 * The Verisense grammar.
 *
 * Every flag the shared core offers is left off: this grammar is the behaviour
 * the shared core was extracted from, so a report parsed through it comes out
 * byte-for-byte as the standalone Verisense parser produced it (pinned by
 * `tests/verisense/factory-test-report-snapshot.test.ts`).
 */
export const VERISENSE_FACTORY_TEST_GRAMMAR: FactoryTestGrammar<VerisenseFactoryTestReportParsed> =
  {
    idToken: 'WS_TEST',
    classifiers: CLASSIFIERS,
    sectionHeadings:
      /^(?:MCU|I\/O status|Battery|Shimmer model|TWIM0|TWIM1 \(part ?\d\)|SPIM2|SPIM3)\s*:$/i,
    repairAnchors: REPAIR_ANCHORS,
    ledHeading: /^LED test\s*\(\s*WS_TEST_(\d{4})\s*\)\s*:/i,
    ledClassifierName: 'led',
    // The first LED block is the operational status LED, the second the battery
    // LED. Ordering survives the renumbering; the printed id does not.
    ledTest: (index) =>
      index === 0
        ? { name: 'led_status', label: 'LED test - operational status' }
        : { name: 'led_batt', label: 'LED test - battery status' },
    ledNarration: /^-\s*(All|Left|Right)\b.*LED/i,
    headerLine: readMcuHeaderLine,
    subLine: readSubLine,
  };

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
    overall: emptyFactoryTestOverall(),
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
 * Parse a full Verisense factory test report into structured metrics.
 *
 * Never throws: malformed or unrecognized input comes back with `ok: false`
 * and/or its lines preserved in `unparsedLines`.
 */
export function parseVerisenseFactoryTestReport(text: string): VerisenseFactoryTestReportParsed {
  const result = parseFactoryTestReport(text, VERISENSE_FACTORY_TEST_GRAMMAR, emptyResult);
  result.idScheme = readIdScheme(result.firmwareVersion);
  return result;
}

/**
 * Render a parsed report as two CSV rows (header, values): the caller's `meta`
 * columns first, then the parsed metrics sorted by name. A metric whose name
 * collides with a meta column is dropped in favour of the meta value — the
 * caller's identity columns are authoritative, and a duplicated header name
 * breaks most CSV consumers.
 */
export const verisenseFactoryTestReportToCsvRows = factoryTestReportToCsvRows;
