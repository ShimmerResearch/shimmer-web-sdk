import { describe, it, expect } from 'vitest';
import {
  parseVerisenseFactoryTestReport,
  verisenseFactoryTestReportToCsvRows,
} from '../../src/devices/verisense/factoryTestReport.js';

/** Join fixture lines with CRLF, as the firmware emits them. */
const crlf = (lines: string[]): string => lines.join('\r\n') + '\r\n';

/**
 * The annotated SR68-9-0 bench report from
 * `verisense-firmware/docs/VERISENSE_FACTORY_TEST_REPORT.md` §2, annotations
 * removed. Battery fails (no cell fitted) and the PPG AFE is absent, giving
 * the documented `0x00000840` mask.
 */
const SR68_REPORT = crlf([
  '//*************************** TEST START ***********************************//',
  'Firmware version: v2.00.024',
  'INFO: Temperature pass range set to 10-40° C',
  '',
  'MCU:',
  ' - MAC ID: D3E73E4795BC',
  '   Device ID: 0x736FE67FC7AC4A35',
  '   Part: 00052840, Variant: AAD0',
  '   Last reset: 0x00 (power-on/brownout), boot count = 57',
  ' - WS_TEST_0001 - PASS: VCore = 1819mV (1750-1850mV)',
  ' - WS_TEST_0002 - PASS: Temperature = 25° C',
  ' - WS_TEST_0003 - WARNING: LF crystal error = +42.1 ppm (+3.6 s/day) - expected for this hardware revision (undersized crystal load caps), not a fault (warn limit +/-100.0 ppm, LFCLK src=Xtal)',
  'I/O status:',
  ' - WS_TEST_0004 - USB power good: Yes',
  '',
  'TWIM1 (part 1):',
  ' - WS_TEST_0005 - PASS: CAT24M01 EEPROM',
  '',
  'Shimmer model:',
  ' - WS_TEST_0006 - PASS',
  '      Name: Verisense Pulse+ (SR68-9-0)',
  '      Manufacturing Order|MAC: 25112101|95BC',
  '      Advertising Prefix: Verisense',
  '      Passkey ID: 00 (No Passkey)',
  '',
  'Battery:',
  ' - WS_TEST_0007 - FAIL: VBatt = 483mV (3700-4400mV)',
  ' - WS_TEST_0008 - Charger status: Charging complete',
  '',
  'TWIM1 (part2):',
  ' - WS_TEST_0009 - PASS: VD6283TX Light sensor (350.0 Lux, CCT: 3933 K) (Flicker: 100.0 Hz, 12% mod)',
  ' - WS_TEST_0010 - PASS: MLX90640 Thermal sensor (Ambient = 26° C, Object = 26° C)',
  'TWIM0:',
  ' - WS_TEST_0011 - PASS: MAX32674C Algorithm hub detected (v50.4.4)',
  ' - WS_TEST_0012 - FAIL: MAX86176 Pulse oximeter - Chip not detected',
  ' - WS_TEST_0013 - PASS: LIS2DW12 Accelerometer (25° C)',
  '',
  'SPIM2:',
  ' - WS_TEST_0014 - PASS: LSM6DSV (25° C)',
  '',
  'Overall Result = FAIL (0x00000840)',
  '//**************************** TEST END *********************************//',
]);

/**
 * The captured SR61-5-0 report from
 * `verisense-firmware/docs/VERISENSE_COMMUNICATION_PROTOCOL.md`. Note it
 * carries no `Firmware version:` line — older captures predate it.
 */
const SR61_REPORT = crlf([
  '//**************************** TEST START ************************************//',
  'INFO: Temperature pass range set to 10-40° C',
  '',
  'MCU:',
  ' - MAC ID: CC8B6F80DE63',
  '   Device ID: 0x48EEEE365C9ABEEB',
  '   Part: 00052840, Variant: AAD0',
  '   Last reset: 0x00 (power-on/brownout), boot count = 57',
  ' - WS_TEST_0001 - PASS: VCore = 1801mV (1750-1850mV)',
  ' - WS_TEST_0002 - PASS: Temperature = 25° C',
  ' - WS_TEST_0003 - PASS: LF crystal error = +3.1 ppm (limit +/-25.0 ppm, LFCLK src=Xtal)',
  'I/O status:',
  ' - WS_TEST_0004 - USB power good: Yes',
  '',
  'TWIM1 (part 1):',
  ' - WS_TEST_0005 - PASS: CAT24M01 EEPROM',
  '',
  'Shimmer model:',
  ' - WS_TEST_0006 - PASS',
  '      Name: Verisense IMU (SR61-5-0)',
  '      Manufacturing Order|MAC: 26011401|DE63',
  '      Advertising Prefix: Verisense',
  '      Passkey ID: 00 (No Passkey)',
  '      Passkey: 0xFFFFFFFFFFFF',
  '',
  'Battery:',
  ' - WS_TEST_0007 - PASS: VBatt = 4115mV (3700-4400mV)',
  ' - WS_TEST_0009 - PASS: VD6283TX Light sensor (70.0 Lux, CCT: 2964 K)',
  ' - WS_TEST_0010 - MLX90640 Thermal sensor test not applicable for this model',
  'TWIM0:',
  ' - WS_TEST_0011 - MAX32674C Algorithm hub not applicable for this model',
  ' - WS_TEST_0012 - MAX86176 Pulse oximeter not applicable for this model',
  ' - WS_TEST_0013 - LIS2DW12 Accelerometer not applicable for this model',
  '',
  'SPIM2:',
  ' - WS_TEST_0014 - PASS: LSM6DSV (25° C)',
  ' - WS_TEST_0015 - PASS: LIS2MDL (24° C)',
  'SPIM3:',
  ' - WS_TEST_0016 - PASS: Main flash test',
  '      Manufacturer = TOSHIBA',
  '      Model = TC58CYG2S0HRAIJ',
  '      Size = 512 MB',
  ' - WS_TEST_0017 - STF1 Flash test not applicable for this model',
  ' - WS_TEST_0018 - STF2 Flash test not applicable for this model',
  '',
  'Overall Result = PASS',
  '//***************************** TEST END *************************************//',
]);

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
  // Pre-v2.00.010 numbering: USB power good was 0003, EEPROM 0004, battery
  // 0006. Keying on content must still land the values in the right columns.
  const legacy = crlf([
    '//*** TEST START ***//',
    'Firmware version: v2.00.009',
    'MCU:',
    ' - WS_TEST_0001 - PASS: VCore = 1801mV (1750-1850mV)',
    ' - WS_TEST_0002 - PASS: Temperature = 25° C',
    'I/O status:',
    ' - WS_TEST_0003 - USB power good: Yes',
    'TWIM1 (part 1):',
    ' - WS_TEST_0004 - PASS: CAT24M01 EEPROM',
    'Battery:',
    ' - WS_TEST_0006 - FAIL: VBatt = 483mV (3700-4400mV)',
    'Overall Result = FAIL (0x00000020)',
    '//*** TEST END ***//',
  ]);

  it('detects the legacy numbering scheme', () => {
    expect(parseVerisenseFactoryTestReport(legacy).idScheme).toBe('legacy');
  });

  it('puts values in content-derived columns despite the shifted ids', () => {
    const parsed = parseVerisenseFactoryTestReport(legacy);
    // Id 0003 is the LF crystal test under the new numbering; here it is USB.
    expect(parsed.metrics.usb_power_good).toBe(true);
    expect(parsed.metrics.lfclk_ppm).toBeUndefined();
    expect(parsed.metrics.eeprom_result).toBe('PASS');
    expect(parsed.metrics.vbatt_mv).toBe(483);
  });

  it('decodes the fail mask through the ids this report actually used', () => {
    // Bit 5 => id 6, which is the battery test in the legacy numbering.
    expect(parseVerisenseFactoryTestReport(legacy).overall.failedTestNames).toEqual(['battery']);
  });
});

describe('parseVerisenseFactoryTestReport - firmware quirks', () => {
  it('parses the shortened WS_TEST_0003 WARNING wording', () => {
    // The WARNING text was cut down so it fits the firmware's 128-byte report
    // buffer (the long version lost its CRLF and glued the next line on). The
    // warn limit stays in the line; the ppm/s-day figures and limit all parse.
    const shortened = crlf([
      '//*** TEST START ***//',
      ' - WS_TEST_0003 - WARNING: LF crystal error = +49.3 ppm (+4.2 s/day) - expected for this HW rev (warn limit +/-100.0 ppm, LFCLK src=Xtal)',
      '//*** TEST END ***//',
    ]);
    const parsed = parseVerisenseFactoryTestReport(shortened);
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
    const glued = crlf([
      '//*** TEST START ***//',
      ' - WS_TEST_0001 - PASS: VCore = 1819mV (1750-1850mV)',
      ' - WS_TEST_0002 - PASS: Temperature = 29° C',
      ' - WS_TEST_0003 - WARNING: LF crystal error = +49.3 ppm (+4.2 s/day) - expected for this hardware revision (undersized crystal load caps), not a I/O status:',
      ' - WS_TEST_0004 - USB power good: Yes',
      '//*** TEST END ***//',
    ]);
    const parsed = parseVerisenseFactoryTestReport(glued);
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
    const glued = crlf([
      '//*** TEST START ***//',
      ' - WS_TEST_0017 - PASS: STF1 Flash test - WS_TEST_0018 - PASS: STF2 Flash test',
      '//*** TEST END ***//',
    ]);
    const parsed = parseVerisenseFactoryTestReport(glued);
    expect(parsed.metrics.stf1_result).toBe('PASS');
    expect(parsed.metrics.stf2_result).toBe('PASS');
  });

  it('strips NAND health progress dots and reads the health counters', () => {
    const withDots = crlf([
      '//*** TEST START ***//',
      'SPIM3:',
      ' - WS_TEST_0016 - PASS: Main flash test',
      '      Manufacturer = TOSHIBA',
      '      Model = TC58CYG2S0HRAIJ',
      '      Size = 512 MB',
      '      NAND health: testing........................',
      '..........',
      ' - WS_TEST_0021 - PASS: NAND health test',
      '      Bad-block census = 3 of 2048 (limit 40)',
      '      Stress = 16 blocks / 1024 page checks (0 sampled blocks skipped bad)',
      '      Corrupt pages = 0, unstable pages = 0, erase/write fails = 0/0',
      '//*** TEST END ***//',
    ]);
    const parsed = parseVerisenseFactoryTestReport(withDots);
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
    const withLeds = crlf([
      '//*** TEST START ***//',
      'LED test (WS_TEST_0019):',
      ' - All LEDs off',
      ' - Left Red LED on',
      ' - Left Green LED on',
      'LED test (WS_TEST_0020):',
      ' - Right Red LED on',
      ' - All LEDs off',
      ' - WS_TEST_0001 - PASS: VCore = 1819mV (1750-1850mV)',
      'Overall Result = PASS',
      '//*** TEST END ***//',
    ]);
    const parsed = parseVerisenseFactoryTestReport(withLeds);
    expect(parsed.metrics.led_status_result).toBeUndefined();
    expect(parsed.metrics.led_batt_result).toBeUndefined();
    // The structured entries keep the narration and verdicts.
    const ledStatus = parsed.tests.find((t) => t.name === 'led_status');
    expect(ledStatus?.verdict).toBe('INFO');
    expect(ledStatus?.detail).toContain('Left Red LED on');
    // A model-gated LED test still records NOT_APPLICABLE.
    const gated = parseVerisenseFactoryTestReport(
      crlf([
        '//*** TEST START ***//',
        ' - WS_TEST_0019 - RGB LED test not applicable for this model',
        '//*** TEST END ***//',
      ]),
    );
    expect(gated.metrics.led_status_result).toBe('NOT_APPLICABLE');
    expect(parsed.unparsedLines).toEqual([]);
  });

  it('reads the NAND health WARNING (skipped, flash not erased) as its own tier', () => {
    const skipped = crlf([
      '//*** TEST START ***//',
      ' - WS_TEST_0021 - WARNING: NAND health test skipped - needs fully erased flash (erase all logged data first)',
      '//*** TEST END ***//',
    ]);
    expect(parseVerisenseFactoryTestReport(skipped).metrics.nand_health_result).toBe('WARNING');
  });

  it('handles every way the degree sign can reach us', () => {
    const variants = ['25° C', '25Â° C', '25� C'];
    for (const variant of variants) {
      const parsed = parseVerisenseFactoryTestReport(
        crlf([
          '//*** TEST START ***//',
          ` - WS_TEST_0002 - PASS: Temperature = ${variant}`,
          '//*** TEST END ***//',
        ]),
      );
      expect(parsed.metrics.mcu_temp_c).toBe(25);
    }
  });

  it('keeps a report that aborts at the model test', () => {
    // A blank board fails production config, which ends the run early.
    const aborted = crlf([
      '//*** TEST START ***//',
      'Firmware version: v2.00.024',
      'Shimmer model:',
      ' - WS_TEST_0006 - FAIL: production config not set',
    ]);
    const parsed = parseVerisenseFactoryTestReport(aborted);
    expect(parsed.ok).toBe(true);
    expect(parsed.complete).toBe(false);
    expect(parsed.overall.result).toBeNull();
    expect(parsed.metrics.model_result).toBe('FAIL');
    expect(parsed.firmwareVersion).toBe('2.00.024');
  });
});

describe('parseVerisenseFactoryTestReport - forward compatibility', () => {
  it('captures an unknown future test rather than dropping it', () => {
    const future = crlf([
      '//*** TEST START ***//',
      ' - WS_TEST_0027 - PASS: Widget check (Foo = 12 bar)',
      '//*** TEST END ***//',
    ]);
    const parsed = parseVerisenseFactoryTestReport(future);
    const test = parsed.tests.find((t) => t.id === 27);
    expect(test?.name).toBe('ws_test_0027');
    expect(test?.verdict).toBe('PASS');
    expect(parsed.metrics.ws_test_0027_result).toBe('PASS');
    expect(parsed.metrics.ws_test_0027_foo).toBe(12);
  });

  it('preserves unrecognized lines instead of failing', () => {
    const odd = crlf([
      '//*** TEST START ***//',
      'Some brand new section nobody has seen',
      '//*** TEST END ***//',
    ]);
    const parsed = parseVerisenseFactoryTestReport(odd);
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
