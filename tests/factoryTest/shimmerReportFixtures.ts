/**
 * Shimmer3 and Shimmer3R factory-test report fixtures.
 *
 * Every line below is transcribed from the firmware that prints it, not from a
 * report captured off a bench unit:
 *
 * - envelope: `log-and-stream-common/Test/shimmer_test.c:22-61`
 * - Shimmer3R body and ordering: `Shimmer_Driver/hal_FactoryTest.c:337-1560`
 * - Shimmer3 (MSP430) body: `Shimmer_Driver/5xx_HAL/hal_FactoryTest.c:27-420`
 * - LED-state walk: `log-and-stream-common/Test/shimmer_test_leds_states.c:28-206`
 *
 * HARDWARE-VERIFY: the field *values* are plausible rather than observed — in
 * particular the Bluetooth module version banner, the SD card CID line and the
 * MCU id numbers are reconstructed from their `sprintf` formats. Replace them
 * with a real capture once one exists; the line *shapes* are what these tests
 * pin.
 */

/** Join fixture lines with CRLF, as the firmware emits them. */
export const crlf = (lines: string[]): string => lines.join('\r\n') + '\r\n';

/**
 * `ShimFactoryTest_sendReport` sends at most `MAX_TEST_REPORT_LENGTH` bytes of
 * a line, its CRLF included (`shimmer_test.c:69-80`), so a line that overruns
 * loses its terminator and whatever is written next runs straight on.
 */
export const MAX_TEST_REPORT_LENGTH = 128;

/** Apply that rule to one line, returning what actually reaches the host. */
export function truncateLikeFirmware(line: string): string {
  const withCrlf = `${line}\r\n`;
  return withCrlf.length > MAX_TEST_REPORT_LENGTH
    ? withCrlf.slice(0, MAX_TEST_REPORT_LENGTH)
    : withCrlf;
}

const S3R_START =
  '//**************************** TEST START ************************************//';
const S3R_END = '//***************************** TEST END *************************************//';

/** The LED walk, printed by `led_test()` for both the MAIN and LEDS suites. */
const S3R_LED_BLOCK = [
  'LED test (S3R_TEST_0027):',
  ' - All LEDs off',
  ' - Lower Red LED on',
  ' - Lower Green LED on',
  ' - Lower Blue LED on',
  ' - Upper Red LED on',
  ' - Upper Green LED on',
  ' - Upper Blue LED on',
  ' - All LEDs off',
  ' - All LEDs on',
];

/**
 * A Shimmer3R MAIN run with mixed verdicts.
 *
 * Three tests fail — the Bluetooth module firmware version (0014), the pressure
 * sensor (0017) and the second ExG chip (0021) — so the mask is
 * `0x00112000`: bits 13, 16 and 20, which are ids 14, 17 and 21. The GSR rig
 * WARNING is deliberately *not* in the mask, because a warning does not set a
 * bit. The ExG test prints one line per chip for what the mask counts as one
 * test, and the LED walk prints id 0027, which has no bit at all.
 */
export const S3R_MAIN_REPORT = crlf([
  S3R_START,
  'Firmware version: v1.01.012',
  'Date (yyyy-mm-dd): 2026-09-03',
  'Time (hh:mm:ss): 14:22:07 (UTC)',
  '',
  'INFO: Temperature pass range set to 10-40 degC',
  '',
  'Shimmer model:',
  ' - S3R_TEST_0003 - PASS: Shimmer3R (SR62-0-0)',
  '',
  'MCU:',
  ' - Device ID = 1313',
  ' - Revision ID = 4096',
  ' - Unique ID = 0x0033002A3438510C34333630',
  ' - S3R_TEST_0007 - PASS: VRef = 2497mV (2420-2580mV)',
  ' - S3R_TEST_0008 - PASS: VCore = 1210mV (1100-1300mV)',
  ' - S3R_TEST_0009 - PASS: VBatt pin = 2088mV (1800-2300mV)',
  ' - S3R_TEST_0010 - PASS: Temperature = 27 degC',
  ' - S3R_TEST_0028 - PASS: 32k LSE vs 16M HSE error = +14.2 ppm (limit +/-50.0 ppm, HSE-fixed caps rev)',
  ' - LSE drive applied at boot: MEDIUMLOW',
  ' - I/O status:',
  '    - Docked: No',
  '    - BT connected: Yes',
  '    - Button pressed: No',
  '    - USB connected: No',
  '',
  'Battery:',
  ' - S3R_TEST_0011 - PASS: VBatt = 4021mV (3300-4200mV)',
  " - S3R_TEST_0012 - PASS: Charger chip status = 'Pre-qualification mode, CC and CV charging, or Top-off mode'",
  ' - Determined charging status = Charging',
  '',
  'SD Card:',
  ' - Manufacturer: SanDisk, Manufacture Date=2023-05',
  ' - S3R_TEST_0013 - PASS: MCU read/write test',
  '',
  'BT Module:',
  ' - MAC ID: 0006666E9E42',
  ' - RN4678 V1.23.0 5/28/2019 (c) Microchip Technology Inc',
  ' - S3R_TEST_0014 - FAIL: Incorrect BT firmware version',
  '',
  'SPI1:',
  ' - S3R_TEST_0015 - ADS7028 test not applicable for this model',
  ' - S3R_TEST_0016 - PASS: LSM6DSV (24.37 degC)',
  ' - S3R_TEST_0017 - FAIL: BMP390 - Chip not detected',
  ' - S3R_TEST_0018 - ADXL371 test not applicable for this model',
  'SPI2:',
  ' - S3R_TEST_0019 - LIS3MDL test not applicable for this model',
  ' - S3R_TEST_0020 - PASS: LIS2DW12 (-3.50 degC)',
  'SPI3:',
  ' - S3R_TEST_0021 - PASS: ADS1292R Chip1 detect',
  ' - S3R_TEST_0021 - FAIL: ADS1292R Chip2 detect',
  '',
  'I2C1:',
  ' - S3R_TEST_0022 - PASS: LIS2MDL (24.51 degC)',
  ' - S3R_TEST_0023 - PASS: CAT24C16',
  'I2C4:',
  ' - S3R_TEST_0024 - PASS: I2C4',
  ' - S3R_TEST_0025 - WARNING: GSR - Correct test rig not detected',
  '',
  'Microphone:',
  ' - S3R_TEST_0026 - PASS',
  '',
  ...S3R_LED_BLOCK,
  '',
  'Overall Result = FAIL (0x00112000)',
  S3R_END,
]);

/**
 * The long Shimmer3R LSE line, at the length the firmware can actually print:
 * the recovery note carries two `uint32` counters, and with both saturated the
 * line runs past the 128-byte cap.
 */
export const S3R_LSE_LONG_LINE =
  ' - S3R_TEST_0028 - PASS: 32k LSE vs 16M HSE error = +14.2 ppm (limit +/-50.0 ppm, HSE-fixed caps rev, rec L4294967295 H4294967295)';

/**
 * A Shimmer3R MAIN run on a board whose Bluetooth module never came up and
 * whose LSE could not be measured.
 *
 * Exercises three shapes the happy-path report does not: the Bluetooth failure
 * printed with a dash instead of a colon (`FAIL - BT hasn't initialised`), a
 * chip test skipped for this model with no verdict word at all, and the
 * 128-byte truncation — `S3R_LSE_LONG_LINE` loses its CRLF, so the LSE drive
 * line that follows is glued onto its end and has to be split back out.
 */
export const S3R_BT_LSE_FAULT_REPORT =
  crlf([
    S3R_START,
    'Firmware version: v1.01.012',
    'Date (yyyy-mm-dd): 2026-09-03',
    'Time (hh:mm:ss): 09:04:41 (UTC)',
    '',
    'INFO: Temperature pass range set to 10-40 degC',
    '',
    'Shimmer model:',
    ' - S3R_TEST_0003 - FAIL: not set',
    '',
    'MCU:',
    ' - Device ID = 1313',
    ' - Revision ID = 4096',
    ' - Unique ID = 0x0033002A3438510C34333630',
    ' - S3R_TEST_0007 - PASS: VRef = 2497mV (2420-2580mV)',
    ' - S3R_TEST_0008 - PASS: VCore = 1210mV (1100-1300mV)',
    ' - S3R_TEST_0009 - PASS: VBatt pin = 2088mV (1800-2300mV)',
    ' - S3R_TEST_0010 - PASS: Temperature = 27 degC',
  ]) +
  truncateLikeFirmware(S3R_LSE_LONG_LINE) +
  crlf([
    ' - LSE drive applied at boot: NONE',
    ' - I/O status:',
    '    - Docked: Yes',
    '    - BT connected: No',
    '    - Button pressed: No',
    '    - USB connected: Yes',
    '',
    'BT Module:',
    " - S3R_TEST_0014 - FAIL - BT hasn't initialised",
    '',
    'SPI3:',
    ' - S3R_TEST_0021 - ADS1292R test not applicable for this model',
    '',
    'Microphone:',
    ' - S3R_TEST_0026 - FAIL: Test buffer is empty',
    '',
    'Overall Result = FAIL (0x02002004)',
    S3R_END,
  ]);

/**
 * The LEDS suite: the LED walk on its own, with no overall verdict — the
 * firmware only prints one for MAIN and ICS (`shimmer_test.c:42-54`).
 */
export const S3R_LEDS_REPORT = crlf([
  S3R_START,
  'Firmware version: v1.01.012',
  ...S3R_LED_BLOCK,
  S3R_END,
]);

/**
 * The LED_STATES suite, printed by shared code on both Shimmer boards. It walks
 * fifteen operating states for five seconds each so an operator can watch the
 * LEDs; there are no test numbers, no verdicts and no overall result.
 */
export const LED_STATES_REPORT = crlf([
  S3R_START,
  'Firmware version: v1.01.012',
  'Testing Operational LED states - Start',
  'BT Disabled:',
  '\t-> Idle...',
  '\t-> SD Logging...',
  'BT Enabled:',
  '\t-> Idle...',
  '\t-> SD Logging...',
  '\t-> BT Streaming...',
  '\t-> BT Streaming and SD Logging...',
  '\t-> BT Connected...',
  '\t-> BT Connected and SD Logging...',
  'SD Sync Enabled:',
  '\t-> Idle...',
  '\t-> SD Logging waiting for initial sync (slave)...',
  '\t-> SD Logging waiting for initial sync (master)...',
  '\t-> SD Logging and BT advertising...',
  '\t-> SD Logging and syncing...',
  'Other:',
  '\t-> Configuring...',
  '\t-> Time not set...',
  'Testing Operational LED states - End',
  S3R_END,
]);

/**
 * A passing Shimmer3 (MSP430) MAIN run.
 *
 * The MSP430 build prints no test numbers at all and never populates
 * `shimmerStatus.testResult`, so its report always ends `Overall Result = PASS`
 * however its lines read. The Bluetooth verdict is the bare ` - PASS` on its
 * own line, which carries no words for a content rule to key on.
 */
export const SHIMMER3_PASS_REPORT = crlf([
  S3R_START,
  'Firmware version: v0.16.011',
  'Shimmer model:',
  ' - PASS: Shimmer3 (SR31-6-0)',
  '',
  'MCU:',
  ' - Last reset reason = Brownout (BOR) (highest priority)',
  ' - I/O status:',
  '    - Docked: No',
  '    - BT connected: Yes',
  '    - Button pressed: No',
  '',
  'SD Card:',
  ' - PASS: SD card detected',
  ' - PASS: SD card read/write test',
  '',
  'BT Module:',
  ' - MAC ID: 0006666E9E42',
  ' - RN4678 V1.23.0 5/28/2019 (c) Microchip Technology Inc',
  ' - PASS',
  ' - Counts:',
  '   - BT data-rate test blockages = 0',
  '   - BT disconnects while streaming = 2',
  '   - BT RTS Lockups = 0',
  '   - BT unsolicited reboots = 1',
  '',
  'I2C:',
  ' - PASS: CAT24C16',
  ' - LSM303AH detected (self-test not implemented yet)',
  ' - MPU9x50 detected (self-test not implemented yet)',
  ' - BMP280 detected (self-test not implemented yet)',
  '',
  'SPI:',
  ' - PASS: ADS1292R Chip1 detect',
  ' - PASS: ADS1292R Chip2 detect',
  '',
  'LED test:',
  ' - All LEDs off',
  ' - Lower Green LED on',
  ' - Lower Yellow LED on',
  ' - Lower Red LED on',
  ' - Upper Green LED on',
  ' - Upper Blue LED on',
  ' - All LEDs off',
  ' - All LEDs on',
  '',
  'Overall Result = PASS',
  S3R_END,
]);

/**
 * A Shimmer3 run from the dock with a blank EEPROM, no SD card and no sensors
 * answering on I2C. The ExG test refuses to run over the dock link at all, and
 * that line — like the not-applicable one — is printed with no leading space.
 */
export const SHIMMER3_FAULT_REPORT = crlf([
  S3R_START,
  'Firmware version: v0.16.011',
  'Shimmer model:',
  ' - FAIL: not set',
  '',
  'MCU:',
  ' - Last reset reason = WDT time out (PUC)',
  ' - I/O status:',
  '    - Docked: Yes',
  '    - BT connected: No',
  '    - Button pressed: No',
  '',
  'SD Card:',
  ' - FAIL: SD Card not detected',
  '',
  'BT Module:',
  ' - MAC ID: 0006666E9E42',
  ' - RN4678 V1.22.0 5/28/2019 (c) Microchip Technology Inc',
  ' - FAIL: incorrect BT firmware version',
  ' - Counts:',
  '   - BT data-rate test blockages = 3',
  '   - BT disconnects while streaming = 0',
  '   - BT RTS Lockups = 1',
  '   - BT unsolicited reboots = 0',
  '',
  'I2C:',
  ' - FAIL: CAT24C16',
  ' - WARNING: No LSM303 chip detected',
  ' - FAIL: No Gyro chip detected',
  ' - FAIL: No BMPx80 detected',
  '',
  'SPI:',
  '- FAIL: ADS1292R test will not work from dock',
  '',
  'Overall Result = PASS',
  S3R_END,
]);

/**
 * Hypothetical: a Shimmer3-shaped report that *does* carry a fail mask.
 *
 * The shipped MSP430 firmware never sets one, so this pins the fallback rather
 * than a real capture — with no numbers printed, bits can only be matched to
 * tests by print order, and the parser says so in a warning.
 *
 * HARDWARE-VERIFY: if a future MSP430 build starts populating the mask, confirm
 * that its bit order really is print order before trusting these names.
 */
export const SHIMMER3_HYPOTHETICAL_MASK_REPORT = crlf([
  S3R_START,
  'Firmware version: v0.16.011',
  'SD Card:',
  ' - FAIL: SD Card not detected',
  'I2C:',
  ' - PASS: CAT24C16',
  '',
  'Overall Result = FAIL (0x00000001)',
  S3R_END,
]);

/** A report cut off mid-line, as a dropped link leaves one. */
export const S3R_TRUNCATED_REPORT = crlf([
  S3R_START,
  'Firmware version: v1.01.012',
  'Shimmer model:',
  ' - S3R_TEST_0003 - PASS: Shimmer3R (SR62-0-0)',
  'MCU:',
  ' - S3R_TEST_0007 - PASS: VRef = 2497mV (24',
]);
