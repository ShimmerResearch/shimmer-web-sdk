import {
  chipDetail,
  detectFactoryTestReportFamily,
  emptyFactoryTestOverall,
  factoryTestReportToCsvRows,
  parseFactoryTestReport,
  setNum,
  setStr,
  type FactoryTestClassifier,
  type FactoryTestGrammar,
  type FactoryTestLineContext,
  type FactoryTestMetricValue,
  type FactoryTestReportParsedBase,
} from './report.js';

/**
 * Shimmer3 and Shimmer3R grammar for the shared factory-test report parser.
 *
 * The report envelope is printed by the shared LogAndStream code
 * (`log-and-stream-common/Test/shimmer_test.c:22-61`) and is byte-identical to
 * the Verisense one; the body comes from each board's own file:
 *
 * - Shimmer3R: `Shimmer_Driver/hal_FactoryTest.c`, which numbers every test
 *   `S3R_TEST_00NN` and sets bit n-1 of the `Overall Result = FAIL (0x…)` mask
 *   (`Shimmer_Driver/hal_FactoryTest.h:96-124`). The numbers are sparse — 0003,
 *   0007-0026 and 0028 — and 0027 appears only in the LED heading, never in the
 *   mask, because the LED walk is an operator-visual check with no verdict.
 * - Shimmer3 (MSP430): `Shimmer_Driver/5xx_HAL/hal_FactoryTest.c:65-420`, which
 *   prints no numbers at all and never sets the mask, so its report always ends
 *   `Overall Result = PASS` and its tests are identified purely by content.
 * - The operational-LED-state walk, `log-and-stream-common/Test/
 *   shimmer_test_leds_states.c`, is shared by both boards and prints neither
 *   numbers nor an overall verdict.
 *
 * Because the numbering is the volatile part, content rules resolve a test
 * first and the id table only answers for the lines that carry a bare verdict
 * and no describing words (the microphone prints ` - S3R_TEST_0026 - PASS`).
 *
 * Nothing here throws: empty, truncated and unrecognized input all come back as
 * a result with `ok: false` and the lines preserved.
 *
 * HARDWARE-VERIFY: every line shape below is transcribed from firmware source,
 * not from a report captured off a bench unit. The Shimmer3R BT module version
 * string and the SD card CID line in particular are reconstructed from their
 * `sprintf` formats.
 */

/** Which of the two Shimmer boards printed a report. */
export type ShimmerFactoryTestReportFamily = 'shimmer3r' | 'shimmer3' | 'unknown';

/** The `- I/O status:` block, printed by both boards. */
export interface ShimmerFactoryTestIoStatus {
  docked: boolean | null;
  btConnected: boolean | null;
  buttonPressed: boolean | null;
  usbConnected: boolean | null;
}

/** MCU identification block printed under the `MCU:` heading. */
export interface ShimmerFactoryTestMcuInfo {
  /** The Bluetooth module's MAC, printed under `BT Module:`. */
  macId: string | null;
  deviceId: string | null;
  revisionId: string | null;
  uniqueId: string | null;
  /** Shimmer3 only; the MSP430 decodes its reset cause to words. */
  lastResetReason: string | null;
  /** Shimmer3R only: the LSE drive level the boot bring-up settled on. */
  lseDrive: string | null;
  io: ShimmerFactoryTestIoStatus;
}

/** The daughter-card identity printed by the Shimmer model test. */
export interface ShimmerFactoryTestModelInfo {
  name: string | null;
  srRevision: string | null;
}

/** Everything a single Shimmer3/3R report yields. */
export interface ShimmerFactoryTestReportParsed extends FactoryTestReportParsedBase {
  family: ShimmerFactoryTestReportFamily;
  /** `Date (yyyy-mm-dd):` from the report header, Shimmer3R only. */
  reportDate: string | null;
  /** `Time (hh:mm:ss):` from the report header, always UTC, Shimmer3R only. */
  reportTimeUtc: string | null;
  mcu: ShimmerFactoryTestMcuInfo;
  model: ShimmerFactoryTestModelInfo | null;
}

/**
 * Shimmer3R test numbers, from the bitmask enum in
 * `Shimmer_Driver/hal_FactoryTest.h:96-124`. Bit n-1 of the `Overall Result`
 * mask is test n.
 *
 * 0027 is deliberately absent: the shipped reports already print
 * `LED test (S3R_TEST_0027)`, so the number is spoken for, but the LED walk has
 * no pass/fail bit and can never appear in the mask.
 */
export const SHIMMER3R_FACTORY_TEST_ID_NAMES: Readonly<Record<number, string>> = Object.freeze({
  3: 'model',
  7: 'vref',
  8: 'vcore',
  9: 'vbatt_pin',
  10: 'mcu_temp',
  11: 'batt_voltage',
  12: 'charger',
  13: 'sd',
  14: 'bt',
  15: 'ads7028',
  16: 'lsm6dsv',
  17: 'bmp390',
  18: 'adxl371',
  19: 'lis3mdl',
  20: 'lis2dw12',
  21: 'ads1292r',
  22: 'lis2mdl',
  23: 'eeprom_i2c1',
  24: 'eeprom_i2c4_gsr_rig',
  25: 'gsr_signal',
  26: 'microphone',
  28: 'lse_crystal',
});

/** `<something> = 3742mV (3000-4200mV)` — the shape of every rail measurement. */
function millivoltRange(
  prefix: string,
): (body: string, out: Record<string, FactoryTestMetricValue>) => void {
  return (body, out) => {
    const m = /=\s*(-?\d+)\s*mV(?:\s*\(\s*(-?\d+)\s*-\s*(-?\d+)\s*mV\s*\))?/i.exec(body);
    if (!m) return;
    setNum(out, `${prefix}_mv`, m[1]);
    setNum(out, `${prefix}_limit_low_mv`, m[2]);
    setNum(out, `${prefix}_limit_high_mv`, m[3]);
  };
}

/** A chip self-test line: `<chip><reason suffix> (24.37 degC)`. */
function chipTest(name: string, label: string, match: RegExp): FactoryTestClassifier {
  return { name, label, match, extract: (body, out) => chipDetail(body, out, name) };
}

/**
 * Matched in order against the text following the test number (or, on
 * Shimmer3, following the bare `- `); first hit wins. Every pattern keys on
 * wording rather than on a number, so one list serves both boards and survives
 * a renumbering.
 */
export const SHIMMER_FACTORY_TEST_CLASSIFIERS: FactoryTestClassifier[] = [
  {
    name: 'lse_crystal',
    label: 'LSE crystal (32.768 kHz)',
    match: /\bLSE\b/i,
    extract: (body, out) => {
      setNum(out, 'lse_ppm', /error\s*=\s*([+-]?\d+(?:\.\d+)?)\s*ppm/i.exec(body)?.[1]);
      setNum(out, 'lse_limit_ppm', /limit\s*\+\/-\s*(\d+(?:\.\d+)?)\s*ppm/i.exec(body)?.[1]);
      setStr(out, 'lse_caps', /,\s*(HSE-fixed|pre-fix)\s*caps/i.exec(body)?.[1]);
      setStr(out, 'lse_fail_reason', /not measurable\s*\(([^,)]+)/i.exec(body)?.[1]);
    },
  },
  { name: 'vref', label: 'MCU VRef', match: /VRef/i, extract: millivoltRange('vref') },
  { name: 'vcore', label: 'MCU VCore', match: /VCore/i, extract: millivoltRange('vcore') },
  {
    name: 'vbatt_pin',
    label: 'MCU VBatt pin',
    match: /VBatt pin/i,
    extract: millivoltRange('vbatt_pin'),
  },
  {
    name: 'batt_voltage',
    label: 'Battery voltage',
    match: /VBatt\s*=/i,
    resultKey: 'vbatt_result',
    extract: millivoltRange('vbatt'),
  },
  {
    name: 'mcu_temp',
    label: 'MCU temperature',
    match: /Temperature\s*=\s*-?\d/i,
    extract: (body, out) => {
      setNum(out, 'mcu_temp_c', /Temperature\s*=\s*(-?\d+(?:\.\d+)?)/i.exec(body)?.[1]);
    },
  },
  {
    name: 'charger',
    label: 'Battery charger chip',
    match: /Charger chip status/i,
    extract: (body, out) => {
      setStr(
        out,
        'charger_chip_status',
        /Charger chip status\s*=\s*'?(.+?)'?\s*$/i.exec(body)?.[1],
      );
    },
  },
  // `FAIL: not detected` carries no words of its own; the id table names it.
  { name: 'sd', label: 'SD card', match: /SD [Cc]ard|read\/write test/i },
  {
    name: 'bt',
    label: 'BT module',
    // Shimmer3R reports a missing module as `FAIL - BT hasn't initialised`,
    // with a dash where every other line has a colon.
    match: /BT firmware version|BT hasn't initialised/i,
  },
  chipTest('ads7028', 'ADS7028 ADC', /ADS7028/i),
  chipTest('lsm6dsv', 'LSM6DSV IMU', /LSM6DSV/i),
  chipTest('bmp390', 'BMP390/BMP581 pressure sensor', /BMP390|BMP581/i),
  chipTest('adxl371', 'ADXL371 high-g accelerometer', /ADXL371/i),
  chipTest('lis3mdl', 'LIS3MDL magnetometer', /LIS3MDL/i),
  chipTest('lis2dw12', 'LIS2DW12 accelerometer', /LIS2DW12/i),
  { name: 'ads1292r', label: 'ADS1292R ExG', match: /ADS1292R/i },
  chipTest('lis2mdl', 'LIS2MDL magnetometer', /LIS2MDL/i),
  // Shimmer3 has no self-test for these three; it only reports what answered
  // on the bus, so the lines are informational unless the chip is missing.
  { name: 'lsm303', label: 'LSM303 accelerometer/magnetometer', match: /LSM303/i },
  { name: 'mpu9x50', label: 'MPU9x50 / ICM20948 gyroscope', match: /MPU9x50|ICM20948|Gyro chip/i },
  { name: 'bmpx80', label: 'BMPx80 pressure sensor', match: /BMP180|BMP280|BMPx80/i },
  { name: 'eeprom_i2c1', label: 'CAT24C16 EEPROM', match: /CAT24C16/i },
  { name: 'eeprom_i2c4_gsr_rig', label: 'I2C4 EEPROM / GSR test rig', match: /I2C4/i },
  { name: 'gsr_signal', label: 'GSR signal test', match: /GSR/i },
  { name: 'microphone', label: 'Microphone', match: /Microphone/i },
  {
    name: 'model',
    label: 'Shimmer model',
    match: /\(\s*SR\d+-\d+-\d+\s*\)|:\s*not set\s*$/i,
    extract: (body, out) => {
      // Only a PASS names a board: the failure prints `FAIL: not set`, which
      // is the absence of a name rather than a name.
      setStr(out, 'model_name', /^PASS\s*:\s*(.+?)(?:\s*\(\s*SR[\d-]+\s*\))?\s*$/i.exec(body)?.[1]);
      setStr(out, 'model_sr_revision', /\(\s*(SR\d+-\d+-\d+)\s*\)/i.exec(body)?.[1]);
    },
  },
  { name: 'led', label: 'LED test', match: /LED test|LEDs?\b/i },
];

/** Headings that carry no data but close the open test's continuation run. */
const SECTION_HEADINGS =
  /^-?\s*(?:Shimmer model|MCU|Battery|SD Card|BT Module|Microphone|I2C1|I2C4|I2C|SPI1|SPI2|SPI3|SPI|I\/O status|Counts|BT Disabled|BT Enabled|SD Sync Enabled|Other)\s*:$/i;

/**
 * Line starts that may appear glued onto the end of a previous line.
 *
 * `ShimFactoryTest_sendReport` truncates anything longer than
 * `MAX_TEST_REPORT_LENGTH` (128 bytes including the CRLF), so a long line loses
 * its terminator and the next write runs straight on. We re-split on these
 * anchors and note the repair. The Shimmer3R "LSE not measurable" line is the
 * one that overruns in practice.
 */
const REPAIR_ANCHORS = [
  / - S3R_TEST_\d{4} - /g,
  /LED test(?:\s*\(S3R_TEST_\d{4}\))?:/g,
  /(?:Shimmer model|MCU|Battery|SD Card|BT Module|Microphone|I2C1|I2C4|I2C|SPI1|SPI2|SPI3|SPI):/g,
  // What follows the one Shimmer3R line long enough to lose its terminator.
  / - LSE drive applied at boot:/g,
  /Date \(yyyy-mm-dd\):/g,
  /Time \(hh:mm:ss\):/g,
  /INFO: Temperature pass range/g,
  /Testing Operational LED states/g,
  /Overall Result\s*=/g,
  /\/\/\*+/g,
];

function yesNo(value: string): boolean {
  return /^yes$/i.test(value.trim());
}

/** Report header and MCU/BT identification lines. */
function readShimmerHeaderLine(
  trimmed: string,
  ctx: FactoryTestLineContext<ShimmerFactoryTestReportParsed>,
): boolean {
  const { result, metrics } = ctx;

  const date = /^Date\s*\(yyyy-mm-dd\)\s*:\s*(\d{4}-\d{2}-\d{2})/i.exec(trimmed);
  if (date) {
    result.reportDate = date[1];
    metrics.report_date = date[1];
    return true;
  }
  const time = /^Time\s*\(hh:mm:ss\)\s*:\s*(\d{1,2}:\d{2}:\d{2})/i.exec(trimmed);
  if (time) {
    result.reportTimeUtc = time[1];
    metrics.report_time_utc = time[1];
    return true;
  }
  const mac = /^-?\s*MAC ID\s*:\s*([0-9A-Fa-f]{12})\s*$/.exec(trimmed);
  if (mac) {
    result.mcu.macId = mac[1].toUpperCase();
    metrics.bt_mac = result.mcu.macId;
    return true;
  }
  const dev = /^-?\s*Device ID\s*=\s*(\S+)/i.exec(trimmed);
  if (dev) {
    result.mcu.deviceId = dev[1];
    metrics.mcu_device_id = dev[1];
    return true;
  }
  const rev = /^-?\s*Revision ID\s*=\s*(\S+)/i.exec(trimmed);
  if (rev) {
    result.mcu.revisionId = rev[1];
    metrics.mcu_revision_id = rev[1];
    return true;
  }
  const uid = /^-?\s*Unique ID\s*=\s*(\S+)/i.exec(trimmed);
  if (uid) {
    result.mcu.uniqueId = uid[1];
    metrics.mcu_unique_id = uid[1];
    return true;
  }
  const reset = /^-?\s*Last reset reason\s*=\s*(.+?)\s*$/i.exec(trimmed);
  if (reset) {
    result.mcu.lastResetReason = reset[1];
    metrics.last_reset_reason = reset[1];
    return true;
  }
  const lse = /^-?\s*LSE drive applied at boot\s*:\s*(\S+)/i.exec(trimmed);
  if (lse) {
    result.mcu.lseDrive = lse[1];
    metrics.lse_drive = lse[1];
    return true;
  }
  const charging = /^-?\s*Determined charging status\s*=\s*(.+?)\s*$/i.exec(trimmed);
  if (charging) {
    metrics.charging_status = charging[1];
    return true;
  }
  return false;
}

/** Indented continuation lines belonging to the test or section above them. */
function readShimmerSubLine(
  trimmed: string,
  ctx: FactoryTestLineContext<ShimmerFactoryTestReportParsed>,
): boolean {
  const { result, metrics, current, addDetail } = ctx;
  const put = (key: string, value: FactoryTestMetricValue): void => {
    metrics[key] = value;
    if (current) current.metrics[key] = value;
  };

  const io = /^-?\s*(Docked|BT connected|Button pressed|USB connected)\s*:\s*(Yes|No)\s*$/i.exec(
    trimmed,
  );
  if (io) {
    const on = yesNo(io[2]);
    switch (io[1].toLowerCase()) {
      case 'docked':
        result.mcu.io.docked = on;
        metrics.io_docked = on;
        break;
      case 'bt connected':
        result.mcu.io.btConnected = on;
        metrics.io_bt_connected = on;
        break;
      case 'button pressed':
        result.mcu.io.buttonPressed = on;
        metrics.io_button_pressed = on;
        break;
      default:
        result.mcu.io.usbConnected = on;
        metrics.io_usb_connected = on;
        break;
    }
    return true;
  }

  // Shimmer3 keeps lifetime Bluetooth fault counters in EEPROM and prints them
  // under `- Counts:`.
  const count =
    /^-?\s*BT (data-rate test blockages|disconnects while streaming|RTS Lockups|unsolicited reboots)\s*=\s*(\d+)/i.exec(
      trimmed,
    );
  if (count) {
    const key = `bt_${count[1].toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    put(key, Number(count[2]));
    addDetail(trimmed);
    return true;
  }

  // The SD card's CID, printed as one line above the read/write verdict.
  const card = /^-?\s*Manufacturer\s*:\s*(.+?)\s*,\s*Manufacture Date\s*=\s*(\S+)\s*$/i.exec(
    trimmed,
  );
  if (card) {
    put('sd_manufacturer', card[1]);
    put('sd_manufacture_date', card[2]);
    addDetail(trimmed);
    return true;
  }

  // The Bluetooth module's own version banner, printed verbatim.
  const btVersion = /^-\s*(RN\d{2,4}\b.*)$/i.exec(trimmed);
  if (btVersion) {
    put('bt_module_version', btVersion[1].trim());
    addDetail(trimmed);
    return true;
  }

  return false;
}

/**
 * The operational-LED-state walk. It has no verdicts at all — the firmware
 * drives the sensor through each state for five seconds so an operator can
 * watch the LEDs — so it collapses to a single informational test carrying the
 * states it walked. The state lines are tab-indented under headings that close
 * the open test, so they are reattached by name rather than by what is open.
 */
function readShimmerExtraLine(
  trimmed: string,
  ctx: FactoryTestLineContext<ShimmerFactoryTestReportParsed>,
): boolean {
  if (/^Testing Operational LED states\s*-\s*Start\b/i.test(trimmed)) {
    ctx.pushTest({
      id: null,
      name: 'led_states',
      label: 'Operational LED states',
      verdict: 'INFO',
      detail: '',
      metrics: {},
    });
    return true;
  }
  if (/^Testing Operational LED states\s*-\s*End\b/i.test(trimmed)) return true;

  const state = /^->\s*(.+?)\s*$/.exec(trimmed);
  if (state) {
    const test = ctx.result.tests.find((t) => t.name === 'led_states');
    if (!test) return false;
    test.detail = test.detail ? `${test.detail} | ${state[1]}` : state[1];
    const walked = Number(test.metrics.led_states_walked ?? 0) + 1;
    test.metrics.led_states_walked = walked;
    ctx.metrics.led_states_walked = walked;
    return true;
  }
  return false;
}

function shimmerGrammar(
  family: ShimmerFactoryTestReportFamily,
): FactoryTestGrammar<ShimmerFactoryTestReportParsed> {
  const numbered = family === 'shimmer3r';
  return {
    idToken: 'S3R_TEST',
    classifiers: SHIMMER_FACTORY_TEST_CLASSIFIERS,
    sectionHeadings: SECTION_HEADINGS,
    repairAnchors: REPAIR_ANCHORS,
    ledHeading: /^LED test(?:\s*\(\s*S3R_TEST_(\d{4})\s*\))?\s*:/i,
    ledClassifierName: 'led',
    // One LED entry however many times the narration mentions a lamp: the walk
    // is a single operator-visual check, and it has no bit in the fail mask.
    ledTest: () => ({ name: 'led', label: 'LED test' }),
    ledNarration: /^-\s*(All|Lower|Upper|Left|Right)\b.*LEDs?\b/i,
    testNameById: numbered ? (id) => SHIMMER3R_FACTORY_TEST_ID_NAMES[id] : undefined,
    maskTestName: numbered
      ? (id) => SHIMMER3R_FACTORY_TEST_ID_NAMES[id] ?? `s3r_test_${String(id).padStart(4, '0')}`
      : (id) => `test_${String(id).padStart(4, '0')}`,
    idlessVerdictLines: true,
    attachIndentedSubLines: true,
    // Shimmer3/3R print one line per ADS1292R chip, and one per LED colour, for
    // what the mask treats as a single test.
    mergeRepeatedNames: true,
    headerLine: readShimmerHeaderLine,
    subLine: readShimmerSubLine,
    extraLine: readShimmerExtraLine,
  };
}

const SHIMMER3R_GRAMMAR = shimmerGrammar('shimmer3r');
const SHIMMER3_GRAMMAR = shimmerGrammar('shimmer3');

function emptyResult(family: ShimmerFactoryTestReportFamily): ShimmerFactoryTestReportParsed {
  return {
    ok: false,
    complete: false,
    family,
    firmwareVersion: null,
    reportDate: null,
    reportTimeUtc: null,
    overall: emptyFactoryTestOverall(),
    mcu: {
      macId: null,
      deviceId: null,
      revisionId: null,
      uniqueId: null,
      lastResetReason: null,
      lseDrive: null,
      io: { docked: null, btConnected: null, buttonPressed: null, usbConnected: null },
    },
    model: null,
    tests: [],
    metrics: {},
    unparsedLines: [],
    parserWarnings: [],
  };
}

/**
 * Parse a Shimmer3 or Shimmer3R factory test report into structured metrics.
 *
 * The family is detected from the report itself, so the caller does not have to
 * know which board it is talking to — useful because the same page drives both.
 * A report from neither board still parses under the id-less grammar and comes
 * back with `family: 'unknown'` and a parser warning saying so.
 *
 * Never throws: empty, truncated and garbage input all return a result.
 */
export function parseShimmerFactoryTestReport(text: string): ShimmerFactoryTestReportParsed {
  const detected = detectFactoryTestReportFamily(text);
  const family: ShimmerFactoryTestReportFamily =
    detected === 'shimmer3r' || detected === 'shimmer3' ? detected : 'unknown';
  const grammar = family === 'shimmer3r' ? SHIMMER3R_GRAMMAR : SHIMMER3_GRAMMAR;
  const result = parseFactoryTestReport(text, grammar, () => emptyResult(family));
  if (family === 'unknown') {
    result.parserWarnings.push(
      detected === 'verisense'
        ? 'this is a Verisense factory test report - parse it with parseVerisenseFactoryTestReport'
        : 'no Shimmer3 or Shimmer3R factory test report was recognized in this text',
    );
  }
  const model = result.tests.find((t) => t.name === 'model');
  if (model) {
    result.model = {
      name: (model.metrics.model_name as string | undefined) ?? null,
      srRevision: (model.metrics.model_sr_revision as string | undefined) ?? null,
    };
  }
  return result;
}

/**
 * Render a parsed report as two CSV rows (header, values): the caller's `meta`
 * columns first, then the parsed metrics sorted by name. A metric whose name
 * collides with a meta column is dropped in favour of the meta value.
 */
export function shimmerFactoryTestReportToCsvRows(
  parsed: ShimmerFactoryTestReportParsed,
  meta: Record<string, string | number | boolean | null> = {},
): string[] {
  return factoryTestReportToCsvRows(parsed, meta);
}
