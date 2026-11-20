import { csvCell } from '../../core/csv.js';

/**
 * Shared core for the plain-text factory test reports printed by every Shimmer
 * firmware family — Verisense (`Includes/ASM_common_source/Test/hal_factoryTest.c`)
 * and Shimmer3/Shimmer3R (`log-and-stream-common/Test/shimmer_test.c` plus each
 * board's `hal_FactoryTest.c`).
 *
 * The envelope is identical across families (a `TEST START` banner, a
 * `Firmware version:` line, a body of ` - <verdict>: <detail>` lines, an
 * optional `Overall Result = FAIL (0x…)` bitmask, a `TEST END` banner), so the
 * line loop, the truncation repair, the verdict tiers, the bitmask decode and
 * the CSV writer live here once. Everything a family prints differently is a
 * field of the `FactoryTestGrammar` it passes in.
 *
 * Two properties drive the whole design, and both came from Verisense:
 *
 * 1. **Tests are identified by line content, never by the printed test
 *    number.** Verisense renumbered its ids at firmware v2.00.010, so the same
 *    number means different tests across builds while the descriptive text
 *    stayed stable. Printed ids are still recorded per test and collected into
 *    an observed id-to-name map, which is what decodes the fail mask — so the
 *    mask is read correctly under either numbering.
 *
 * 2. **The report format is unversioned and still changing.** Nothing here
 *    throws: unrecognized test lines become generic entries, unrecognized text
 *    is preserved verbatim in `unparsedLines`, and the caller keeps the raw
 *    report alongside the parse.
 */

/** Verdict carried by a single report line. */
export type FactoryTestVerdict =
  'PASS' | 'FAIL' | 'WARNING' | 'NOT_APPLICABLE' | 'INFO' | 'UNKNOWN';

/** A value extracted from the report, as it should land in a spreadsheet cell. */
export type FactoryTestMetricValue = number | string | boolean;

/** One test as it appeared in the report. */
export interface FactoryTestResult {
  /** The test number printed in *this* report, or null if the line carried
   * none (Shimmer3 prints no numbers at all). Not stable across firmware
   * versions — see `name`. */
  id: number | null;
  /** Canonical snake_case key derived from the line's content. Stable across
   * firmware versions; this is what column names are built from. */
  name: string;
  /** Human-readable test name, e.g. `'VD6283TX Light sensor'`. */
  label: string;
  verdict: FactoryTestVerdict;
  /** The report text for this test, sub-lines joined with `' | '`. */
  detail: string;
  metrics: Record<string, FactoryTestMetricValue>;
}

/** Overall verdict block printed just before the TEST END banner. */
export interface FactoryTestOverall {
  /** null when the report never reached its footer (e.g. a blank board aborts
   * the run at the Shimmer model test), and for the suites that print no
   * overall verdict at all (the LED walks). */
  result: 'PASS' | 'FAIL' | null;
  failMaskHex: string | null;
  failMask: number | null;
  /** Canonical names of the tests whose bits are set, resolved through the ids
   * actually observed in this report. */
  failedTestNames: string[];
}

/** The fields every family's parse result carries. */
export interface FactoryTestReportParsedBase {
  /** The TEST START banner was found. */
  ok: boolean;
  /** The TEST END banner was found — a report can be valid but truncated. */
  complete: boolean;
  /** Dotted firmware version from the `Firmware version:` line, e.g. `'2.00.024'`. */
  firmwareVersion: string | null;
  overall: FactoryTestOverall;
  /** Tests in the order they were printed. */
  tests: FactoryTestResult[];
  /** Every metric merged into one flat map — one spreadsheet column per key. */
  metrics: Record<string, FactoryTestMetricValue>;
  /** Lines no rule recognized. Never dropped, so nothing is silently lost. */
  unparsedLines: string[];
  /** Anomalies worth surfacing (repaired truncation, stripped progress dots…). */
  parserWarnings: string[];
}

/** One content rule: the first whose `match` hits the line body wins. */
export interface FactoryTestClassifier {
  name: string;
  label: string;
  match: RegExp;
  /** Column holding this test's verdict. Defaults to `<name>_result`. */
  resultKey?: string;
  extract?: (body: string, out: Record<string, FactoryTestMetricValue>) => void;
}

/** What a grammar hook is handed for the line it is being offered. */
export interface FactoryTestLineContext<R extends FactoryTestReportParsedBase> {
  /** The result being built. */
  result: R;
  /** The flat, report-wide metrics map. */
  metrics: Record<string, FactoryTestMetricValue>;
  /** The test this line would attach to, or null between tests. */
  current: FactoryTestResult | null;
  /** Append a test to the report; returns the entry that ended up holding it
   * (a different object when `mergeRepeatedNames` folded it into an earlier
   * test of the same name). */
  pushTest: (test: FactoryTestResult) => FactoryTestResult;
  /** Append this line's text to the open test's `detail`. */
  addDetail: (line: string) => void;
  /** Record a parser warning. */
  warn: (message: string) => void;
}

/** A hook offered one trimmed line; returns true when it consumed it. */
export type FactoryTestLineRule<R extends FactoryTestReportParsedBase> = (
  trimmed: string,
  ctx: FactoryTestLineContext<R>,
) => boolean;

/**
 * Everything one firmware family prints differently.
 *
 * Flags default to off, which is the Verisense behaviour the shared core was
 * extracted from: a grammar that sets none of them parses exactly as the
 * standalone Verisense parser did.
 */
export interface FactoryTestGrammar<R extends FactoryTestReportParsedBase> {
  /** Test-number prefix, e.g. `'WS_TEST'` or `'S3R_TEST'`. Also seeds the
   * fallback name for a test no classifier recognized (`ws_test_0027`). */
  idToken: string;
  /** Content rules, matched in order against the text after the id prefix. */
  classifiers: FactoryTestClassifier[];
  /** Section headers that carry no data but end the open test's sub-line run. */
  sectionHeadings: RegExp;
  /** Line starts that may appear glued onto the end of a previous line, because
   * the firmware assembles each line in a fixed-size buffer and drops the CRLF
   * of anything that overruns it. */
  repairAnchors: RegExp[];
  /** `Firmware version:` line; capture group 1 is the dotted version. */
  firmwareVersion?: RegExp;
  /** LED test heading; capture group 1 is the printed id, if the family prints
   * one inside the heading. */
  ledHeading?: RegExp;
  /** Classifier name that means "this line is the LED test", so an id line for
   * it is routed through `ledTest` as the heading would have been. */
  ledClassifierName?: string;
  /** Name/label for the `index`-th LED test block in the report. */
  ledTest?: (index: number, id: number | null) => { name: string; label: string };
  /** Operator-visual narration lines belonging to the open LED test. */
  ledNarration?: RegExp;
  /** Second chance to name a test whose line content no classifier recognized,
   * from the number the firmware printed. Content still wins, because the
   * numbering is the part that has moved between firmware releases; this is
   * for the lines that carry a bare verdict and no describing words at all
   * (Shimmer3R prints ` - S3R_TEST_0026 - PASS` for the microphone). A name
   * found here is looked up among the classifiers for its label and extractor. */
  testNameById?: (id: number) => string | undefined;
  /** Name used for a fail-mask bit whose id was never seen in this report.
   * Defaults to `<idToken lowercased>_00NN`. */
  maskTestName?: (id: number) => string;
  /** Accept ` - PASS: …` lines that carry no test number, as Shimmer3 prints
   * them. Off for families that always print a number. */
  idlessVerdictLines?: boolean;
  /** Attach an unrecognized *indented* line to the open test as detail rather
   * than filing it under `unparsedLines`. */
  attachIndentedSubLines?: boolean;
  /** Fold a second test of the same canonical name into the first,
   * worst-verdict-wins (Shimmer3/3R print one line per ADS1292R chip, and one
   * line per LED, for what is a single test). */
  mergeRepeatedNames?: boolean;
  /** Fold transport-mangled characters before parsing. Defaults to the degree
   * sign normalizer. */
  normalizeText?: (text: string) => string;
  /** Identification lines printed above the first test. */
  headerLine?: FactoryTestLineRule<R>;
  /** Indented continuation lines belonging to a test. */
  subLine?: FactoryTestLineRule<R>;
  /** Last chance before a line is filed as unparsed. */
  extraLine?: FactoryTestLineRule<R>;
}

/** Which firmware family printed a report. */
export type FactoryTestReportFamily = 'verisense' | 'shimmer3r' | 'shimmer3' | 'unknown';

/**
 * Temperature in parentheses at the end of a chip self-test line.
 *
 * The only regex deliberately widened when the Verisense parser became shared:
 * Verisense prints whole degrees with a degree sign (`(25° C)`, or `(25Â° C)`
 * when the byte reached us through a latin1 decode), Shimmer3R prints two
 * decimal places with the sign spelled out (`(24.37 degC)`, `(-3.50 degC)`).
 * Firmware: `Shimmer_Driver/hal_FactoryTest.c:1266`.
 */
const TEMPERATURE_IN_PARENS = /\(\s*(-?\d+(?:\.\d+)?)\s*(?:°\s*C|deg\s*C)\s*\)/i;

/** Shared shape of the IMU-class self-test lines: optional temperature in
 * parentheses plus an optional failure-reason suffix. */
export function chipDetail(
  body: string,
  out: Record<string, FactoryTestMetricValue>,
  prefix: string,
): void {
  setNum(out, `${prefix}_temp_c`, TEMPERATURE_IN_PARENS.exec(body)?.[1]);
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

/** Record `value` under `key` when it parses as a finite number. */
export function setNum(
  out: Record<string, FactoryTestMetricValue>,
  key: string,
  value: string | undefined | null,
): void {
  const n = num(value);
  if (n !== undefined) out[key] = n;
}

/** Record `value` under `key` when it is a non-empty string. */
export function setStr(
  out: Record<string, FactoryTestMetricValue>,
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
 * others; depending on how the transport decoded the bytes we see the degree
 * sign itself, the mojibake a latin1 decode of the UTF-8 pair produces, or the
 * Unicode replacement character. This file is UTF-8; the three source literals
 * below are those exact three encodings and must not be "tidied".
 */
export function normalizeReportText(text: string): string {
  return String(text ?? '')
    .replace(/Â°/g, '°')
    .replace(/�/g, '°');
}

/** Split into lines, dropping progress dots and re-splitting lines that the
 * firmware's fixed-size buffer glued together. */
function toLines(text: string, anchors: RegExp[], warnings: string[]): string[] {
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
    for (const piece of repairLine(line, anchors, warnings)) {
      if (piece.trim()) out.push(piece);
    }
  }
  if (stripped) warnings.push(`stripped ${stripped} progress-dot line(s)`);
  return out;
}

/** Re-split one physical line wherever a known line start appears mid-line. */
function repairLine(line: string, anchors: RegExp[], warnings: string[]): string[] {
  let earliest = -1;
  for (const anchor of anchors) {
    anchor.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = anchor.exec(line)) !== null) {
      if (m.index > 0 && (earliest < 0 || m.index < earliest)) earliest = m.index;
      // A non-global anchor would loop forever on the same match.
      if (!anchor.global) break;
    }
  }
  if (earliest <= 0) return [line];
  warnings.push(`repaired a line truncated by the firmware buffer near column ${earliest}`);
  const head = line.slice(0, earliest);
  return [head, ...repairLine(line.slice(earliest), anchors, warnings)];
}

/** Read the verdict keyword, if any, off the text following the test id. */
export function readVerdict(body: string): FactoryTestVerdict {
  const m = /^\s*(PASS|FAIL|WARNING)\b/i.exec(body);
  if (m) return m[1].toUpperCase() as FactoryTestVerdict;
  if (/not applicable/i.test(body)) return 'NOT_APPLICABLE';
  if (body.trim()) return 'INFO';
  return 'UNKNOWN';
}

/** How loudly a verdict should shout when two lines of one test disagree. */
const VERDICT_SEVERITY: Record<FactoryTestVerdict, number> = {
  FAIL: 5,
  WARNING: 4,
  PASS: 3,
  NOT_APPLICABLE: 2,
  INFO: 1,
  UNKNOWN: 0,
};

function worstVerdict(a: FactoryTestVerdict, b: FactoryTestVerdict): FactoryTestVerdict {
  return VERDICT_SEVERITY[b] > VERDICT_SEVERITY[a] ? b : a;
}

/**
 * Fallback for a test this build of the SDK has never seen: keep any
 * `Key = value` pairs so a firmware change still lands data in the sheet.
 */
export function scrapeGenericMetrics(
  body: string,
  name: string,
  out: Record<string, FactoryTestMetricValue>,
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

/** The empty overall block, so callers building an empty result agree on it. */
export function emptyFactoryTestOverall(): FactoryTestOverall {
  return { result: null, failMaskHex: null, failMask: null, failedTestNames: [] };
}

/**
 * Parse a full factory test report into structured metrics under `grammar`.
 *
 * Never throws: malformed or unrecognized input comes back with `ok: false`
 * and/or its lines preserved in `unparsedLines`.
 */
export function parseFactoryTestReport<R extends FactoryTestReportParsedBase>(
  text: string,
  grammar: FactoryTestGrammar<R>,
  empty: () => R,
): R {
  const result = empty();
  try {
    const normalize = grammar.normalizeText ?? normalizeReportText;
    parseInto(normalize(text), grammar, result);
  } catch (err) {
    result.parserWarnings.push(`parser error: ${String((err as Error)?.message ?? err)}`);
  }
  return result;
}

function parseInto<R extends FactoryTestReportParsedBase>(
  text: string,
  grammar: FactoryTestGrammar<R>,
  result: R,
): void {
  const warnings = result.parserWarnings;
  const lines = toLines(text, grammar.repairAnchors, warnings);
  const metrics = result.metrics;
  /** Canonical name of the test each printed id was seen against, so the fail
   * mask can be decoded under whichever numbering this report used. */
  const nameById = new Map<number, string>();
  /** Tests printed without a number, in print order, so a mask can still be
   * decoded positionally when the family prints no ids at all. */
  const idlessTests: FactoryTestResult[] = [];
  const byName = new Map<string, FactoryTestResult>();
  let ledSeen = 0;
  /** Held in an object so the assignment inside `pushTest` stays visible to
   * the type checker at every use site. */
  const open: { test: FactoryTestResult | null } = { test: null };

  const idPattern = new RegExp(`^-?\\s*${grammar.idToken}_(\\d{4})\\s*-\\s*(.*)$`, 'i');
  const firmwarePattern = grammar.firmwareVersion ?? /^Firmware version\s*:\s*v?([\d.]+)/i;
  const maskTestName =
    grammar.maskTestName ??
    ((id: number) => `${grammar.idToken.toLowerCase()}_${String(id).padStart(4, '0')}`);

  const pushTest = (test: FactoryTestResult): FactoryTestResult => {
    if (grammar.mergeRepeatedNames) {
      const existing = byName.get(test.name);
      if (existing) {
        existing.verdict = worstVerdict(existing.verdict, test.verdict);
        existing.detail = existing.detail ? `${existing.detail} | ${test.detail}` : test.detail;
        Object.assign(existing.metrics, test.metrics);
        if (existing.id == null && test.id != null) existing.id = test.id;
        if (test.id != null) nameById.set(test.id, existing.name);
        open.test = existing;
        return existing;
      }
      byName.set(test.name, test);
    }
    result.tests.push(test);
    if (test.id != null) nameById.set(test.id, test.name);
    else idlessTests.push(test);
    open.test = test;
    return test;
  };

  const addDetail = (line: string): void => {
    const test = open.test;
    if (!test) return;
    test.detail = test.detail ? `${test.detail} | ${line.trim()}` : line.trim();
  };

  const warn = (message: string): void => {
    warnings.push(message);
  };

  const ctx = (): FactoryTestLineContext<R> => ({
    result,
    metrics,
    current: open.test,
    pushTest,
    addDetail,
    warn,
  });

  /** Route a classified test line through the LED naming rule when the family
   * has one, so a not-applicable LED line lands on the same entry the LED
   * heading would have created. */
  const resolveNames = (
    classifierName: string | undefined,
    fallbackName: string,
    fallbackLabel: string,
    id: number | null,
  ): { name: string; label: string } => {
    if (
      grammar.ledTest &&
      grammar.ledClassifierName &&
      classifierName === grammar.ledClassifierName
    ) {
      const named = grammar.ledTest(ledSeen, id);
      ledSeen += 1;
      return named;
    }
    return { name: fallbackName, label: fallbackLabel };
  };

  /** The classifier a printed test number points at, when the line's own words
   * said nothing. Gives the id-named test its label and extractor. */
  const classifierForId = (id: number): FactoryTestClassifier | undefined => {
    const named = grammar.testNameById?.(id);
    if (!named) return undefined;
    return (
      grammar.classifiers.find((c) => c.name === named) ?? {
        name: named,
        label: named,
        match: /(?!)/,
      }
    );
  };

  /** Build, classify and file one test line, merging into an earlier test of
   * the same name when the grammar asks for it. */
  const recordTest = (
    body: string,
    id: number | null,
    name: string,
    label: string,
    classifier: FactoryTestClassifier | undefined,
  ): void => {
    const verdict = readVerdict(body);
    const testMetrics: Record<string, FactoryTestMetricValue> = {};
    classifier?.extract?.(body, testMetrics);
    if (!classifier) scrapeGenericMetrics(body, name, testMetrics);

    // A verdict column is only worth a spreadsheet cell when it can vary:
    // PASS/FAIL/WARNING record an outcome and NOT_APPLICABLE records a
    // model gate, but INFO just means "an informational line printed" — its
    // substance is already in that line's own metrics (usb_power_good,
    // charger_status, ...), so emitting it would waste a column per test.
    const resultKey = classifier?.resultKey ?? `${name}_result`;
    if (verdict !== 'INFO') testMetrics[resultKey] = verdict;

    const test = pushTest({ id, name, label, verdict, detail: body.trim(), metrics: testMetrics });
    // After a merge the surviving verdict may be worse than this line's.
    if (test.verdict !== 'INFO') test.metrics[resultKey] = test.verdict;
    Object.assign(metrics, test.metrics);
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

    const fw = firmwarePattern.exec(trimmed);
    if (fw) {
      result.firmwareVersion = fw[1];
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
    if (grammar.sectionHeadings.test(trimmed)) {
      open.test = null;
      continue;
    }

    if (grammar.headerLine?.(trimmed, ctx())) continue;

    // `LED test (WS_TEST_0019):` — the family decides what the n-th such block
    // is called; ordering survives renumbering.
    const ledHeader = grammar.ledHeading?.exec(trimmed);
    if (ledHeader) {
      const id = ledHeader[1] ? Number(ledHeader[1]) : null;
      const named = grammar.ledTest?.(ledSeen, id) ?? { name: 'led', label: 'LED test' };
      ledSeen += 1;
      pushTest({ id, ...named, verdict: 'INFO', detail: '', metrics: {} });
      // Deliberately no `<name>_result` metric: an INFO verdict carries no
      // data (the LED test is operator-visual narration), and which suite ran
      // is already recorded by the caller's factory-test-type column. The
      // verdict is still on the tests[] entry for anyone who wants it.
      continue;
    }

    const idLine = idPattern.exec(trimmed.replace(/^-\s*/, '- '));
    if (idLine) {
      const id = Number(idLine[1]);
      const body = idLine[2] ?? '';
      const classifier = grammar.classifiers.find((c) => c.match.test(body)) ?? classifierForId(id);
      const fallbackName = `${grammar.idToken.toLowerCase()}_${idLine[1]}`;
      const fallbackLabel = `${grammar.idToken}_${idLine[1]}`;
      const { name, label } = resolveNames(
        classifier?.name,
        classifier?.name ?? fallbackName,
        classifier?.label ?? fallbackLabel,
        id,
      );
      recordTest(body, id, name, label, classifier);
      continue;
    }

    if (grammar.subLine?.(trimmed, ctx())) continue;

    // LED narration (`- All LEDs off`, `- Left Red LED on`) belongs to the LED
    // test currently open.
    if (open.test && grammar.ledNarration?.test(trimmed)) {
      addDetail(trimmed.replace(/^-\s*/, ''));
      continue;
    }

    // Shimmer3 (MSP430) prints verdict lines with no test number at all. A test
    // line sits at the report's left margin (` - PASS: …`, or no space at all);
    // anything indented further is a continuation of the test above it.
    if (grammar.idlessVerdictLines && !/^[ \t]{2,}/.test(line)) {
      const bare = /^-\s*(.+)$/.exec(trimmed);
      const body = bare?.[1] ?? '';
      const classifier = body ? grammar.classifiers.find((c) => c.match.test(body)) : undefined;
      const hasVerdict = /^(PASS|FAIL|WARNING)\b/i.test(body) || /not applicable/i.test(body);
      if (classifier || (body && hasVerdict)) {
        const ordinal = idlessTests.length + 1;
        const { name, label } = resolveNames(
          classifier?.name,
          classifier?.name ?? `test_${String(ordinal).padStart(4, '0')}`,
          classifier?.label ?? `Test ${ordinal}`,
          null,
        );
        recordTest(body, null, name, label, classifier);
        continue;
      }
    }

    if (grammar.extraLine?.(trimmed, ctx())) continue;

    // An indented line the family did not claim still belongs to the test above
    // it (GSR rig rows, SD geometry) rather than to the unparsed pile.
    if (grammar.attachIndentedSubLines && open.test && /^[ \t]/.test(line)) {
      addDetail(trimmed.replace(/^-\s*/, ''));
      continue;
    }

    result.unparsedLines.push(line);
  }

  // Decode the fail mask through the ids this report actually used.
  if (result.overall.failMask != null) {
    const positional = nameById.size === 0 && idlessTests.length > 0;
    const names: string[] = [];
    for (let bit = 0; bit < 32; bit += 1) {
      if (!(result.overall.failMask & (1 << bit))) continue;
      const id = bit + 1;
      const byId = nameById.get(id);
      names.push(byId ?? (positional ? idlessTests[bit]?.name : undefined) ?? maskTestName(id));
    }
    result.overall.failedTestNames = names;
    if (positional) {
      warnings.push(
        'this report prints no test numbers, so fail-mask bits were matched to tests by print order',
      );
    }
  }
}

/**
 * Guess which firmware family printed a report.
 *
 * The test-number prefix is decisive when one is printed. Shimmer3 (MSP430)
 * prints none, so it is recognized by its section headings instead — which
 * also means an LED-states walk, printed by identical shared code on both
 * Shimmer boards and carrying no numbers, reports as `'shimmer3'` whichever
 * board ran it. That is the right parse either way: with no ids to resolve,
 * the two Shimmer grammars differ only in names this report does not contain.
 */
export function detectFactoryTestReportFamily(text: string): FactoryTestReportFamily {
  const s = String(text ?? '');
  if (/\bWS_TEST_\d{4}\b/i.test(s)) return 'verisense';
  if (/\bS3R_TEST_\d{4}\b/i.test(s)) return 'shimmer3r';
  if (/^\s*Testing Operational LED states\b/im.test(s)) return 'shimmer3';
  const shimmerHeadings = /^\s*(?:Shimmer model|BT Module|SD Card|LED test|I2C|SPI)\s*:\s*$/im.test(
    s,
  );
  if (shimmerHeadings && /TEST START/.test(s)) return 'shimmer3';
  return 'unknown';
}

/**
 * Render a parsed report as two CSV rows (header, values): the caller's `meta`
 * columns first, then the parsed metrics sorted by name. A metric whose name
 * collides with a meta column is dropped in favour of the meta value — the
 * caller's identity columns are authoritative, and a duplicated header name
 * breaks most CSV consumers.
 */
export function factoryTestReportToCsvRows(
  parsed: FactoryTestReportParsedBase,
  meta: Record<string, string | number | boolean | null> = {},
): string[] {
  // Normalized once and used for both key discovery and value lookup, so a
  // null/undefined `parsed` from a plain-JS caller cannot throw here.
  const metrics = parsed?.metrics ?? {};
  const metaKeys = Object.keys(meta);
  const metaKeySet = new Set(metaKeys);
  const metricKeys = Object.keys(metrics)
    .filter((k) => !metaKeySet.has(k))
    .sort();
  const header = [...metaKeys, ...metricKeys].map(csvCell).join(',');
  const values = [...metaKeys.map((k) => meta[k]), ...metricKeys.map((k) => metrics[k])]
    .map(csvCell)
    .join(',');
  return [header, values];
}
