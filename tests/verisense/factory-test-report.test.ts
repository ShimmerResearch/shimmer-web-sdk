import { describe, it, expect } from 'vitest';
import {
  parseVerisenseFactoryTestReport,
  verisenseFactoryTestReportToCsvRows,
} from '../../src/devices/verisense/factoryTestReport.js';
import {
  ABORTED_MODEL_REPORT,
  DEGREE_VARIANT_REPORTS,
  FUTURE_TEST_REPORT,
  GATED_LED_REPORT,
  GLUED_TEST_LINES_REPORT,
  GLUED_WARNING_REPORT,
  LED_NARRATION_REPORT,
  LEGACY_NUMBERING_REPORT,
  NAND_HEALTH_DOTS_REPORT,
  NAND_HEALTH_SKIPPED_REPORT,
  SHORTENED_LF_WARNING_REPORT,
  SR61_REPORT,
  SR68_REPORT,
  UNRECOGNIZED_LINE_REPORT,
} from './factoryTestFixtures.js';

describe('parseVerisenseFactoryTestReport - SR68 reference report', () => {
  const parsed = parseVerisenseFactoryTestReport(SR68_REPORT);

  it('recognizes the banners and firmware version', () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.complete).toBe(true);
    expect(parsed.firmwareVersion).toBe('2.00.024');
    expect(parsed.idScheme).toBe('v2_00_010');
  });

  it('extracts the documented overall result and decodes the fail mask', () => {
    expect(parsed.overall.result).toBe('FAIL');
    expect(parsed.overall.failMaskHex).toBe('0x00000840');
    // Bits 6 and 11 => WS_TEST_0007 (battery) and WS_TEST_0012 (PPG AFE).
    expect(parsed.overall.failedTestNames).toEqual(['battery', 'ppg_afe']);
  });

  it('extracts MCU header fields', () => {
    expect(parsed.mcu.macId).toBe('D3E73E4795BC');
    // The full BLE MAC is deliberately NOT named mac_id: callers pass the
    // production config's 4-hex suffix under that name as a meta column.
    expect(parsed.metrics.ble_mac).toBe('D3E73E4795BC');
    expect(parsed.metrics.mac_id).toBeUndefined();
    expect(parsed.mcu.deviceId).toBe('0x736FE67FC7AC4A35');
    expect(parsed.mcu.part).toBe('00052840');
    expect(parsed.mcu.variant).toBe('AAD0');
    expect(parsed.mcu.bootCount).toBe(57);
    expect(parsed.metrics.last_reset_hex).toBe('0x00');
  });

  it('extracts numeric metrics with their limits', () => {
    expect(parsed.metrics.vcore_mv).toBe(1819);
    expect(parsed.metrics.vcore_limit_low_mv).toBe(1750);
    expect(parsed.metrics.vcore_limit_high_mv).toBe(1850);
    expect(parsed.metrics.mcu_temp_c).toBe(25);
    expect(parsed.metrics.vbatt_mv).toBe(483);
    expect(parsed.metrics.lux).toBe(350);
    expect(parsed.metrics.cct_k).toBe(3933);
    expect(parsed.metrics.flicker_hz).toBe(100);
    expect(parsed.metrics.flicker_mod_pct).toBe(12);
    expect(parsed.metrics.flicker_status).toBe('detected');
    expect(parsed.metrics.mlx_ambient_c).toBe(26);
    expect(parsed.metrics.mlx_object_c).toBe(26);
    expect(parsed.metrics.hub_fw_version).toBe('50.4.4');
    expect(parsed.metrics.accel2_temp_c).toBe(25);
    expect(parsed.metrics.imu_temp_c).toBe(25);
  });

  it('treats the LF crystal WARNING as its own verdict tier', () => {
    expect(parsed.metrics.lfclk_result).toBe('WARNING');
    expect(parsed.metrics.lfclk_ppm).toBe(42.1);
    expect(parsed.metrics.lfclk_s_per_day).toBe(3.6);
    expect(parsed.metrics.lfclk_limit_ppm).toBe(100);
    expect(parsed.metrics.lfclk_src).toBe('Xtal');
  });

  it('omits the battery percentage when the report does not print one', () => {
    expect(parsed.metrics.batt_pct).toBeUndefined();
  });

  it('extracts the production-config block', () => {
    expect(parsed.model?.name).toBe('Verisense Pulse+');
    expect(parsed.model?.srRevision).toBe('SR68-9-0');
    expect(parsed.model?.manufacturingOrder).toBe('25112101');
    expect(parsed.model?.macSuffix).toBe('95BC');
    expect(parsed.model?.passkeyKind).toBe('No Passkey');
  });

  it('records a verdict column for every decided test', () => {
    expect(parsed.metrics.vbatt_result).toBe('FAIL');
    expect(parsed.metrics.ppg_afe_result).toBe('FAIL');
    expect(parsed.metrics.ppg_afe_fail_reason).toBe('Chip not detected');
    expect(parsed.metrics.usb_power_good).toBe(true);
    expect(parsed.metrics.charger_status).toBe('Charging complete');
  });

  it('does not spend columns on INFO verdicts - their data has its own columns', () => {
    expect(parsed.metrics.usb_power_result).toBeUndefined();
    expect(parsed.metrics.charger_result).toBeUndefined();
    // The verdict itself is still available on the structured test entries.
    expect(parsed.tests.find((t) => t.name === 'charger')?.verdict).toBe('INFO');
  });

  it('leaves nothing unrecognized', () => {
    expect(parsed.unparsedLines).toEqual([]);
  });
});

describe('parseVerisenseFactoryTestReport - SR61 reference report', () => {
  const parsed = parseVerisenseFactoryTestReport(SR61_REPORT);

  it('parses a passing report with no firmware version line', () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.complete).toBe(true);
    expect(parsed.overall.result).toBe('PASS');
    expect(parsed.overall.failMask).toBeNull();
    expect(parsed.firmwareVersion).toBeNull();
    expect(parsed.idScheme).toBe('unknown');
  });

  it('extracts main-flash geometry from the indented sub-lines', () => {
    expect(parsed.metrics.nand_manufacturer).toBe('TOSHIBA');
    expect(parsed.metrics.nand_model).toBe('TC58CYG2S0HRAIJ');
    expect(parsed.metrics.nand_size_mb).toBe(512);
  });

  it('marks model-gated tests as not applicable rather than failed', () => {
    expect(parsed.metrics.skin_temp_result).toBe('NOT_APPLICABLE');
    expect(parsed.metrics.hub_result).toBe('NOT_APPLICABLE');
    expect(parsed.metrics.stf1_result).toBe('NOT_APPLICABLE');
    expect(parsed.metrics.stf2_result).toBe('NOT_APPLICABLE');
  });

  it('never records the device passkey value', () => {
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain('0xFFFFFFFFFFFF');
  });

  it('leaves nothing unrecognized', () => {
    expect(parsed.unparsedLines).toEqual([]);
  });
});

describe('parseVerisenseFactoryTestReport - firmware version differences', () => {
  it('detects the legacy numbering scheme', () => {
    expect(parseVerisenseFactoryTestReport(LEGACY_NUMBERING_REPORT).idScheme).toBe('legacy');
  });

  it('puts values in content-derived columns despite the shifted ids', () => {
    const parsed = parseVerisenseFactoryTestReport(LEGACY_NUMBERING_REPORT);
    // Id 0003 is the LF crystal test under the new numbering; here it is USB.
    expect(parsed.metrics.usb_power_good).toBe(true);
    expect(parsed.metrics.lfclk_ppm).toBeUndefined();
    expect(parsed.metrics.eeprom_result).toBe('PASS');
    expect(parsed.metrics.vbatt_mv).toBe(483);
  });

  it('decodes the fail mask through the ids this report actually used', () => {
    // Bit 5 => id 6, which is the battery test in the legacy numbering.
    expect(
      parseVerisenseFactoryTestReport(LEGACY_NUMBERING_REPORT).overall.failedTestNames,
    ).toEqual(['battery']);
  });
});

describe('parseVerisenseFactoryTestReport - firmware quirks', () => {
  it('parses the shortened WS_TEST_0003 WARNING wording', () => {
    // The WARNING text was cut down so it fits the firmware's 128-byte report
    // buffer (the long version lost its CRLF and glued the next line on). The
    // warn limit stays in the line; the ppm/s-day figures and limit all parse.
    const parsed = parseVerisenseFactoryTestReport(SHORTENED_LF_WARNING_REPORT);
    expect(parsed.metrics.lfclk_result).toBe('WARNING');
    expect(parsed.metrics.lfclk_ppm).toBe(49.3);
    expect(parsed.metrics.lfclk_s_per_day).toBe(4.2);
    expect(parsed.metrics.lfclk_src).toBe('Xtal');
    expect(parsed.metrics.lfclk_limit_ppm).toBe(100);
    expect(parsed.unparsedLines).toEqual([]);
  });

  it('repairs a WARNING line truncated by the 128-byte firmware buffer', () => {
    // Verbatim capture from a unit running the pre-shortening firmware: the
    // WARNING text overran the shared buffer, losing its CRLF, so the next
    // section header ran straight on. Reports from those builds still exist,
    // so this must keep parsing.
    const parsed = parseVerisenseFactoryTestReport(GLUED_WARNING_REPORT);
    expect(parsed.metrics.vcore_mv).toBe(1819);
    expect(parsed.metrics.mcu_temp_c).toBe(29);
    expect(parsed.metrics.lfclk_ppm).toBe(49.3);
    expect(parsed.metrics.lfclk_s_per_day).toBe(4.2);
    expect(parsed.metrics.lfclk_result).toBe('WARNING');
    expect(parsed.metrics.usb_power_good).toBe(true);
    expect(parsed.unparsedLines).toEqual([]);
    expect(parsed.parserWarnings.join(' ')).toMatch(/repaired/i);
  });

  it('splits two test lines glued into one', () => {
    const parsed = parseVerisenseFactoryTestReport(GLUED_TEST_LINES_REPORT);
    expect(parsed.metrics.stf1_result).toBe('PASS');
    expect(parsed.metrics.stf2_result).toBe('PASS');
  });

  it('strips NAND health progress dots and reads the health counters', () => {
    const parsed = parseVerisenseFactoryTestReport(NAND_HEALTH_DOTS_REPORT);
    expect(parsed.metrics.nand_health_result).toBe('PASS');
    expect(parsed.metrics.nand_bad_blocks).toBe(3);
    expect(parsed.metrics.nand_bad_block_total).toBe(2048);
    expect(parsed.metrics.nand_bad_block_limit).toBe(40);
    expect(parsed.metrics.nand_stress_blocks).toBe(16);
    expect(parsed.metrics.nand_page_checks).toBe(1024);
    expect(parsed.metrics.nand_blocks_skipped).toBe(0);
    expect(parsed.metrics.nand_corrupt_pages).toBe(0);
    expect(parsed.metrics.nand_unstable_pages).toBe(0);
    expect(parsed.metrics.nand_erase_write_fails).toBe('0/0');
    expect(parsed.unparsedLines).toEqual([]);
  });

  it('keeps LED narration out of the metrics map', () => {
    // The LED tests are operator-visual: the report just narrates the steps.
    // "Test all" runs them on every unit, so an INFO column per LED test would
    // be pure noise — which suite ran is already recorded by the caller.
    const parsed = parseVerisenseFactoryTestReport(LED_NARRATION_REPORT);
    expect(parsed.metrics.led_status_result).toBeUndefined();
    expect(parsed.metrics.led_batt_result).toBeUndefined();
    // The structured entries keep the narration and verdicts.
    const ledStatus = parsed.tests.find((t) => t.name === 'led_status');
    expect(ledStatus?.verdict).toBe('INFO');
    expect(ledStatus?.detail).toContain('Left Red LED on');
    // A model-gated LED test still records NOT_APPLICABLE.
    const gated = parseVerisenseFactoryTestReport(GATED_LED_REPORT);
    expect(gated.metrics.led_status_result).toBe('NOT_APPLICABLE');
    expect(parsed.unparsedLines).toEqual([]);
  });

  it('reads the NAND health WARNING (skipped, flash not erased) as its own tier', () => {
    expect(
      parseVerisenseFactoryTestReport(NAND_HEALTH_SKIPPED_REPORT).metrics.nand_health_result,
    ).toBe('WARNING');
  });

  it('handles every way the degree sign can reach us', () => {
    for (const report of DEGREE_VARIANT_REPORTS) {
      const parsed = parseVerisenseFactoryTestReport(report);
      expect(parsed.metrics.mcu_temp_c).toBe(25);
    }
  });

  it('keeps a report that aborts at the model test', () => {
    // A blank board fails production config, which ends the run early.
    const parsed = parseVerisenseFactoryTestReport(ABORTED_MODEL_REPORT);
    expect(parsed.ok).toBe(true);
    expect(parsed.complete).toBe(false);
    expect(parsed.overall.result).toBeNull();
    expect(parsed.metrics.model_result).toBe('FAIL');
    expect(parsed.firmwareVersion).toBe('2.00.024');
  });
});

describe('parseVerisenseFactoryTestReport - forward compatibility', () => {
  it('captures an unknown future test rather than dropping it', () => {
    const parsed = parseVerisenseFactoryTestReport(FUTURE_TEST_REPORT);
    const test = parsed.tests.find((t) => t.id === 27);
    expect(test?.name).toBe('ws_test_0027');
    expect(test?.verdict).toBe('PASS');
    expect(parsed.metrics.ws_test_0027_result).toBe('PASS');
    expect(parsed.metrics.ws_test_0027_foo).toBe(12);
  });

  it('preserves unrecognized lines instead of failing', () => {
    const parsed = parseVerisenseFactoryTestReport(UNRECOGNIZED_LINE_REPORT);
    expect(parsed.ok).toBe(true);
    expect(parsed.unparsedLines).toContain('Some brand new section nobody has seen');
  });

  it('never throws on empty or garbage input', () => {
    for (const input of ['', '   ', 'not a report at all', ' binary']) {
      const parsed = parseVerisenseFactoryTestReport(input);
      expect(parsed.ok).toBe(false);
      expect(parsed.overall.result).toBeNull();
    }
    // Defensive: the signature is typed, but callers are plain JS.
    expect(() => parseVerisenseFactoryTestReport(undefined as unknown as string)).not.toThrow();
  });
});

describe('verisenseFactoryTestReportToCsvRows', () => {
  it('emits a header and a value row of equal width', () => {
    const parsed = parseVerisenseFactoryTestReport(SR68_REPORT);
    const rows = verisenseFactoryTestReportToCsvRows(parsed, {
      mo: '25112101',
      finished_at: '2026-08-13T10:00:00.000Z',
    });
    expect(rows).toHaveLength(2);
    const header = rows[0].split(',');
    expect(header.slice(0, 2)).toEqual(['mo', 'finished_at']);
    expect(header).toContain('vcore_mv');
    expect(rows[1].split(',')).toHaveLength(header.length);
  });

  it('escapes cells containing commas', () => {
    const parsed = parseVerisenseFactoryTestReport(SR68_REPORT);
    const rows = verisenseFactoryTestReportToCsvRows(parsed, { note: 'a,b' });
    expect(rows[1]).toContain('"a,b"');
  });

  it('tolerates a null parse from plain-JS callers', () => {
    const rows = verisenseFactoryTestReportToCsvRows(
      null as unknown as ReturnType<typeof parseVerisenseFactoryTestReport>,
      { mo: '25112101' },
    );
    expect(rows).toEqual(['mo', '25112101']);
  });

  it('never emits duplicate column names - meta wins a collision', () => {
    const parsed = parseVerisenseFactoryTestReport(SR68_REPORT);
    const rows = verisenseFactoryTestReportToCsvRows(parsed, {
      mac_id: '95BC',
      vcore_mv: 'meta-wins',
    });
    const header = rows[0].split(',');
    expect(new Set(header).size).toBe(header.length);
    expect(header.filter((h) => h === 'mac_id')).toHaveLength(1);
    expect(header).toContain('ble_mac'); // full BLE MAC keeps its own column
    const values = rows[1].split(',');
    expect(values[header.indexOf('vcore_mv')]).toBe('meta-wins');
  });
});
