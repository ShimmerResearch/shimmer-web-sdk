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

/**
 * Whole-output pin for the Verisense parser.
 *
 * The behavioural suite next door asserts the properties that matter; this one
 * asserts that *nothing else* moves either. The parser is being generalized
 * into a shared core driven by a grammar object, and Verisense reports are
 * uploaded to a production spreadsheet whose columns are these metric keys — a
 * silently renamed key or a dropped `unparsedLines` entry would corrupt that
 * sheet without failing a single behavioural assertion.
 *
 * If a change here makes a snapshot move, the refactor is wrong, not the
 * snapshot. Update one only alongside a deliberate, described behaviour change.
 */
describe('parseVerisenseFactoryTestReport - full-output snapshots', () => {
  it('SR68 reference report', () => {
    expect(parseVerisenseFactoryTestReport(SR68_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": "2.00.024",
        "idScheme": "v2_00_010",
        "mcu": {
          "bootCount": 57,
          "deviceId": "0x736FE67FC7AC4A35",
          "lastResetHex": "0x00",
          "lastResetReasons": "power-on/brownout",
          "macId": "D3E73E4795BC",
          "part": "00052840",
          "variant": "AAD0",
        },
        "metrics": {
          "accel2_result": "PASS",
          "accel2_temp_c": 25,
          "adv_prefix": "Verisense",
          "ble_mac": "D3E73E4795BC",
          "boot_count": 57,
          "cct_k": 3933,
          "charger_status": "Charging complete",
          "device_id": "0x736FE67FC7AC4A35",
          "eeprom_result": "PASS",
          "fail_mask_hex": "0x00000840",
          "flicker_hz": 100,
          "flicker_mod_pct": 12,
          "flicker_status": "detected",
          "fw_version": "2.00.024",
          "hub_fw_version": "50.4.4",
          "hub_result": "PASS",
          "imu_result": "PASS",
          "imu_temp_c": 25,
          "last_reset_hex": "0x00",
          "last_reset_reasons": "power-on/brownout",
          "lfclk_limit_ppm": 100,
          "lfclk_ppm": 42.1,
          "lfclk_result": "WARNING",
          "lfclk_s_per_day": 3.6,
          "lfclk_src": "Xtal",
          "light_result": "PASS",
          "lux": 350,
          "mcu_part": "00052840",
          "mcu_temp_c": 25,
          "mcu_temp_result": "PASS",
          "mcu_variant": "AAD0",
          "mlx_ambient_c": 26,
          "mlx_object_c": 26,
          "model_mac_suffix": "95BC",
          "model_mo": "25112101",
          "model_name": "Verisense Pulse+",
          "model_result": "PASS",
          "model_sr_revision": "SR68-9-0",
          "overall_result": "FAIL",
          "passkey_id": "00",
          "passkey_kind": "No Passkey",
          "ppg_afe_fail_reason": "Chip not detected",
          "ppg_afe_result": "FAIL",
          "skin_temp_result": "PASS",
          "temp_range_high_c": 40,
          "temp_range_low_c": 10,
          "usb_power_good": true,
          "vbatt_limit_high_mv": 4400,
          "vbatt_limit_low_mv": 3700,
          "vbatt_mv": 483,
          "vbatt_result": "FAIL",
          "vcore_limit_high_mv": 1850,
          "vcore_limit_low_mv": 1750,
          "vcore_mv": 1819,
          "vcore_result": "PASS",
        },
        "model": {
          "advertisingPrefix": "Verisense",
          "macSuffix": "95BC",
          "manufacturingOrder": "25112101",
          "name": "Verisense Pulse+",
          "passkeyId": "00",
          "passkeyKind": "No Passkey",
          "srRevision": "SR68-9-0",
        },
        "ok": true,
        "overall": {
          "failMask": 2112,
          "failMaskHex": "0x00000840",
          "failedTestNames": [
            "battery",
            "ppg_afe",
          ],
          "result": "FAIL",
        },
        "parserWarnings": [],
        "tests": [
          {
            "detail": "PASS: VCore = 1819mV (1750-1850mV)",
            "id": 1,
            "label": "VCore",
            "metrics": {
              "vcore_limit_high_mv": 1850,
              "vcore_limit_low_mv": 1750,
              "vcore_mv": 1819,
              "vcore_result": "PASS",
            },
            "name": "vcore",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: Temperature = 25° C",
            "id": 2,
            "label": "MCU temperature",
            "metrics": {
              "mcu_temp_c": 25,
              "mcu_temp_result": "PASS",
            },
            "name": "mcu_temp",
            "verdict": "PASS",
          },
          {
            "detail": "WARNING: LF crystal error = +42.1 ppm (+3.6 s/day) - expected for this hardware revision (undersized crystal load caps), not a fault (warn limit +/-100.0 ppm, LFCLK src=Xtal)",
            "id": 3,
            "label": "LF crystal",
            "metrics": {
              "lfclk_limit_ppm": 100,
              "lfclk_ppm": 42.1,
              "lfclk_result": "WARNING",
              "lfclk_s_per_day": 3.6,
              "lfclk_src": "Xtal",
            },
            "name": "lfclk",
            "verdict": "WARNING",
          },
          {
            "detail": "USB power good: Yes",
            "id": 4,
            "label": "USB power good",
            "metrics": {
              "usb_power_good": true,
            },
            "name": "usb_power",
            "verdict": "INFO",
          },
          {
            "detail": "PASS: CAT24M01 EEPROM",
            "id": 5,
            "label": "CAT24M01 EEPROM",
            "metrics": {
              "eeprom_result": "PASS",
            },
            "name": "eeprom",
            "verdict": "PASS",
          },
          {
            "detail": "PASS | Name: Verisense Pulse+ (SR68-9-0) | Manufacturing Order|MAC: 25112101|95BC | Advertising Prefix: Verisense | Passkey ID: 00 (No Passkey)",
            "id": 6,
            "label": "Shimmer model",
            "metrics": {
              "adv_prefix": "Verisense",
              "model_mac_suffix": "95BC",
              "model_mo": "25112101",
              "model_name": "Verisense Pulse+",
              "model_result": "PASS",
              "model_sr_revision": "SR68-9-0",
              "passkey_id": "00",
              "passkey_kind": "No Passkey",
            },
            "name": "model",
            "verdict": "PASS",
          },
          {
            "detail": "FAIL: VBatt = 483mV (3700-4400mV)",
            "id": 7,
            "label": "VBatt",
            "metrics": {
              "vbatt_limit_high_mv": 4400,
              "vbatt_limit_low_mv": 3700,
              "vbatt_mv": 483,
              "vbatt_result": "FAIL",
            },
            "name": "battery",
            "verdict": "FAIL",
          },
          {
            "detail": "Charger status: Charging complete",
            "id": 8,
            "label": "Charger status",
            "metrics": {
              "charger_status": "Charging complete",
            },
            "name": "charger",
            "verdict": "INFO",
          },
          {
            "detail": "PASS: VD6283TX Light sensor (350.0 Lux, CCT: 3933 K) (Flicker: 100.0 Hz, 12% mod)",
            "id": 9,
            "label": "VD6283TX Light sensor",
            "metrics": {
              "cct_k": 3933,
              "flicker_hz": 100,
              "flicker_mod_pct": 12,
              "flicker_status": "detected",
              "light_result": "PASS",
              "lux": 350,
            },
            "name": "light",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: MLX90640 Thermal sensor (Ambient = 26° C, Object = 26° C)",
            "id": 10,
            "label": "Thermal sensor",
            "metrics": {
              "mlx_ambient_c": 26,
              "mlx_object_c": 26,
              "skin_temp_result": "PASS",
            },
            "name": "skin_temp",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: MAX32674C Algorithm hub detected (v50.4.4)",
            "id": 11,
            "label": "MAX32674C Algorithm hub",
            "metrics": {
              "hub_fw_version": "50.4.4",
              "hub_result": "PASS",
            },
            "name": "algo_hub",
            "verdict": "PASS",
          },
          {
            "detail": "FAIL: MAX86176 Pulse oximeter - Chip not detected",
            "id": 12,
            "label": "MAX86176 Pulse oximeter",
            "metrics": {
              "ppg_afe_fail_reason": "Chip not detected",
              "ppg_afe_result": "FAIL",
            },
            "name": "ppg_afe",
            "verdict": "FAIL",
          },
          {
            "detail": "PASS: LIS2DW12 Accelerometer (25° C)",
            "id": 13,
            "label": "LIS2DW12 Accelerometer",
            "metrics": {
              "accel2_result": "PASS",
              "accel2_temp_c": 25,
            },
            "name": "accel2",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: LSM6DSV (25° C)",
            "id": 14,
            "label": "IMU",
            "metrics": {
              "imu_result": "PASS",
              "imu_temp_c": 25,
            },
            "name": "imu",
            "verdict": "PASS",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('SR61 reference report', () => {
    expect(parseVerisenseFactoryTestReport(SR61_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": 57,
          "deviceId": "0x48EEEE365C9ABEEB",
          "lastResetHex": "0x00",
          "lastResetReasons": "power-on/brownout",
          "macId": "CC8B6F80DE63",
          "part": "00052840",
          "variant": "AAD0",
        },
        "metrics": {
          "accel2_result": "NOT_APPLICABLE",
          "adv_prefix": "Verisense",
          "ble_mac": "CC8B6F80DE63",
          "boot_count": 57,
          "cct_k": 2964,
          "device_id": "0x48EEEE365C9ABEEB",
          "eeprom_result": "PASS",
          "hub_result": "NOT_APPLICABLE",
          "imu_result": "PASS",
          "imu_temp_c": 25,
          "last_reset_hex": "0x00",
          "last_reset_reasons": "power-on/brownout",
          "lfclk_limit_ppm": 25,
          "lfclk_ppm": 3.1,
          "lfclk_result": "PASS",
          "lfclk_src": "Xtal",
          "light_result": "PASS",
          "lux": 70,
          "mag_result": "PASS",
          "mag_temp_c": 24,
          "mcu_part": "00052840",
          "mcu_temp_c": 25,
          "mcu_temp_result": "PASS",
          "mcu_variant": "AAD0",
          "model_mac_suffix": "DE63",
          "model_mo": "26011401",
          "model_name": "Verisense IMU",
          "model_result": "PASS",
          "model_sr_revision": "SR61-5-0",
          "nand_manufacturer": "TOSHIBA",
          "nand_model": "TC58CYG2S0HRAIJ",
          "nand_result": "PASS",
          "nand_size_mb": 512,
          "overall_result": "PASS",
          "passkey_id": "00",
          "passkey_kind": "No Passkey",
          "ppg_afe_result": "NOT_APPLICABLE",
          "skin_temp_result": "NOT_APPLICABLE",
          "stf1_result": "NOT_APPLICABLE",
          "stf2_result": "NOT_APPLICABLE",
          "temp_range_high_c": 40,
          "temp_range_low_c": 10,
          "usb_power_good": true,
          "vbatt_limit_high_mv": 4400,
          "vbatt_limit_low_mv": 3700,
          "vbatt_mv": 4115,
          "vbatt_result": "PASS",
          "vcore_limit_high_mv": 1850,
          "vcore_limit_low_mv": 1750,
          "vcore_mv": 1801,
          "vcore_result": "PASS",
        },
        "model": {
          "advertisingPrefix": "Verisense",
          "macSuffix": "DE63",
          "manufacturingOrder": "26011401",
          "name": "Verisense IMU",
          "passkeyId": "00",
          "passkeyKind": "No Passkey",
          "srRevision": "SR61-5-0",
        },
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": "PASS",
        },
        "parserWarnings": [],
        "tests": [
          {
            "detail": "PASS: VCore = 1801mV (1750-1850mV)",
            "id": 1,
            "label": "VCore",
            "metrics": {
              "vcore_limit_high_mv": 1850,
              "vcore_limit_low_mv": 1750,
              "vcore_mv": 1801,
              "vcore_result": "PASS",
            },
            "name": "vcore",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: Temperature = 25° C",
            "id": 2,
            "label": "MCU temperature",
            "metrics": {
              "mcu_temp_c": 25,
              "mcu_temp_result": "PASS",
            },
            "name": "mcu_temp",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: LF crystal error = +3.1 ppm (limit +/-25.0 ppm, LFCLK src=Xtal)",
            "id": 3,
            "label": "LF crystal",
            "metrics": {
              "lfclk_limit_ppm": 25,
              "lfclk_ppm": 3.1,
              "lfclk_result": "PASS",
              "lfclk_src": "Xtal",
            },
            "name": "lfclk",
            "verdict": "PASS",
          },
          {
            "detail": "USB power good: Yes",
            "id": 4,
            "label": "USB power good",
            "metrics": {
              "usb_power_good": true,
            },
            "name": "usb_power",
            "verdict": "INFO",
          },
          {
            "detail": "PASS: CAT24M01 EEPROM",
            "id": 5,
            "label": "CAT24M01 EEPROM",
            "metrics": {
              "eeprom_result": "PASS",
            },
            "name": "eeprom",
            "verdict": "PASS",
          },
          {
            "detail": "PASS | Name: Verisense IMU (SR61-5-0) | Manufacturing Order|MAC: 26011401|DE63 | Advertising Prefix: Verisense | Passkey ID: 00 (No Passkey) | Passkey: (not recorded)",
            "id": 6,
            "label": "Shimmer model",
            "metrics": {
              "adv_prefix": "Verisense",
              "model_mac_suffix": "DE63",
              "model_mo": "26011401",
              "model_name": "Verisense IMU",
              "model_result": "PASS",
              "model_sr_revision": "SR61-5-0",
              "passkey_id": "00",
              "passkey_kind": "No Passkey",
            },
            "name": "model",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: VBatt = 4115mV (3700-4400mV)",
            "id": 7,
            "label": "VBatt",
            "metrics": {
              "vbatt_limit_high_mv": 4400,
              "vbatt_limit_low_mv": 3700,
              "vbatt_mv": 4115,
              "vbatt_result": "PASS",
            },
            "name": "battery",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: VD6283TX Light sensor (70.0 Lux, CCT: 2964 K)",
            "id": 9,
            "label": "VD6283TX Light sensor",
            "metrics": {
              "cct_k": 2964,
              "light_result": "PASS",
              "lux": 70,
            },
            "name": "light",
            "verdict": "PASS",
          },
          {
            "detail": "MLX90640 Thermal sensor test not applicable for this model",
            "id": 10,
            "label": "Thermal sensor",
            "metrics": {
              "skin_temp_result": "NOT_APPLICABLE",
            },
            "name": "skin_temp",
            "verdict": "NOT_APPLICABLE",
          },
          {
            "detail": "MAX32674C Algorithm hub not applicable for this model",
            "id": 11,
            "label": "MAX32674C Algorithm hub",
            "metrics": {
              "hub_result": "NOT_APPLICABLE",
            },
            "name": "algo_hub",
            "verdict": "NOT_APPLICABLE",
          },
          {
            "detail": "MAX86176 Pulse oximeter not applicable for this model",
            "id": 12,
            "label": "MAX86176 Pulse oximeter",
            "metrics": {
              "ppg_afe_result": "NOT_APPLICABLE",
            },
            "name": "ppg_afe",
            "verdict": "NOT_APPLICABLE",
          },
          {
            "detail": "LIS2DW12 Accelerometer not applicable for this model",
            "id": 13,
            "label": "LIS2DW12 Accelerometer",
            "metrics": {
              "accel2_result": "NOT_APPLICABLE",
            },
            "name": "accel2",
            "verdict": "NOT_APPLICABLE",
          },
          {
            "detail": "PASS: LSM6DSV (25° C)",
            "id": 14,
            "label": "IMU",
            "metrics": {
              "imu_result": "PASS",
              "imu_temp_c": 25,
            },
            "name": "imu",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: LIS2MDL (24° C)",
            "id": 15,
            "label": "LIS2MDL Magnetometer",
            "metrics": {
              "mag_result": "PASS",
              "mag_temp_c": 24,
            },
            "name": "mag",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: Main flash test | Manufacturer = TOSHIBA | Model = TC58CYG2S0HRAIJ | Size = 512 MB",
            "id": 16,
            "label": "Main flash test",
            "metrics": {
              "nand_manufacturer": "TOSHIBA",
              "nand_model": "TC58CYG2S0HRAIJ",
              "nand_result": "PASS",
              "nand_size_mb": 512,
            },
            "name": "nand",
            "verdict": "PASS",
          },
          {
            "detail": "STF1 Flash test not applicable for this model",
            "id": 17,
            "label": "STF1 Flash test",
            "metrics": {
              "stf1_result": "NOT_APPLICABLE",
            },
            "name": "stf1",
            "verdict": "NOT_APPLICABLE",
          },
          {
            "detail": "STF2 Flash test not applicable for this model",
            "id": 18,
            "label": "STF2 Flash test",
            "metrics": {
              "stf2_result": "NOT_APPLICABLE",
            },
            "name": "stf2",
            "verdict": "NOT_APPLICABLE",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('legacy numbering report', () => {
    expect(parseVerisenseFactoryTestReport(LEGACY_NUMBERING_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": "2.00.009",
        "idScheme": "legacy",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "eeprom_result": "PASS",
          "fail_mask_hex": "0x00000020",
          "fw_version": "2.00.009",
          "mcu_temp_c": 25,
          "mcu_temp_result": "PASS",
          "overall_result": "FAIL",
          "usb_power_good": true,
          "vbatt_limit_high_mv": 4400,
          "vbatt_limit_low_mv": 3700,
          "vbatt_mv": 483,
          "vbatt_result": "FAIL",
          "vcore_limit_high_mv": 1850,
          "vcore_limit_low_mv": 1750,
          "vcore_mv": 1801,
          "vcore_result": "PASS",
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": 32,
          "failMaskHex": "0x00000020",
          "failedTestNames": [
            "battery",
          ],
          "result": "FAIL",
        },
        "parserWarnings": [],
        "tests": [
          {
            "detail": "PASS: VCore = 1801mV (1750-1850mV)",
            "id": 1,
            "label": "VCore",
            "metrics": {
              "vcore_limit_high_mv": 1850,
              "vcore_limit_low_mv": 1750,
              "vcore_mv": 1801,
              "vcore_result": "PASS",
            },
            "name": "vcore",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: Temperature = 25° C",
            "id": 2,
            "label": "MCU temperature",
            "metrics": {
              "mcu_temp_c": 25,
              "mcu_temp_result": "PASS",
            },
            "name": "mcu_temp",
            "verdict": "PASS",
          },
          {
            "detail": "USB power good: Yes",
            "id": 3,
            "label": "USB power good",
            "metrics": {
              "usb_power_good": true,
            },
            "name": "usb_power",
            "verdict": "INFO",
          },
          {
            "detail": "PASS: CAT24M01 EEPROM",
            "id": 4,
            "label": "CAT24M01 EEPROM",
            "metrics": {
              "eeprom_result": "PASS",
            },
            "name": "eeprom",
            "verdict": "PASS",
          },
          {
            "detail": "FAIL: VBatt = 483mV (3700-4400mV)",
            "id": 6,
            "label": "VBatt",
            "metrics": {
              "vbatt_limit_high_mv": 4400,
              "vbatt_limit_low_mv": 3700,
              "vbatt_mv": 483,
              "vbatt_result": "FAIL",
            },
            "name": "battery",
            "verdict": "FAIL",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('shortened LF crystal warning', () => {
    expect(parseVerisenseFactoryTestReport(SHORTENED_LF_WARNING_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "lfclk_limit_ppm": 100,
          "lfclk_ppm": 49.3,
          "lfclk_result": "WARNING",
          "lfclk_s_per_day": 4.2,
          "lfclk_src": "Xtal",
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [],
        "tests": [
          {
            "detail": "WARNING: LF crystal error = +49.3 ppm (+4.2 s/day) - expected for this HW rev (warn limit +/-100.0 ppm, LFCLK src=Xtal)",
            "id": 3,
            "label": "LF crystal",
            "metrics": {
              "lfclk_limit_ppm": 100,
              "lfclk_ppm": 49.3,
              "lfclk_result": "WARNING",
              "lfclk_s_per_day": 4.2,
              "lfclk_src": "Xtal",
            },
            "name": "lfclk",
            "verdict": "WARNING",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('warning line glued to the next section header', () => {
    expect(parseVerisenseFactoryTestReport(GLUED_WARNING_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "lfclk_ppm": 49.3,
          "lfclk_result": "WARNING",
          "lfclk_s_per_day": 4.2,
          "mcu_temp_c": 29,
          "mcu_temp_result": "PASS",
          "usb_power_good": true,
          "vcore_limit_high_mv": 1850,
          "vcore_limit_low_mv": 1750,
          "vcore_mv": 1819,
          "vcore_result": "PASS",
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [
          "repaired a line truncated by the firmware buffer near column 145",
        ],
        "tests": [
          {
            "detail": "PASS: VCore = 1819mV (1750-1850mV)",
            "id": 1,
            "label": "VCore",
            "metrics": {
              "vcore_limit_high_mv": 1850,
              "vcore_limit_low_mv": 1750,
              "vcore_mv": 1819,
              "vcore_result": "PASS",
            },
            "name": "vcore",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: Temperature = 29° C",
            "id": 2,
            "label": "MCU temperature",
            "metrics": {
              "mcu_temp_c": 29,
              "mcu_temp_result": "PASS",
            },
            "name": "mcu_temp",
            "verdict": "PASS",
          },
          {
            "detail": "WARNING: LF crystal error = +49.3 ppm (+4.2 s/day) - expected for this hardware revision (undersized crystal load caps), not a",
            "id": 3,
            "label": "LF crystal",
            "metrics": {
              "lfclk_ppm": 49.3,
              "lfclk_result": "WARNING",
              "lfclk_s_per_day": 4.2,
            },
            "name": "lfclk",
            "verdict": "WARNING",
          },
          {
            "detail": "USB power good: Yes",
            "id": 4,
            "label": "USB power good",
            "metrics": {
              "usb_power_good": true,
            },
            "name": "usb_power",
            "verdict": "INFO",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('two test lines glued into one', () => {
    expect(parseVerisenseFactoryTestReport(GLUED_TEST_LINES_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "stf1_result": "PASS",
          "stf2_result": "PASS",
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [
          "repaired a line truncated by the firmware buffer near column 39",
        ],
        "tests": [
          {
            "detail": "PASS: STF1 Flash test",
            "id": 17,
            "label": "STF1 Flash test",
            "metrics": {
              "stf1_result": "PASS",
            },
            "name": "stf1",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: STF2 Flash test",
            "id": 18,
            "label": "STF2 Flash test",
            "metrics": {
              "stf2_result": "PASS",
            },
            "name": "stf2",
            "verdict": "PASS",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('NAND health progress dots and counters', () => {
    expect(parseVerisenseFactoryTestReport(NAND_HEALTH_DOTS_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "nand_bad_block_limit": 40,
          "nand_bad_block_total": 2048,
          "nand_bad_blocks": 3,
          "nand_blocks_skipped": 0,
          "nand_corrupt_pages": 0,
          "nand_erase_write_fails": "0/0",
          "nand_health_result": "PASS",
          "nand_manufacturer": "TOSHIBA",
          "nand_model": "TC58CYG2S0HRAIJ",
          "nand_page_checks": 1024,
          "nand_result": "PASS",
          "nand_size_mb": 512,
          "nand_stress_blocks": 16,
          "nand_unstable_pages": 0,
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [
          "stripped 1 progress-dot line(s)",
        ],
        "tests": [
          {
            "detail": "PASS: Main flash test | Manufacturer = TOSHIBA | Model = TC58CYG2S0HRAIJ | Size = 512 MB",
            "id": 16,
            "label": "Main flash test",
            "metrics": {
              "nand_manufacturer": "TOSHIBA",
              "nand_model": "TC58CYG2S0HRAIJ",
              "nand_result": "PASS",
              "nand_size_mb": 512,
            },
            "name": "nand",
            "verdict": "PASS",
          },
          {
            "detail": "PASS: NAND health test | Bad-block census = 3 of 2048 (limit 40) | Stress = 16 blocks / 1024 page checks (0 sampled blocks skipped bad) | Corrupt pages = 0, unstable pages = 0, erase/write fails = 0/0",
            "id": 21,
            "label": "NAND health test",
            "metrics": {
              "nand_bad_block_limit": 40,
              "nand_bad_block_total": 2048,
              "nand_bad_blocks": 3,
              "nand_blocks_skipped": 0,
              "nand_corrupt_pages": 0,
              "nand_erase_write_fails": "0/0",
              "nand_health_result": "PASS",
              "nand_page_checks": 1024,
              "nand_stress_blocks": 16,
              "nand_unstable_pages": 0,
            },
            "name": "nand_health",
            "verdict": "PASS",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('LED narration blocks', () => {
    expect(parseVerisenseFactoryTestReport(LED_NARRATION_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "overall_result": "PASS",
          "vcore_limit_high_mv": 1850,
          "vcore_limit_low_mv": 1750,
          "vcore_mv": 1819,
          "vcore_result": "PASS",
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": "PASS",
        },
        "parserWarnings": [],
        "tests": [
          {
            "detail": "All LEDs off | Left Red LED on | Left Green LED on",
            "id": 19,
            "label": "LED test - operational status",
            "metrics": {},
            "name": "led_status",
            "verdict": "INFO",
          },
          {
            "detail": "Right Red LED on | All LEDs off",
            "id": 20,
            "label": "LED test - battery status",
            "metrics": {},
            "name": "led_batt",
            "verdict": "INFO",
          },
          {
            "detail": "PASS: VCore = 1819mV (1750-1850mV)",
            "id": 1,
            "label": "VCore",
            "metrics": {
              "vcore_limit_high_mv": 1850,
              "vcore_limit_low_mv": 1750,
              "vcore_mv": 1819,
              "vcore_result": "PASS",
            },
            "name": "vcore",
            "verdict": "PASS",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('model-gated LED test', () => {
    expect(parseVerisenseFactoryTestReport(GATED_LED_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "led_status_result": "NOT_APPLICABLE",
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [],
        "tests": [
          {
            "detail": "RGB LED test not applicable for this model",
            "id": 19,
            "label": "LED test - operational status",
            "metrics": {
              "led_status_result": "NOT_APPLICABLE",
            },
            "name": "led_status",
            "verdict": "NOT_APPLICABLE",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('NAND health skipped warning', () => {
    expect(parseVerisenseFactoryTestReport(NAND_HEALTH_SKIPPED_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "nand_health_result": "WARNING",
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [],
        "tests": [
          {
            "detail": "WARNING: NAND health test skipped - needs fully erased flash (erase all logged data first)",
            "id": 21,
            "label": "NAND health test",
            "metrics": {
              "nand_health_result": "WARNING",
            },
            "name": "nand_health",
            "verdict": "WARNING",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('report aborted at the model test', () => {
    expect(parseVerisenseFactoryTestReport(ABORTED_MODEL_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": false,
        "firmwareVersion": "2.00.024",
        "idScheme": "v2_00_010",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "fw_version": "2.00.024",
          "model_result": "FAIL",
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [],
        "tests": [
          {
            "detail": "FAIL: production config not set",
            "id": 6,
            "label": "Shimmer model",
            "metrics": {
              "model_result": "FAIL",
            },
            "name": "model",
            "verdict": "FAIL",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('unknown future test id', () => {
    expect(parseVerisenseFactoryTestReport(FUTURE_TEST_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "ws_test_0027_foo": 12,
          "ws_test_0027_result": "PASS",
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [],
        "tests": [
          {
            "detail": "PASS: Widget check (Foo = 12 bar)",
            "id": 27,
            "label": "WS_TEST_0027",
            "metrics": {
              "ws_test_0027_foo": 12,
              "ws_test_0027_result": "PASS",
            },
            "name": "ws_test_0027",
            "verdict": "PASS",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('unrecognized section line', () => {
    expect(parseVerisenseFactoryTestReport(UNRECOGNIZED_LINE_REPORT)).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {},
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [],
        "tests": [],
        "unparsedLines": [
          "Some brand new section nobody has seen",
        ],
      }
    `);
  });

  it('degree sign as UTF-8', () => {
    expect(parseVerisenseFactoryTestReport(DEGREE_VARIANT_REPORTS[0])).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "mcu_temp_c": 25,
          "mcu_temp_result": "PASS",
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [],
        "tests": [
          {
            "detail": "PASS: Temperature = 25° C",
            "id": 2,
            "label": "MCU temperature",
            "metrics": {
              "mcu_temp_c": 25,
              "mcu_temp_result": "PASS",
            },
            "name": "mcu_temp",
            "verdict": "PASS",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('degree sign as latin1-decoded UTF-8 mojibake', () => {
    expect(parseVerisenseFactoryTestReport(DEGREE_VARIANT_REPORTS[1])).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "mcu_temp_c": 25,
          "mcu_temp_result": "PASS",
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [],
        "tests": [
          {
            "detail": "PASS: Temperature = 25° C",
            "id": 2,
            "label": "MCU temperature",
            "metrics": {
              "mcu_temp_c": 25,
              "mcu_temp_result": "PASS",
            },
            "name": "mcu_temp",
            "verdict": "PASS",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('degree sign as the Unicode replacement character', () => {
    expect(parseVerisenseFactoryTestReport(DEGREE_VARIANT_REPORTS[2])).toMatchInlineSnapshot(`
      {
        "complete": true,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {
          "mcu_temp_c": 25,
          "mcu_temp_result": "PASS",
        },
        "model": null,
        "ok": true,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [],
        "tests": [
          {
            "detail": "PASS: Temperature = 25° C",
            "id": 2,
            "label": "MCU temperature",
            "metrics": {
              "mcu_temp_c": 25,
              "mcu_temp_result": "PASS",
            },
            "name": "mcu_temp",
            "verdict": "PASS",
          },
        ],
        "unparsedLines": [],
      }
    `);
  });

  it('empty input', () => {
    expect(parseVerisenseFactoryTestReport('')).toMatchInlineSnapshot(`
      {
        "complete": false,
        "firmwareVersion": null,
        "idScheme": "unknown",
        "mcu": {
          "bootCount": null,
          "deviceId": null,
          "lastResetHex": null,
          "lastResetReasons": null,
          "macId": null,
          "part": null,
          "variant": null,
        },
        "metrics": {},
        "model": null,
        "ok": false,
        "overall": {
          "failMask": null,
          "failMaskHex": null,
          "failedTestNames": [],
          "result": null,
        },
        "parserWarnings": [],
        "tests": [],
        "unparsedLines": [],
      }
    `);
  });
});

/**
 * The CSV writer is what actually reaches the production sheet, so its column
 * order and escaping are pinned too.
 */
describe('verisenseFactoryTestReportToCsvRows - snapshots', () => {
  it('SR68 rows with caller meta columns', () => {
    expect(
      verisenseFactoryTestReportToCsvRows(parseVerisenseFactoryTestReport(SR68_REPORT), {
        mo: '25112101',
        mac_id: '95BC',
        finished_at: '2026-08-13T10:00:00.000Z',
      }),
    ).toMatchInlineSnapshot(`
      [
        "mo,mac_id,finished_at,accel2_result,accel2_temp_c,adv_prefix,ble_mac,boot_count,cct_k,charger_status,device_id,eeprom_result,fail_mask_hex,flicker_hz,flicker_mod_pct,flicker_status,fw_version,hub_fw_version,hub_result,imu_result,imu_temp_c,last_reset_hex,last_reset_reasons,lfclk_limit_ppm,lfclk_ppm,lfclk_result,lfclk_s_per_day,lfclk_src,light_result,lux,mcu_part,mcu_temp_c,mcu_temp_result,mcu_variant,mlx_ambient_c,mlx_object_c,model_mac_suffix,model_mo,model_name,model_result,model_sr_revision,overall_result,passkey_id,passkey_kind,ppg_afe_fail_reason,ppg_afe_result,skin_temp_result,temp_range_high_c,temp_range_low_c,usb_power_good,vbatt_limit_high_mv,vbatt_limit_low_mv,vbatt_mv,vbatt_result,vcore_limit_high_mv,vcore_limit_low_mv,vcore_mv,vcore_result",
        "25112101,95BC,2026-08-13T10:00:00.000Z,PASS,25,Verisense,D3E73E4795BC,57,3933,Charging complete,0x736FE67FC7AC4A35,PASS,0x00000840,100,12,detected,2.00.024,50.4.4,PASS,PASS,25,0x00,power-on/brownout,100,42.1,WARNING,3.6,Xtal,PASS,350,00052840,25,PASS,AAD0,26,26,95BC,25112101,Verisense Pulse+,PASS,SR68-9-0,FAIL,00,No Passkey,Chip not detected,FAIL,PASS,40,10,true,4400,3700,483,FAIL,1850,1750,1819,PASS",
      ]
    `);
  });

  it('SR61 rows with no meta columns', () => {
    expect(verisenseFactoryTestReportToCsvRows(parseVerisenseFactoryTestReport(SR61_REPORT)))
      .toMatchInlineSnapshot(`
      [
        "accel2_result,adv_prefix,ble_mac,boot_count,cct_k,device_id,eeprom_result,hub_result,imu_result,imu_temp_c,last_reset_hex,last_reset_reasons,lfclk_limit_ppm,lfclk_ppm,lfclk_result,lfclk_src,light_result,lux,mag_result,mag_temp_c,mcu_part,mcu_temp_c,mcu_temp_result,mcu_variant,model_mac_suffix,model_mo,model_name,model_result,model_sr_revision,nand_manufacturer,nand_model,nand_result,nand_size_mb,overall_result,passkey_id,passkey_kind,ppg_afe_result,skin_temp_result,stf1_result,stf2_result,temp_range_high_c,temp_range_low_c,usb_power_good,vbatt_limit_high_mv,vbatt_limit_low_mv,vbatt_mv,vbatt_result,vcore_limit_high_mv,vcore_limit_low_mv,vcore_mv,vcore_result",
        "NOT_APPLICABLE,Verisense,CC8B6F80DE63,57,2964,0x48EEEE365C9ABEEB,PASS,NOT_APPLICABLE,PASS,25,0x00,power-on/brownout,25,3.1,PASS,Xtal,PASS,70,PASS,24,00052840,25,PASS,AAD0,DE63,26011401,Verisense IMU,PASS,SR61-5-0,TOSHIBA,TC58CYG2S0HRAIJ,PASS,512,PASS,00,No Passkey,NOT_APPLICABLE,NOT_APPLICABLE,NOT_APPLICABLE,NOT_APPLICABLE,40,10,true,4400,3700,4115,PASS,1850,1750,1801,PASS",
      ]
    `);
  });
});
