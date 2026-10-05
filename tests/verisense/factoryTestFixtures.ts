/**
 * Verisense factory-test report fixtures, held apart from the assertions so the
 * behavioural suite and the snapshot suite pin exactly the same bytes.
 *
 * Every string here is a report the firmware has actually printed (or a
 * deliberately malformed variant of one); the parser is refactored against
 * them, so they are the contract, not a convenience.
 */

/** Join fixture lines with CRLF, as the firmware emits them. */
export const crlf = (lines: string[]): string => lines.join('\r\n') + '\r\n';

/**
 * The annotated SR68-9-0 bench report from
 * `verisense-firmware/docs/VERISENSE_FACTORY_TEST_REPORT.md` §2, annotations
 * removed. Battery fails (no cell fitted) and the PPG AFE is absent, giving
 * the documented `0x00000840` mask.
 */
export const SR68_REPORT = crlf([
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
export const SR61_REPORT = crlf([
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

/**
 * Pre-v2.00.010 numbering: USB power good was 0003, EEPROM 0004, battery 0006.
 * Keying on content must still land the values in the right columns.
 */
export const LEGACY_NUMBERING_REPORT = crlf([
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

/**
 * The shortened WS_TEST_0003 WARNING wording. The text was cut down so it fits
 * the 128-byte report buffer; the warn limit stays in the line.
 */
export const SHORTENED_LF_WARNING_REPORT = crlf([
  '//*** TEST START ***//',
  ' - WS_TEST_0003 - WARNING: LF crystal error = +49.3 ppm (+4.2 s/day) - expected for this HW rev (warn limit +/-100.0 ppm, LFCLK src=Xtal)',
  '//*** TEST END ***//',
]);

/**
 * Verbatim capture from a unit running the pre-shortening firmware: the WARNING
 * text overran the shared 128-byte buffer, losing its CRLF, so the next section
 * header ran straight on.
 */
export const GLUED_WARNING_REPORT = crlf([
  '//*** TEST START ***//',
  ' - WS_TEST_0001 - PASS: VCore = 1819mV (1750-1850mV)',
  ' - WS_TEST_0002 - PASS: Temperature = 29° C',
  ' - WS_TEST_0003 - WARNING: LF crystal error = +49.3 ppm (+4.2 s/day) - expected for this hardware revision (undersized crystal load caps), not a I/O status:',
  ' - WS_TEST_0004 - USB power good: Yes',
  '//*** TEST END ***//',
]);

/** Two test lines glued into one physical line. */
export const GLUED_TEST_LINES_REPORT = crlf([
  '//*** TEST START ***//',
  ' - WS_TEST_0017 - PASS: STF1 Flash test - WS_TEST_0018 - PASS: STF2 Flash test',
  '//*** TEST END ***//',
]);

/** NAND health test with its bare progress dots and health counters. */
export const NAND_HEALTH_DOTS_REPORT = crlf([
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

/** Two LED test blocks of operator-visual narration. */
export const LED_NARRATION_REPORT = crlf([
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

/** A model-gated LED test, which arrives on the id path rather than a heading. */
export const GATED_LED_REPORT = crlf([
  '//*** TEST START ***//',
  ' - WS_TEST_0019 - RGB LED test not applicable for this model',
  '//*** TEST END ***//',
]);

/** NAND health skipped because the flash was not fully erased. */
export const NAND_HEALTH_SKIPPED_REPORT = crlf([
  '//*** TEST START ***//',
  ' - WS_TEST_0021 - WARNING: NAND health test skipped - needs fully erased flash (erase all logged data first)',
  '//*** TEST END ***//',
]);

/** A report that aborts at the model test, as a blank board does. */
export const ABORTED_MODEL_REPORT = crlf([
  '//*** TEST START ***//',
  'Firmware version: v2.00.024',
  'Shimmer model:',
  ' - WS_TEST_0006 - FAIL: production config not set',
]);

/** A test id this build of the SDK has never seen. */
export const FUTURE_TEST_REPORT = crlf([
  '//*** TEST START ***//',
  ' - WS_TEST_0027 - PASS: Widget check (Foo = 12 bar)',
  '//*** TEST END ***//',
]);

/** A section no rule recognizes, which must be preserved rather than dropped. */
export const UNRECOGNIZED_LINE_REPORT = crlf([
  '//*** TEST START ***//',
  'Some brand new section nobody has seen',
  '//*** TEST END ***//',
]);

/**
 * Every way the degree sign can reach us: UTF-8, the mojibake from a latin1
 * decode of UTF-8, and the Unicode replacement character.
 */
export const DEGREE_VARIANTS = ['25° C', '25Â° C', '25� C'];

/** One temperature report per degree-sign encoding, in `DEGREE_VARIANTS` order. */
export const DEGREE_VARIANT_REPORTS: string[] = DEGREE_VARIANTS.map((variant) =>
  crlf([
    '//*** TEST START ***//',
    ` - WS_TEST_0002 - PASS: Temperature = ${variant}`,
    '//*** TEST END ***//',
  ]),
);
