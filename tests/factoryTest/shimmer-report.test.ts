import { describe, it, expect } from 'vitest';
import {
  detectFactoryTestReportFamily,
  factoryTestReportToCsvRows,
} from '../../src/devices/factoryTest/report.js';
import {
  SHIMMER3R_FACTORY_TEST_ID_NAMES,
  SHIMMER_FACTORY_TEST_CLASSIFIERS,
  parseShimmerFactoryTestReport,
  shimmerFactoryTestReportToCsvRows,
} from '../../src/devices/factoryTest/shimmerReport.js';
import { parseVerisenseFactoryTestReport } from '../../src/devices/verisense/factoryTestReport.js';
import { SR61_REPORT, SR68_REPORT } from '../verisense/factoryTestFixtures.js';
import {
  crlf,
  LED_STATES_REPORT,
  MAX_TEST_REPORT_LENGTH,
  S3R_BT_LSE_FAULT_REPORT,
  S3R_LEDS_REPORT,
  S3R_LSE_LONG_LINE,
  S3R_MAIN_REPORT,
  S3R_TRUNCATED_REPORT,
  SHIMMER3_FAULT_REPORT,
  SHIMMER3_HYPOTHETICAL_MASK_REPORT,
  SHIMMER3_PASS_REPORT,
} from './shimmerReportFixtures.js';

describe('parseShimmerFactoryTestReport - Shimmer3R MAIN report', () => {
  const parsed = parseShimmerFactoryTestReport(S3R_MAIN_REPORT);

  it('recognizes the family, the banners and the header block', () => {
    expect(parsed.family).toBe('shimmer3r');
    expect(parsed.ok).toBe(true);
    expect(parsed.complete).toBe(true);
    expect(parsed.firmwareVersion).toBe('1.01.012');
    expect(parsed.reportDate).toBe('2026-09-03');
    expect(parsed.reportTimeUtc).toBe('14:22:07');
  });

  it('names every numbered test from its content', () => {
    const byId = new Map(parsed.tests.map((t) => [t.id, t.name]));
    expect(byId.get(3)).toBe('model');
    expect(byId.get(7)).toBe('vref');
    expect(byId.get(8)).toBe('vcore');
    expect(byId.get(9)).toBe('vbatt_pin');
    expect(byId.get(10)).toBe('mcu_temp');
    expect(byId.get(11)).toBe('batt_voltage');
    expect(byId.get(12)).toBe('charger');
    expect(byId.get(13)).toBe('sd');
    expect(byId.get(14)).toBe('bt');
    expect(byId.get(16)).toBe('lsm6dsv');
    expect(byId.get(20)).toBe('lis2dw12');
    expect(byId.get(22)).toBe('lis2mdl');
    expect(byId.get(23)).toBe('eeprom_i2c1');
    expect(byId.get(24)).toBe('eeprom_i2c4_gsr_rig');
    expect(byId.get(25)).toBe('gsr_signal');
    expect(byId.get(28)).toBe('lse_crystal');
  });

  it('falls back to the id table for a line with no describing words', () => {
    // The microphone verdict is printed as a bare `PASS` with nothing for a
    // content rule to key on, so only the number can name it.
    const mic = parsed.tests.find((t) => t.id === 26);
    expect(mic?.name).toBe('microphone');
    expect(mic?.detail).toBe('PASS');
    expect(parsed.metrics.microphone_result).toBe('PASS');
  });

  it('extracts the MCU identity and I/O status', () => {
    expect(parsed.mcu.deviceId).toBe('1313');
    expect(parsed.mcu.revisionId).toBe('4096');
    expect(parsed.mcu.uniqueId).toBe('0x0033002A3438510C34333630');
    expect(parsed.mcu.lseDrive).toBe('MEDIUMLOW');
    expect(parsed.mcu.macId).toBe('0006666E9E42');
    expect(parsed.mcu.io).toEqual({
      docked: false,
      btConnected: true,
      buttonPressed: false,
      usbConnected: false,
    });
    expect(parsed.metrics.io_docked).toBe(false);
    expect(parsed.metrics.bt_mac).toBe('0006666E9E42');
  });

  it('extracts the model, rails, temperatures and chip detail', () => {
    expect(parsed.model).toEqual({ name: 'Shimmer3R', srRevision: 'SR62-0-0' });
    expect(parsed.metrics.temp_range_low_c).toBe(10);
    expect(parsed.metrics.temp_range_high_c).toBe(40);
    expect(parsed.metrics.vref_mv).toBe(2497);
    expect(parsed.metrics.vref_limit_low_mv).toBe(2420);
    expect(parsed.metrics.vref_limit_high_mv).toBe(2580);
    expect(parsed.metrics.vcore_mv).toBe(1210);
    expect(parsed.metrics.vbatt_pin_mv).toBe(2088);
    expect(parsed.metrics.vbatt_mv).toBe(4021);
    expect(parsed.metrics.mcu_temp_c).toBe(27);
    expect(parsed.metrics.lse_ppm).toBe(14.2);
    expect(parsed.metrics.lse_limit_ppm).toBe(50);
    expect(parsed.metrics.lse_caps).toBe('HSE-fixed');
    expect(parsed.metrics.charger_chip_status).toBe(
      'Pre-qualification mode, CC and CV charging, or Top-off mode',
    );
    expect(parsed.metrics.charging_status).toBe('Charging');
    expect(parsed.metrics.sd_manufacturer).toBe('SanDisk');
    expect(parsed.metrics.sd_manufacture_date).toBe('2023-05');
    expect(parsed.metrics.bt_module_version).toContain('RN4678');
    expect(parsed.metrics.bmp390_fail_reason).toBe('Chip not detected');
  });

  it('reads the Shimmer3R two-decimal temperature format, negatives included', () => {
    expect(parsed.metrics.lsm6dsv_temp_c).toBe(24.37);
    expect(parsed.metrics.lis2mdl_temp_c).toBe(24.51);
    expect(parsed.metrics.lis2dw12_temp_c).toBe(-3.5);
  });

  it('keeps WARNING as its own tier, distinct from FAIL', () => {
    expect(parsed.metrics.gsr_signal_result).toBe('WARNING');
    expect(parsed.overall.failedTestNames).not.toContain('gsr_signal');
  });

  it('marks model-gated tests not applicable rather than failed', () => {
    expect(parsed.metrics.ads7028_result).toBe('NOT_APPLICABLE');
    expect(parsed.metrics.adxl371_result).toBe('NOT_APPLICABLE');
    expect(parsed.metrics.lis3mdl_result).toBe('NOT_APPLICABLE');
  });

  it('merges the two ExG chip lines into one test, worst verdict winning', () => {
    const exg = parsed.tests.filter((t) => t.name === 'ads1292r');
    expect(exg).toHaveLength(1);
    expect(exg[0].verdict).toBe('FAIL');
    expect(exg[0].detail).toBe('PASS: ADS1292R Chip1 detect | FAIL: ADS1292R Chip2 detect');
    expect(parsed.metrics.ads1292r_result).toBe('FAIL');
  });

  it('collapses the LED walk to one informational test with no verdict column', () => {
    const led = parsed.tests.filter((t) => t.name === 'led');
    expect(led).toHaveLength(1);
    expect(led[0].id).toBe(27);
    expect(led[0].verdict).toBe('INFO');
    expect(led[0].detail).toContain('Lower Red LED on');
    expect(led[0].detail).toContain('Upper Blue LED on');
    expect(parsed.metrics.led_result).toBeUndefined();
  });

  it('decodes the fail mask to the names the report actually used', () => {
    expect(parsed.overall.result).toBe('FAIL');
    expect(parsed.overall.failMaskHex).toBe('0x00112000');
    // Bits 13, 16 and 20 => ids 14, 17 and 21.
    expect(parsed.overall.failedTestNames).toEqual(['bt', 'bmp390', 'ads1292r']);
    // Id 0027 has no bit at all, so the LED walk can never appear here.
    expect(parsed.overall.failedTestNames).not.toContain('led');
  });

  it('leaves nothing unrecognized and warns about nothing', () => {
    expect(parsed.unparsedLines).toEqual([]);
    expect(parsed.parserWarnings).toEqual([]);
  });
});

describe('parseShimmerFactoryTestReport - Shimmer3R faults', () => {
  const parsed = parseShimmerFactoryTestReport(S3R_BT_LSE_FAULT_REPORT);

  it('reads the Bluetooth failure that uses a dash where every other line uses a colon', () => {
    const bt = parsed.tests.find((t) => t.id === 14);
    expect(bt?.name).toBe('bt');
    expect(bt?.verdict).toBe('FAIL');
    expect(bt?.detail).toBe("FAIL - BT hasn't initialised");
    expect(parsed.metrics.bt_result).toBe('FAIL');
  });

  it('repairs the line the firmware truncated at its 128-byte cap', () => {
    // The LSE line overruns, so it loses its CRLF and the LSE drive line that
    // follows is glued onto its end.
    expect(S3R_LSE_LONG_LINE.length + 2).toBeGreaterThan(MAX_TEST_REPORT_LENGTH);
    expect(S3R_BT_LSE_FAULT_REPORT).toContain('H429496729 - LSE drive applied at boot: NONE');
    expect(parsed.parserWarnings.join(' ')).toMatch(/repaired a line truncated/i);
    // Both halves still parse.
    expect(parsed.metrics.lse_ppm).toBe(14.2);
    expect(parsed.metrics.lse_caps).toBe('HSE-fixed');
    expect(parsed.mcu.lseDrive).toBe('NONE');
    expect(parsed.unparsedLines).toEqual([]);
  });

  it('records an unset model as a failure with no name', () => {
    expect(parsed.metrics.model_result).toBe('FAIL');
    expect(parsed.metrics.model_name).toBeUndefined();
    expect(parsed.model).toEqual({ name: null, srRevision: null });
  });

  it('decodes a mask whose bits span the sparse id range', () => {
    // Bits 2, 13 and 25 => ids 3, 14 and 26.
    expect(parsed.overall.failedTestNames).toEqual(['model', 'bt', 'microphone']);
  });

  it('names a mask bit for a test that never printed, from the id table', () => {
    const gapped = parseShimmerFactoryTestReport(
      crlf([
        '//*** TEST START ***//',
        ' - S3R_TEST_0003 - PASS: Shimmer3R (SR62-0-0)',
        'Overall Result = FAIL (0x00001004)',
        '//*** TEST END ***//',
      ]),
    );
    // Bit 12 is id 13, the SD test, which this truncated run never reached.
    expect(gapped.overall.failedTestNames).toEqual(['model', 'sd']);
  });

  it('names an unknown future test after its number and scrapes its values', () => {
    const future = parseShimmerFactoryTestReport(
      crlf([
        '//*** TEST START ***//',
        ' - S3R_TEST_0099 - PASS: Widget check (Foo = 12 bar)',
        '//*** TEST END ***//',
      ]),
    );
    const test = future.tests.find((t) => t.id === 99);
    expect(test?.name).toBe('s3r_test_0099');
    expect(test?.label).toBe('S3R_TEST_0099');
    expect(future.metrics.s3r_test_0099_result).toBe('PASS');
    expect(future.metrics.s3r_test_0099_foo).toBe(12);
  });

  it('reads the whole-degree temperature format the shared parser also accepts', () => {
    for (const variant of ['25° C', '25Â° C']) {
      const parsedTemp = parseShimmerFactoryTestReport(
        crlf([
          '//*** TEST START ***//',
          ` - S3R_TEST_0016 - PASS: LSM6DSV (${variant})`,
          '//*** TEST END ***//',
        ]),
      );
      expect(parsedTemp.metrics.lsm6dsv_temp_c).toBe(25);
    }
  });
});

describe('parseShimmerFactoryTestReport - LED suites', () => {
  it('parses the LEDS suite as one informational test with no overall verdict', () => {
    const parsed = parseShimmerFactoryTestReport(S3R_LEDS_REPORT);
    expect(parsed.complete).toBe(true);
    expect(parsed.overall.result).toBeNull();
    expect(parsed.tests).toHaveLength(1);
    expect(parsed.tests[0]).toMatchObject({ id: 27, name: 'led', verdict: 'INFO' });
    expect(parsed.tests[0].detail.split(' | ')).toHaveLength(9);
    expect(parsed.unparsedLines).toEqual([]);
  });

  it('parses the LED-state walk as one informational test with a walked count', () => {
    const parsed = parseShimmerFactoryTestReport(LED_STATES_REPORT);
    expect(parsed.complete).toBe(true);
    expect(parsed.overall.result).toBeNull();
    expect(parsed.tests).toHaveLength(1);
    expect(parsed.tests[0]).toMatchObject({ id: null, name: 'led_states', verdict: 'INFO' });
    expect(parsed.metrics.led_states_walked).toBe(15);
    expect(parsed.tests[0].detail).toContain('BT Streaming and SD Logging');
    // The trailing ellipsis the firmware prints is not part of the state name.
    expect(parsed.tests[0].detail).not.toContain('...');
    expect(parsed.metrics.led_states_result).toBeUndefined();
    expect(parsed.unparsedLines).toEqual([]);
  });
});

describe('parseShimmerFactoryTestReport - Shimmer3 (MSP430), no test numbers', () => {
  const parsed = parseShimmerFactoryTestReport(SHIMMER3_PASS_REPORT);

  it('detects the family from the headings alone', () => {
    expect(parsed.family).toBe('shimmer3');
    expect(parsed.firmwareVersion).toBe('0.16.011');
  });

  it('gives every test a null id and a content-derived name', () => {
    expect(parsed.tests.every((t) => t.id === null)).toBe(true);
    expect(parsed.tests.map((t) => t.name)).toEqual([
      'model',
      'sd',
      'test_0003',
      'eeprom_i2c1',
      'lsm303',
      'mpu9x50',
      'bmpx80',
      'ads1292r',
      'led',
    ]);
  });

  it('numbers by print order the one line that carries no words at all', () => {
    // The Bluetooth firmware-version verdict is a bare ` - PASS` under the
    // `BT Module:` heading; nothing in it can name the test.
    const bare = parsed.tests.find((t) => t.name === 'test_0003');
    expect(bare?.detail).toBe('PASS');
    expect(parsed.metrics.test_0003_result).toBe('PASS');
  });

  it('merges the repeated SD and ExG lines', () => {
    expect(parsed.tests.filter((t) => t.name === 'sd')).toHaveLength(1);
    expect(parsed.metrics.sd_result).toBe('PASS');
    expect(parsed.metrics.ads1292r_result).toBe('PASS');
  });

  it('keeps the detected-but-untested chips informational', () => {
    expect(parsed.tests.find((t) => t.name === 'lsm303')?.verdict).toBe('INFO');
    expect(parsed.metrics.lsm303_result).toBeUndefined();
  });

  it('reads the header, I/O status and Bluetooth fault counters', () => {
    expect(parsed.mcu.lastResetReason).toBe('Brownout (BOR) (highest priority)');
    expect(parsed.mcu.io.docked).toBe(false);
    expect(parsed.mcu.io.usbConnected).toBeNull(); // the MSP430 build prints three
    expect(parsed.metrics.bt_data_rate_test_blockages).toBe(0);
    expect(parsed.metrics.bt_disconnects_while_streaming).toBe(2);
    expect(parsed.metrics.bt_rts_lockups).toBe(0);
    expect(parsed.metrics.bt_unsolicited_reboots).toBe(1);
    expect(parsed.unparsedLines).toEqual([]);
  });

  it('reports PASS overall even with failing lines, as the firmware does', () => {
    // The MSP430 build never populates `shimmerStatus.testResult`, so its
    // overall line is not a summary of the lines above it.
    const faulty = parseShimmerFactoryTestReport(SHIMMER3_FAULT_REPORT);
    expect(faulty.overall.result).toBe('PASS');
    expect(faulty.overall.failMask).toBeNull();
    expect(faulty.metrics.sd_result).toBe('FAIL');
    expect(faulty.metrics.lsm303_result).toBe('WARNING');
    expect(faulty.metrics.mpu9x50_result).toBe('FAIL');
    expect(faulty.metrics.bmpx80_result).toBe('FAIL');
    expect(faulty.unparsedLines).toEqual([]);
  });

  it('reads the two lines the MSP430 prints with no leading space', () => {
    const faulty = parseShimmerFactoryTestReport(SHIMMER3_FAULT_REPORT);
    expect(faulty.tests.find((t) => t.name === 'ads1292r')?.detail).toBe(
      'FAIL: ADS1292R test will not work from dock',
    );
    const gated = parseShimmerFactoryTestReport(
      crlf([
        '//*** TEST START ***//',
        'SPI:',
        '- ADS1292R test not applicable for this model',
        '//*** TEST END ***//',
      ]),
    );
    expect(gated.metrics.ads1292r_result).toBe('NOT_APPLICABLE');
  });

  it('falls back to print order for a mask, and says so', () => {
    const parsedMask = parseShimmerFactoryTestReport(SHIMMER3_HYPOTHETICAL_MASK_REPORT);
    expect(parsedMask.overall.failMaskHex).toBe('0x00000001');
    expect(parsedMask.overall.failedTestNames).toEqual(['sd']);
    expect(parsedMask.parserWarnings.join(' ')).toMatch(/no test numbers/i);
  });

  it('names a mask bit past the printed tests test_00NN', () => {
    const parsedMask = parseShimmerFactoryTestReport(
      crlf([
        '//*** TEST START ***//',
        'SD Card:',
        ' - PASS: SD card detected',
        'Overall Result = FAIL (0x00000010)',
        '//*** TEST END ***//',
      ]),
    );
    expect(parsedMask.overall.failedTestNames).toEqual(['test_0005']);
  });
});

describe('detectFactoryTestReportFamily', () => {
  it('recognizes each family from its report', () => {
    expect(detectFactoryTestReportFamily(S3R_MAIN_REPORT)).toBe('shimmer3r');
    expect(detectFactoryTestReportFamily(S3R_LEDS_REPORT)).toBe('shimmer3r');
    expect(detectFactoryTestReportFamily(SHIMMER3_PASS_REPORT)).toBe('shimmer3');
    expect(detectFactoryTestReportFamily(SHIMMER3_FAULT_REPORT)).toBe('shimmer3');
    expect(detectFactoryTestReportFamily(SR68_REPORT)).toBe('verisense');
    expect(detectFactoryTestReportFamily(SR61_REPORT)).toBe('verisense');
    expect(detectFactoryTestReportFamily('')).toBe('unknown');
    expect(detectFactoryTestReportFamily('not a report at all')).toBe('unknown');
  });

  it('reports the id-less LED-state walk as shimmer3, whichever board ran it', () => {
    // The walk is printed by code shared between the two boards and carries no
    // test numbers, so nothing in it can tell them apart. The id-less grammar
    // is the correct parse either way.
    expect(detectFactoryTestReportFamily(LED_STATES_REPORT)).toBe('shimmer3');
  });

  it('points a Verisense report at the Verisense parser instead of guessing', () => {
    const parsed = parseShimmerFactoryTestReport(SR68_REPORT);
    expect(parsed.family).toBe('unknown');
    expect(parsed.parserWarnings.join(' ')).toMatch(/parseVerisenseFactoryTestReport/);
  });

  it('warns rather than throwing on text that is no report at all', () => {
    const parsed = parseShimmerFactoryTestReport('hello');
    expect(parsed.family).toBe('unknown');
    expect(parsed.ok).toBe(false);
    expect(parsed.parserWarnings.join(' ')).toMatch(/no Shimmer3 or Shimmer3R/i);
  });
});

describe('parseShimmerFactoryTestReport - robustness', () => {
  it('keeps a report that was cut off mid-line', () => {
    const parsed = parseShimmerFactoryTestReport(S3R_TRUNCATED_REPORT);
    expect(parsed.ok).toBe(true);
    expect(parsed.complete).toBe(false);
    expect(parsed.overall.result).toBeNull();
    expect(parsed.metrics.model_result).toBe('PASS');
    // The half-printed rail line yields everything it managed to print; only
    // the limits, which the link cut off mid-number, are missing.
    expect(parsed.metrics.vref_result).toBe('PASS');
    expect(parsed.metrics.vref_mv).toBe(2497);
    expect(parsed.metrics.vref_limit_low_mv).toBeUndefined();
    expect(parsed.metrics.vref_limit_high_mv).toBeUndefined();
  });

  it('preserves an unrecognized line rather than dropping it', () => {
    const parsed = parseShimmerFactoryTestReport(
      crlf([
        '//*** TEST START ***//',
        'SPI1:',
        'Some brand new section nobody has seen',
        '//*** TEST END ***//',
      ]),
    );
    expect(parsed.unparsedLines).toContain('Some brand new section nobody has seen');
  });

  it('never throws on empty, blank or garbage input', () => {
    for (const input of ['', '   ', 'not a report at all', ' binary', ' ']) {
      const parsed = parseShimmerFactoryTestReport(input);
      expect(parsed.ok).toBe(false);
      expect(parsed.overall.result).toBeNull();
      expect(parsed.tests).toEqual([]);
    }
    // Defensive: the signature is typed, but callers are plain JS.
    expect(() => parseShimmerFactoryTestReport(undefined as unknown as string)).not.toThrow();
    expect(() => detectFactoryTestReportFamily(undefined as unknown as string)).not.toThrow();
  });
});

describe('SHIMMER3R_FACTORY_TEST_ID_NAMES', () => {
  it('omits 0027, which the LED heading prints but the mask never carries', () => {
    expect(SHIMMER3R_FACTORY_TEST_ID_NAMES[27]).toBeUndefined();
    expect(SHIMMER3R_FACTORY_TEST_ID_NAMES[3]).toBe('model');
    expect(SHIMMER3R_FACTORY_TEST_ID_NAMES[28]).toBe('lse_crystal');
    // Sparse: nothing between the model test and the first MCU rail.
    for (const id of [1, 2, 4, 5, 6]) {
      expect(SHIMMER3R_FACTORY_TEST_ID_NAMES[id]).toBeUndefined();
    }
  });

  it('names only tests the classifier table can label', () => {
    const known = new Set(SHIMMER_FACTORY_TEST_CLASSIFIERS.map((c) => c.name));
    for (const name of Object.values(SHIMMER3R_FACTORY_TEST_ID_NAMES)) {
      expect(known.has(name)).toBe(true);
    }
  });
});

/** Split one CSV row, honouring the quoting the writer applies to a cell that
 * contains a comma — the firmware's charger-status text does. */
function splitCsvRow(row: string): string[] {
  return row
    .match(/("([^"]|"")*"|[^,]*)(,|$)/g)!
    .slice(0, -1)
    .map((c) => c.replace(/,$/, ''));
}

describe('shimmerFactoryTestReportToCsvRows', () => {
  const parsed = parseShimmerFactoryTestReport(S3R_MAIN_REPORT);

  it('emits a header and a value row of equal width, meta columns first', () => {
    const meta = { device: 'Shimmer3R', link: 'ble', finished_at: '2026-09-03T14:22:42.000Z' };
    const rows = shimmerFactoryTestReportToCsvRows(parsed, meta);
    expect(rows).toHaveLength(2);
    const header = splitCsvRow(rows[0]);
    expect(header.slice(0, 3)).toEqual(['device', 'link', 'finished_at']);
    expect(header).toContain('vref_mv');
    expect(header).toContain('overall_result');
    expect(header).toHaveLength(Object.keys(meta).length + Object.keys(parsed.metrics).length);
    expect(splitCsvRow(rows[1])).toHaveLength(header.length);
    expect(new Set(header).size).toBe(header.length);
  });

  it('escapes a cell containing a comma', () => {
    const rows = shimmerFactoryTestReportToCsvRows(parsed);
    const header = rows[0].split(',');
    // The charger status is a quoted, comma-bearing string from the firmware.
    expect(rows[1]).toContain('"Pre-qualification mode, CC and CV charging, or Top-off mode"');
    expect(header).toContain('charger_chip_status');
  });

  it('is the shared writer, so both families produce the same row shape', () => {
    expect(shimmerFactoryTestReportToCsvRows(parsed, { a: 1 })[0]).toBe(
      factoryTestReportToCsvRows(parsed, { a: 1 })[0],
    );
  });

  it('tolerates a null parse from plain-JS callers', () => {
    const rows = shimmerFactoryTestReportToCsvRows(
      null as unknown as ReturnType<typeof parseShimmerFactoryTestReport>,
      { device: 'Shimmer3' },
    );
    expect(rows).toEqual(['device', 'Shimmer3']);
  });
});

describe('the Verisense parser is unchanged by the shared core', () => {
  it('still parses its own reports through the shared parser', () => {
    // The byte-identical guarantee lives in tests/verisense; this asserts only
    // that the Verisense entry point survived the move and that the two
    // grammars stay out of each other's way.
    const verisense = parseVerisenseFactoryTestReport(SR68_REPORT);
    expect(verisense.overall.failedTestNames).toEqual(['battery', 'ppg_afe']);
    expect(verisense.idScheme).toBe('v2_00_010');
    expect(verisense.unparsedLines).toEqual([]);
    // No Shimmer name leaked into the Verisense classification.
    expect(verisense.tests.map((t) => t.name)).not.toContain('lse_crystal');
  });
});
