/**
 * Declarative field schema for the Shimmer3/Shimmer3R InfoMem, so a generic UI
 * can render the whole configuration surface without hard-coding byte offsets.
 *
 * Shape mirrors `VerisenseOperationalFieldDefinition`
 * (devices/verisense/operationalConfig.ts:14-25) with ONE structural
 * difference: a Verisense field carries a literal `index`, whereas a Shimmer3
 * byte offset is firmware/hardware-conditional, so a field here carries a
 * `layoutKey` that {@link resolveFieldIndex} resolves against a
 * {@link InfoMemLayout} at runtime.
 *
 * SCOPE DECISION — LogAndStream only. This schema deliberately contains ONLY
 * options that LogAndStream firmware honours:
 *
 *  - No MPL / MPU9150-DMP fields (ConfigSetupByte4/5/6 MPL bits, the three MPL
 *    calibration blocks). They are SDLog-0.7.x-only, are never surfaced in host
 *    UI by product decision, and only need to survive round-trip.
 *  - No SDLog-only or BtStream-only settings (e.g. the showErrorLedsRwc /
 *    showErrorLedsSd bits, whose masks `ConfigByteLayoutShimmer3` zeroes unless
 *    a specific firmware generation is detected, and the `bufferSize` byte that
 *    "FW [is] not using" — ShimmerObject.java:5191).
 *  - Sensors0-4 and the derived-channel bitmaps are not fields here: they are
 *    per-channel enable bitmaps driven by the sensor/channel map, not scalar
 *    settings, and belong to a different UI surface.
 */

import type { InfoMemContext } from './types.js';
import { HW_ID, type InfoMemLayout } from './layout.js';

/**
 * Which Shimmer3-family part set a device has. Selects which fields are
 * meaningful and which option labels apply.
 *
 * HARDWARE-VERIFY: the old-IMU / new-IMU split for hardware id 3 is derived
 * from the expansion-board revision (`Configuration.Shimmer3.NEW_IMU_EXP_REV`,
 * Configuration.java:1300-1309) and can only be confirmed against physical
 * boards of each revision.
 */
export type Shimmer3Generation = 'shimmer3-old-imu' | 'shimmer3-new-imu' | 'shimmer3r';

/** How a field's value is encoded in the InfoMem bytes. */
export type InfoMemFieldKind =
  'bit' | 'u8' | 'u16le' | 'u16be' | 'u32be' | 'ascii12' | 'bytes21' | 'mac6[]';

/** `[value, label]`, same tuple shape as the Java `Listof…ConfigValues` pairs. */
export type InfoMemFieldOption = readonly [number, string];

export interface InfoMemFieldDefinition {
  /** Stable identifier, unique across the schema. */
  readonly key: string;
  /** Short UI label. */
  readonly label: string;
  /** One-line description including the byte/bit citation. */
  readonly desc: string;
  readonly kind: InfoMemFieldKind;
  /**
   * Name of the {@link InfoMemLayout} index property holding this field's byte
   * offset — resolved by {@link resolveFieldIndex}, never a literal index.
   */
  readonly layoutKey: keyof InfoMemLayout;
  /** Bit position within the byte (`bit` kind only). */
  readonly shift?: number;
  /** Bit width within the byte (`bit` kind only). */
  readonly width?: number;
  /**
   * COMPOSITE fields only: the layout key of the byte holding the field's high
   * bit(s). `layoutKey`/`shift`/`width` describe the LOW part, this pair the
   * high part, and the value is `(msb << width) | lsb` — exactly the Java
   * combination in SensorLSM6DSV.java:1017 and SensorBMP390.java:490.
   *
   * Both composite fields are Shimmer3R-only (`appliesTo: ['shimmer3r']`),
   * because on Shimmer3 the MSB byte (ConfigSetupByte4) holds MPL settings.
   */
  readonly msbLayoutKey?: keyof InfoMemLayout;
  /** COMPOSITE fields only: bit position of the high bit within its byte. */
  readonly msbShift?: number;
  /** COMPOSITE fields only: bit width of the high part (default 1). */
  readonly msbWidth?: number;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly InfoMemFieldOption[];
  /** Key into {@link SHIMMER3_INFOMEM_FIELD_GROUPS}. */
  readonly group: string;
  readonly appliesTo: readonly Shimmer3Generation[];
  /** Dotted path into {@link InfoMemDeviceConfig}, e.g. `imu.gyroRange`. */
  readonly configKey: string;
}

export interface InfoMemFieldSubgroup {
  readonly id: string;
  readonly title: string;
}

export interface InfoMemFieldGroup {
  readonly id: string;
  readonly title: string;
  readonly openByDefault?: boolean;
  readonly subgroups?: readonly InfoMemFieldSubgroup[];
}

// ---------------------------------------------------------------------------
// Option tables
// ---------------------------------------------------------------------------
// TODO(next PR): source these from devices/shimmer3/sensorOptions.ts once that
// module lands. The tuple shape ([value, label]) is identical, so the swap is a
// mechanical import change — every table below is transcribed verbatim from the
// Java `Listof…` / `Listof…ConfigValues` pairs cited on each constant.

const ALL: readonly Shimmer3Generation[] = ['shimmer3-old-imu', 'shimmer3-new-imu', 'shimmer3r'];
const SHIMMER3_ONLY: readonly Shimmer3Generation[] = ['shimmer3-old-imu', 'shimmer3-new-imu'];
const S3R_ONLY: readonly Shimmer3Generation[] = ['shimmer3r'];
const OLD_IMU_ONLY: readonly Shimmer3Generation[] = ['shimmer3-old-imu'];
const NEW_IMU_ONLY: readonly Shimmer3Generation[] = ['shimmer3-new-imu'];

/** `SensorLSM303.ListofLSM303AccelRange` / `SensorLIS2DW12.ListofLIS2DW12AccelRange` (identical). */
const WR_ACCEL_RANGE: readonly InfoMemFieldOption[] = [
  [0, '± 2 g'],
  [1, '± 4 g'],
  [2, '± 8 g'],
  [3, '± 16 g'],
];

/** `SensorLSM303DLHC.ListofLSM303DLHCAccelRateHr` + `…ConfigValues` (note: no value 8). */
const WR_ACCEL_RATE_LSM303DLHC: readonly InfoMemFieldOption[] = [
  [0, 'Power-down'],
  [1, '1.0 Hz'],
  [2, '10.0 Hz'],
  [3, '25.0 Hz'],
  [4, '50.0 Hz'],
  [5, '100.0 Hz'],
  [6, '200.0 Hz'],
  [7, '400.0 Hz'],
  [8, '1620.0 Hz (low-power only)'],
  [9, '1344.0 Hz / 5376.0 Hz (low-power)'],
];

/** `SensorLSM303AH.ListofLSM303AHAccelRateHr` + `…ConfigValues`. */
const WR_ACCEL_RATE_LSM303AH: readonly InfoMemFieldOption[] = [
  [0, 'Power-down'],
  [1, '12.5 Hz'],
  [2, '25.0 Hz'],
  [3, '50.0 Hz'],
  [4, '100.0 Hz'],
  [5, '200.0 Hz'],
  [6, '400.0 Hz'],
  [7, '800.0 Hz'],
  [8, '1600.0 Hz'],
  [9, '3200.0 Hz'],
  [10, '6400.0 Hz'],
];

/** `SensorLIS2DW12.ListofLIS2DW12AccelRateHpm` + `…ConfigValues`. */
const WR_ACCEL_RATE_LIS2DW12: readonly InfoMemFieldOption[] = [
  [0, 'Power-down'],
  [1, '12.5 Hz'],
  [2, '12.5 Hz'],
  [3, '25.0 Hz'],
  [4, '50.0 Hz'],
  [5, '100.0 Hz'],
  [6, '200.0 Hz'],
  [7, '400.0 Hz'],
  [8, '800.0 Hz'],
  [9, '1600.0 Hz'],
];

/** `SensorMPU9X50.ListofGyroRange` + `ListofMPU9X50GyroRangeConfigValues`. */
const GYRO_RANGE_MPU9X50: readonly InfoMemFieldOption[] = [
  [0, '± 250 dps'],
  [1, '± 500 dps'],
  [2, '± 1000 dps'],
  [3, '± 2000 dps'],
];

/** `SensorLSM6DSV.ListofGyroRange` + `ListofLSM6DSVGyroRangeConfigValues`. */
const GYRO_RANGE_LSM6DSV: readonly InfoMemFieldOption[] = [
  [0, '± 125 dps'],
  [1, '± 250 dps'],
  [2, '± 500 dps'],
  [3, '± 1000 dps'],
  [4, '± 2000 dps'],
  [5, '± 4000 dps'],
];

/**
 * `SensorLSM6DSV.ListofLSM6DSVGyroRate` + `…ConfigValues`. NOTE: the Java
 * label array has 13 entries (values 0-12) while `…ConfigValues` lists 0-13, so
 * value 13 has no Java label; it is omitted here rather than invented.
 */
const IMU_RATE_LSM6DSV: readonly InfoMemFieldOption[] = [
  [0, 'Power-down'],
  [1, '1.875 Hz'],
  [2, '7.5 Hz'],
  [3, '12.0 Hz'],
  [4, '30.0 Hz'],
  [5, '60.0 Hz'],
  [6, '120.0 Hz'],
  [7, '240.0 Hz'],
  [8, '480.0 Hz'],
  [9, '960.0 Hz'],
  [10, '1920.0 Hz'],
  [11, '3840.0 Hz'],
  [12, '7680.0 Hz'],
];

/** `SensorLSM303DLHC.ListofLSM303DLHCMagRange` + `…ConfigValues` (no '0' option). */
const MAG_RANGE_LSM303DLHC: readonly InfoMemFieldOption[] = [
  [1, '± 1.3 Ga'],
  [2, '± 1.9 Ga'],
  [3, '± 2.5 Ga'],
  [4, '± 4.0 Ga'],
  [5, '± 4.7 Ga'],
  [6, '± 5.6 Ga'],
  [7, '± 8.1 Ga'],
];

/** `SensorLIS3MDL.ListofLIS3MDLAltMagRange` + `…ConfigValues`. */
const ALT_MAG_RANGE_LIS3MDL: readonly InfoMemFieldOption[] = [
  [0, '± 4 Ga'],
  [1, '± 8 Ga'],
  [2, '± 12 Ga'],
  [3, '± 16 Ga'],
];

/** `SensorLSM303DLHC.ListofLSM303DLHCMagRate` + `…ConfigValues`. */
const MAG_RATE_LSM303DLHC: readonly InfoMemFieldOption[] = [
  [0, '0.75 Hz'],
  [1, '1.5 Hz'],
  [2, '3.0 Hz'],
  [3, '7.5 Hz'],
  [4, '15.0 Hz'],
  [5, '30.0 Hz'],
  [6, '75.0 Hz'],
  [7, '220.0 Hz'],
];

/**
 * `SensorLSM303AH.ListofLSM303AHMagRate` and
 * `SensorLIS2MDL.ListofLIS2MDLMagRate` — identical tables.
 */
const MAG_RATE_LIS2MDL: readonly InfoMemFieldOption[] = [
  [0, '10.0 Hz'],
  [1, '20.0 Hz'],
  [2, '50.0 Hz'],
  [3, '100.0 Hz'],
];

/** `SensorLIS3MDL.ListofLIS3MDLAltMagRate` + `…ConfigValues` (raw CTRL_REG1 codes). */
const ALT_MAG_RATE_LIS3MDL: readonly InfoMemFieldOption[] = [
  [0x01, '1000 Hz'],
  [0x11, '560 Hz'],
  [0x21, '300 Hz'],
  [0x31, '155 Hz'],
  [0x3e, '80 Hz'],
  [0x3a, '20 Hz'],
  [0x08, '10 Hz'],
];

/** `SensorADXL371.ListofADXL371AccelRate` + `…ConfigValues`. */
const ALT_ACCEL_RATE_ADXL371: readonly InfoMemFieldOption[] = [
  [0, '320 Hz'],
  [1, '640 Hz'],
  [2, '1280 Hz'],
  [3, '2560 Hz'],
];

/** `SensorMPU9X50.ListofMPU9X50AccelRange` + `…ConfigValues`. */
const ALT_ACCEL_RANGE_MPU9X50: readonly InfoMemFieldOption[] = [
  [0, '± 2 g'],
  [1, '± 4 g'],
  [2, '± 8 g'],
  [3, '± 16 g'],
];

/** `SensorLSM6DSV.ListofLSM6DSVAccelRange` + `…ConfigValues` (same bits on Shimmer3R). */
const LN_ACCEL_RANGE_LSM6DSV: readonly InfoMemFieldOption[] = [
  [0, '± 2 g'],
  [1, '± 4 g'],
  [2, '± 8 g'],
  [3, '± 16 g'],
];

/** `SensorBMP180.ListofPressureResolution` (BMP180/BMP280, 2-bit field). */
const PRESSURE_OVERSAMPLING_BMPX80: readonly InfoMemFieldOption[] = [
  [0, 'Low'],
  [1, 'Standard'],
  [2, 'High'],
  [3, 'Very High'],
];

/**
 * `SensorBMP581.ListofPressureResolutionBMP581` + `…ConfigValues` — the widest
 * table for the 3-bit composite field (`SensorBMP390`'s stops at 5).
 */
const PRESSURE_OVERSAMPLING_BMP581: readonly InfoMemFieldOption[] = [
  [0, 'Lowest Power'],
  [1, 'Low'],
  [2, 'Standard'],
  [3, 'High'],
  [4, 'High Res'],
  [5, 'Very High Res'],
  [6, 'Ultra High Res'],
  [7, 'Highest Res'],
];

/** `Configuration.Shimmer2.ListofGSRRange` (index 4 = auto). */
const GSR_RANGE: readonly InfoMemFieldOption[] = [
  [0, '10 kOhm to 56 kOhm'],
  [1, '56 kOhm to 220 kOhm'],
  [2, '220 kOhm to 680 kOhm'],
  [3, '680 kOhm to 4.7 MOhm'],
  [4, 'Auto Range'],
];

/** `Configuration.Shimmer3.ListofBluetoothBaudRates` + `…ConfigValues`. */
const BT_BAUD_RATE: readonly InfoMemFieldOption[] = [
  [0, '115200'],
  [1, '1200'],
  [2, '2400'],
  [3, '4800'],
  [4, '9600'],
  [5, '19200'],
  [6, '38400'],
  [7, '57600'],
  [8, '230400'],
  [9, '460800'],
  [10, '921600'],
];

const ON_OFF: readonly InfoMemFieldOption[] = [
  [0, 'Disabled'],
  [1, 'Enabled'],
];

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const SHIMMER3_INFOMEM_FIELD_GROUPS: readonly InfoMemFieldGroup[] = Object.freeze([
  { id: 'sampling', title: 'Sampling', openByDefault: true },
  { id: 'sensors', title: 'Sensor Enables', openByDefault: true },
  { id: 'lnAccel', title: 'Low-Noise Accelerometer' },
  { id: 'wrAccel', title: 'Wide-Range Accelerometer' },
  { id: 'gyro', title: 'Gyroscope' },
  { id: 'mag', title: 'Magnetometer' },
  { id: 'altAccel', title: 'Alt Accelerometer (high-g)' },
  { id: 'altMag', title: 'Alt Magnetometer' },
  { id: 'pressure', title: 'Pressure / Temperature' },
  { id: 'gsr', title: 'GSR' },
  { id: 'exg', title: 'ExG (ADS1292R)' },
  { id: 'bluetooth', title: 'Bluetooth' },
  {
    id: 'sdLogging',
    title: 'SD Logging',
    subgroups: [
      { id: 'sdLogging.startup', title: 'Start-up' },
      { id: 'sdLogging.duration', title: 'Duration' },
    ],
  },
  { id: 'trial', title: 'Trial / Experiment' },
  { id: 'sync', title: 'Multi-Shimmer Sync' },
  { id: 'calibration', title: 'Calibration' },
] as const);

// ---------------------------------------------------------------------------
// Field schema
// ---------------------------------------------------------------------------

export const SHIMMER3_INFOMEM_FIELD_SCHEMA: readonly InfoMemFieldDefinition[] = Object.freeze([
  // ---- Sampling
  {
    key: 'samplingRate',
    label: 'Sampling Rate',
    desc: 'Sampling-rate divider, LSB-first u16 at bytes 0-1 (32768 / divider = Hz).',
    kind: 'u16le',
    layoutKey: 'idxSamplingRate',
    min: 1,
    max: 0xffff,
    group: 'sampling',
    appliesTo: ALL,
    configKey: 'samplingRateHz',
  },

  // ---- Low-noise accelerometer
  {
    key: 'lnAccelRange',
    label: 'LN Accel Range',
    desc: 'Shimmer3R LSM6DSV low-noise accel range — ConfigSetupByte3 bits 6-7 (FW lnAccelRange, SensorLSM6DSV.java:979).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte3',
    shift: 6,
    width: 2,
    options: LN_ACCEL_RANGE_LSM6DSV,
    group: 'lnAccel',
    appliesTo: S3R_ONLY,
    configKey: 'imu.altAccelRange',
  },

  // ---- Wide-range accelerometer
  {
    key: 'wrAccelRange',
    label: 'WR Accel Range',
    desc: 'ConfigSetupByte0 bits 2-3 (bitShiftLSM303DLHCAccelRange=2, mask 0x03).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte0',
    shift: 2,
    width: 2,
    options: WR_ACCEL_RANGE,
    group: 'wrAccel',
    appliesTo: ALL,
    configKey: 'imu.wrAccelRange',
  },
  {
    key: 'wrAccelRate.lsm303dlhc',
    label: 'WR Accel Rate',
    desc: 'LSM303DLHC rate — ConfigSetupByte0 bits 4-7 (bitShiftLSM303DLHCAccelSamplingRate=4, mask 0x0F).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte0',
    shift: 4,
    width: 4,
    options: WR_ACCEL_RATE_LSM303DLHC,
    group: 'wrAccel',
    appliesTo: OLD_IMU_ONLY,
    configKey: 'imu.wrAccelRate',
  },
  {
    key: 'wrAccelRate.lsm303ah',
    label: 'WR Accel Rate',
    desc: 'LSM303AH (new-IMU Shimmer3) rate — ConfigSetupByte0 bits 4-7.',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte0',
    shift: 4,
    width: 4,
    options: WR_ACCEL_RATE_LSM303AH,
    group: 'wrAccel',
    appliesTo: NEW_IMU_ONLY,
    configKey: 'imu.wrAccelRate',
  },
  {
    key: 'wrAccelRate.lis2dw12',
    label: 'WR Accel Rate',
    desc: 'LIS2DW12 (Shimmer3R) rate — ConfigSetupByte0 bits 4-7 (SensorLIS2DW12.java:428).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte0',
    shift: 4,
    width: 4,
    options: WR_ACCEL_RATE_LIS2DW12,
    group: 'wrAccel',
    appliesTo: S3R_ONLY,
    configKey: 'imu.wrAccelRate',
  },
  {
    key: 'wrAccelLpm',
    label: 'WR Accel Low-Power Mode',
    desc: 'ConfigSetupByte0 bit 1 (bitShiftLSM303DLHCAccelLPM=1, FW wrAccelLpModeLsb).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte0',
    shift: 1,
    width: 1,
    options: ON_OFF,
    group: 'wrAccel',
    appliesTo: ALL,
    configKey: 'imu.wrAccelLpm',
  },
  {
    key: 'wrAccelHrm',
    label: 'WR Accel High-Resolution Mode',
    desc: 'ConfigSetupByte0 bit 0 (bitShiftLSM303DLHCAccelHRM=0, FW wrAccelHrMode).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte0',
    shift: 0,
    width: 1,
    options: ON_OFF,
    group: 'wrAccel',
    appliesTo: ALL,
    configKey: 'imu.wrAccelHrm',
  },

  // ---- Gyroscope
  {
    key: 'gyroRange.mpu9x50',
    label: 'Gyro Range',
    desc: 'MPU9x50 range — ConfigSetupByte2 bits 0-1 (bitShiftMPU9150GyroRange=0, mask 0x03).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte2',
    shift: 0,
    width: 2,
    options: GYRO_RANGE_MPU9X50,
    group: 'gyro',
    appliesTo: SHIMMER3_ONLY,
    configKey: 'imu.gyroRange',
  },
  {
    key: 'gyroRange.lsm6dsv',
    label: 'Gyro Range',
    desc: 'LSM6DSV range, COMPOSITE: ConfigSetupByte2 bits 0-1 plus the MSB at ConfigSetupByte4 bit 2 (SensorLSM6DSV.java:980/1017).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte2',
    shift: 0,
    width: 2,
    msbLayoutKey: 'idxConfigSetupByte4',
    msbShift: 2,
    msbWidth: 1,
    options: GYRO_RANGE_LSM6DSV,
    group: 'gyro',
    appliesTo: S3R_ONLY,
    configKey: 'imu.gyroRange',
  },
  {
    key: 'imuRate.mpu9x50',
    label: 'Gyro/Accel Rate (divider)',
    desc: 'Raw MPU9x50 sample-rate divider — the whole of ConfigSetupByte1 (mask 0xFF). Rate = 8000 / (1 + divider) Hz.',
    kind: 'u8',
    layoutKey: 'idxConfigSetupByte1',
    min: 0,
    max: 255,
    group: 'gyro',
    appliesTo: SHIMMER3_ONLY,
    configKey: 'imu.imuRate',
  },
  {
    key: 'imuRate.lsm6dsv',
    label: 'Gyro/Accel Rate',
    desc: 'LSM6DSV ODR enum — the whole of ConfigSetupByte1 (SensorLSM6DSV.java:977).',
    kind: 'u8',
    layoutKey: 'idxConfigSetupByte1',
    options: IMU_RATE_LSM6DSV,
    group: 'gyro',
    appliesTo: S3R_ONLY,
    configKey: 'imu.imuRate',
  },

  // ---- Magnetometer
  {
    key: 'magRange.lsm303dlhc',
    label: 'Mag Range',
    desc: 'LSM303DLHC range — ConfigSetupByte2 bits 5-7 (bitShiftLSM303DLHCMagRange=5, mask 0x07).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte2',
    shift: 5,
    width: 3,
    options: MAG_RANGE_LSM303DLHC,
    group: 'mag',
    appliesTo: OLD_IMU_ONLY,
    configKey: 'imu.magRange',
  },
  {
    key: 'magRate.lsm303dlhc',
    label: 'Mag Rate',
    desc: 'LSM303DLHC rate — ConfigSetupByte2 bits 2-4 (bitShiftLSM303DLHCMagSamplingRate=2, mask 0x07).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte2',
    shift: 2,
    width: 3,
    options: MAG_RATE_LSM303DLHC,
    group: 'mag',
    appliesTo: OLD_IMU_ONLY,
    configKey: 'imu.magRate',
  },
  {
    key: 'magRate.lis2mdl',
    label: 'Mag Rate',
    desc: 'LSM303AH / LIS2MDL rate — ConfigSetupByte2 bits 2-4 (SensorLIS2MDL.java:580). NOT composite: the declared LIS2MDL rate MSB is commented out in Java and absent from the firmware struct.',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte2',
    shift: 2,
    width: 3,
    options: MAG_RATE_LIS2MDL,
    group: 'mag',
    appliesTo: ['shimmer3-new-imu', 'shimmer3r'],
    configKey: 'imu.magRate',
  },

  // ---- Alt accelerometer (high-g)
  {
    key: 'altAccelRange.mpu9x50',
    label: 'Alt Accel Range',
    desc: 'MPU9x50 accel range — ConfigSetupByte3 bits 6-7 (bitShiftMPU9150AccelRange=6, mask 0x03).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte3',
    shift: 6,
    width: 2,
    options: ALT_ACCEL_RANGE_MPU9X50,
    group: 'altAccel',
    appliesTo: SHIMMER3_ONLY,
    configKey: 'imu.altAccelRange',
  },
  {
    key: 'altAccelRate.adxl371',
    label: 'Alt Accel Rate',
    desc: 'ADXL371 rate — ConfigSetupByte4 bits 6-7 (bitShiftADXL371AltAccelSamplingRate=6, SensorADXL371.java:356; FW altAccelRate).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte4',
    shift: 6,
    width: 2,
    options: ALT_ACCEL_RATE_ADXL371,
    group: 'altAccel',
    appliesTo: S3R_ONLY,
    configKey: 'imu.altAccelRate',
  },

  // ---- Alt magnetometer
  {
    key: 'altMagRange.lis3mdl',
    label: 'Alt Mag Range',
    desc: 'LIS3MDL range — ConfigSetupByte2 bits 5-7, the same bits Shimmer3 uses for its mag range (SensorLIS3MDL.java:806; FW altMagRange).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte2',
    shift: 5,
    width: 3,
    options: ALT_MAG_RANGE_LIS3MDL,
    group: 'altMag',
    appliesTo: S3R_ONLY,
    configKey: 'imu.magRange',
  },
  {
    key: 'altMagRate.lis3mdl',
    label: 'Alt Mag Rate',
    desc: 'LIS3MDL rate — ConfigSetupByte5 bits 0-5, mask 0x3F (SensorLIS3MDL.java:809; FW altMagRate). The Java declaration comment says "Config Byte4" and is wrong.',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte5',
    shift: 0,
    width: 6,
    options: ALT_MAG_RATE_LIS3MDL,
    group: 'altMag',
    appliesTo: S3R_ONLY,
    configKey: 'imu.altMagRate',
  },

  // ---- Pressure
  {
    key: 'pressureOversampling.bmpX80',
    label: 'Pressure Resolution',
    desc: 'BMP180/BMP280 oversampling — ConfigSetupByte3 bits 4-5 (bitShiftBMPX80PressureResolution=4, mask 0x03).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte3',
    shift: 4,
    width: 2,
    options: PRESSURE_OVERSAMPLING_BMPX80,
    group: 'pressure',
    appliesTo: SHIMMER3_ONLY,
    configKey: 'imu.pressureOversampling',
  },
  {
    key: 'pressureOversampling.bmp390_581',
    label: 'Pressure Oversampling',
    desc: 'BMP390/BMP581 oversampling, COMPOSITE: ConfigSetupByte3 bits 4-5 plus the MSB at ConfigSetupByte4 bit 0 (SensorBMP390.java:499, SensorBMP581.java:380; FW pressureOversamplingRatioMsb).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte3',
    shift: 4,
    width: 2,
    msbLayoutKey: 'idxConfigSetupByte4',
    msbShift: 0,
    msbWidth: 1,
    options: PRESSURE_OVERSAMPLING_BMP581,
    group: 'pressure',
    appliesTo: S3R_ONLY,
    configKey: 'imu.pressureOversampling',
  },

  // ---- GSR / expansion power
  {
    key: 'gsrRange',
    label: 'GSR Range',
    desc: 'ConfigSetupByte3 bits 1-3 (bitShiftGSRRange=1, mask 0x07).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte3',
    shift: 1,
    width: 3,
    options: GSR_RANGE,
    group: 'gsr',
    appliesTo: ALL,
    configKey: 'gsrRange',
  },
  {
    key: 'expPower',
    label: 'Expansion-Board Power',
    desc: 'Internal expansion-board 5V/3V rail enable — ConfigSetupByte3 bit 0 (FW expansionBoardPower).',
    kind: 'bit',
    layoutKey: 'idxConfigSetupByte3',
    shift: 0,
    width: 1,
    options: ON_OFF,
    group: 'gsr',
    appliesTo: ALL,
    configKey: 'expPowerEnabled',
  },

  // ---- ExG
  {
    key: 'exg1',
    label: 'ExG Chip 1 Registers',
    desc: 'Raw 10-byte ADS1292R chip-1 register bank at bytes 10-19.',
    kind: 'u8',
    layoutKey: 'idxExg1',
    group: 'exg',
    appliesTo: ALL,
    configKey: 'exg1',
  },
  {
    key: 'exg2',
    label: 'ExG Chip 2 Registers',
    desc: 'Raw 10-byte ADS1292R chip-2 register bank at bytes 20-29.',
    kind: 'u8',
    layoutKey: 'idxExg2',
    group: 'exg',
    appliesTo: ALL,
    configKey: 'exg2',
  },

  // ---- Bluetooth
  {
    key: 'btBaudRate',
    label: 'Bluetooth Baud Rate',
    desc: 'RN42/RN4678 UART baud index — byte 30 (maskBaudRate 0xFF).',
    kind: 'u8',
    layoutKey: 'idxBtCommBaudRate',
    options: BT_BAUD_RATE,
    group: 'bluetooth',
    appliesTo: ALL,
    configKey: 'btBaudRate',
  },
  {
    key: 'disableBluetooth',
    label: 'Disable Bluetooth While Logging',
    desc: 'ExperimentConfig0 bit 3 (bitShiftDisableBluetooth=3, FW bluetoothDisable).',
    kind: 'bit',
    layoutKey: 'idxSDExperimentConfig0',
    shift: 3,
    width: 1,
    options: ON_OFF,
    group: 'bluetooth',
    appliesTo: ALL,
    configKey: 'trial.disableBluetooth',
  },

  // ---- SD logging
  {
    key: 'buttonStart',
    label: 'Start Logging On Button Press',
    desc: 'ExperimentConfig0 bit 5 (bitShiftButtonStart=5, FW userButtonEnable).',
    kind: 'bit',
    layoutKey: 'idxSDExperimentConfig0',
    shift: 5,
    width: 1,
    options: ON_OFF,
    group: 'sdLogging',
    appliesTo: ALL,
    configKey: 'trial.buttonStart',
  },
  {
    key: 'singleTouch',
    label: 'Single-Touch Start',
    desc: 'ExperimentConfig1 bit 7 (bitShiftSingleTouch=7, FW singleTouchStart).',
    kind: 'bit',
    layoutKey: 'idxSDExperimentConfig1',
    shift: 7,
    width: 1,
    options: ON_OFF,
    group: 'sdLogging',
    appliesTo: ALL,
    configKey: 'trial.singleTouch',
  },
  {
    key: 'tcxo',
    label: 'TCXO',
    desc: 'Use the temperature-compensated crystal oscillator — ExperimentConfig1 bit 4 (bitShiftTCX0=4, FW tcxo).',
    kind: 'bit',
    layoutKey: 'idxSDExperimentConfig1',
    shift: 4,
    width: 1,
    options: ON_OFF,
    group: 'sdLogging',
    appliesTo: ALL,
    configKey: 'trial.tcxo',
  },
  {
    key: 'estimatedExpLength',
    label: 'Estimated Experiment Length',
    desc: 'Big-endian u16 at idxEstimatedExpLengthMsb/Lsb (ShimmerObject.java:5316-5317; FW experimentLengthEstimatedInSec*).',
    kind: 'u16be',
    layoutKey: 'idxEstimatedExpLengthMsb',
    min: 0,
    max: 0xffff,
    group: 'sdLogging',
    appliesTo: ALL,
    configKey: 'sd.estimatedExpLengthMin',
  },
  {
    key: 'maxExpLength',
    label: 'Maximum Experiment Length (auto-stop)',
    desc: 'Big-endian u16 at idxMaxExpLengthMsb/Lsb (ShimmerObject.java:5318-5319; FW experimentLengthMaxInMinutes*).',
    kind: 'u16be',
    layoutKey: 'idxMaxExpLengthMsb',
    min: 0,
    max: 0xffff,
    group: 'sdLogging',
    appliesTo: ALL,
    configKey: 'sd.maxExpLengthMin',
  },

  // ---- Trial / experiment identity
  {
    key: 'deviceName',
    label: 'Shimmer Name',
    desc: '12 ASCII bytes at idxSDShimmerName, 0xFF-padded.',
    kind: 'ascii12',
    layoutKey: 'idxSDShimmerName',
    max: 12,
    group: 'trial',
    appliesTo: ALL,
    configKey: 'deviceName',
  },
  {
    key: 'trialName',
    label: 'Experiment ID',
    desc: '12 ASCII bytes at idxSDEXPIDName, 0xFF-padded.',
    kind: 'ascii12',
    layoutKey: 'idxSDEXPIDName',
    max: 12,
    group: 'trial',
    appliesTo: ALL,
    configKey: 'trialName',
  },
  {
    key: 'configTime',
    label: 'Configuration Time',
    desc: 'Unix seconds, big-endian u32 at idxSDConfigTime0-3 (bitShiftSDConfigTime0=24 … 3=0).',
    kind: 'u32be',
    layoutKey: 'idxSDConfigTime0',
    group: 'trial',
    appliesTo: ALL,
    configKey: 'configTime',
  },
  {
    key: 'trialId',
    label: 'Trial ID',
    desc: 'Single byte at idxSDMyTrialID (FW myTrialID).',
    kind: 'u8',
    layoutKey: 'idxSDMyTrialID',
    min: 0,
    max: 255,
    group: 'trial',
    appliesTo: ALL,
    configKey: 'trial.id',
  },
  {
    key: 'numShimmers',
    label: 'Number Of Shimmers In Trial',
    desc: 'Single byte at idxSDNumOfShimmers (FW numberOfShimmers).',
    kind: 'u8',
    layoutKey: 'idxSDNumOfShimmers',
    min: 0,
    max: 21,
    group: 'trial',
    appliesTo: ALL,
    configKey: 'trial.numShimmers',
  },

  // ---- Multi-Shimmer sync
  {
    key: 'syncWhenLogging',
    label: 'Sync While Logging',
    desc: 'ExperimentConfig0 bit 2 (bitShiftTimeSyncWhenLogging=2, FW syncEnable).',
    kind: 'bit',
    layoutKey: 'idxSDExperimentConfig0',
    shift: 2,
    width: 1,
    options: ON_OFF,
    group: 'sync',
    appliesTo: ALL,
    configKey: 'trial.syncWhenLogging',
  },
  {
    key: 'masterShimmer',
    label: 'Sync Master',
    desc: 'ExperimentConfig0 bit 1 (bitShiftMasterShimmer=1, FW masterEnable).',
    kind: 'bit',
    layoutKey: 'idxSDExperimentConfig0',
    shift: 1,
    width: 1,
    options: ON_OFF,
    group: 'sync',
    appliesTo: ALL,
    configKey: 'trial.masterShimmer',
  },
  {
    key: 'btInterval',
    label: 'Sync Broadcast Interval (s)',
    desc: 'Single byte at idxSDBTInterval (FW btIntervalSecs, ShimmerObject.java:5313).',
    kind: 'u8',
    layoutKey: 'idxSDBTInterval',
    min: 0,
    max: 255,
    group: 'sync',
    appliesTo: ALL,
    configKey: 'sd.btInterval',
  },
  {
    key: 'syncNodes',
    label: 'Sync Node MACs',
    desc: 'Up to 21 six-byte MACs from idxNode0 (256), terminated by the first all-0xFF slot.',
    kind: 'mac6[]',
    layoutKey: 'idxNode0',
    max: 21,
    group: 'sync',
    appliesTo: ALL,
    configKey: 'syncNodes',
  },

  // ---- Calibration blocks
  {
    key: 'calib.lnAccel',
    label: 'LN Accel Calibration',
    desc: '21-byte kinematic block at idxAnalogAccelCalibration (FW NV_LN_ACCEL_CALIBRATION).',
    kind: 'bytes21',
    layoutKey: 'idxAnalogAccelCalibration',
    group: 'calibration',
    appliesTo: ALL,
    configKey: 'calibration.lnAccel',
  },
  {
    key: 'calib.gyro',
    label: 'Gyro Calibration',
    desc: '21-byte kinematic block at idxMPU9150GyroCalibration (FW NV_GYRO_CALIBRATION).',
    kind: 'bytes21',
    layoutKey: 'idxMPU9150GyroCalibration',
    group: 'calibration',
    appliesTo: ALL,
    configKey: 'calibration.gyro',
  },
  {
    key: 'calib.mag',
    label: 'Mag Calibration',
    desc: '21-byte kinematic block at idxLSM303DLHCMagCalibration (FW NV_MAG_CALIBRATION).',
    kind: 'bytes21',
    layoutKey: 'idxLSM303DLHCMagCalibration',
    group: 'calibration',
    appliesTo: ALL,
    configKey: 'calibration.mag',
  },
  {
    key: 'calib.wrAccel',
    label: 'WR Accel Calibration',
    desc: '21-byte kinematic block at idxLSM303DLHCAccelCalibration (FW NV_WR_ACCEL_CALIBRATION).',
    kind: 'bytes21',
    layoutKey: 'idxLSM303DLHCAccelCalibration',
    group: 'calibration',
    appliesTo: ALL,
    configKey: 'calibration.wrAccel',
  },
  {
    key: 'calib.altAccel',
    label: 'Alt Accel Calibration',
    desc: '21-byte kinematic block at idxADXL371AltAccelCalibration (133, FW NV_ALT_ACCEL_CALIBRATION). Shimmer3R only — on Shimmer3 those bytes are the unmodelled MPL accel region.',
    kind: 'bytes21',
    layoutKey: 'idxADXL371AltAccelCalibration',
    group: 'calibration',
    appliesTo: S3R_ONLY,
    configKey: 'calibration.altAccel',
  },
  {
    key: 'calib.altMag',
    label: 'Alt Mag Calibration',
    desc: '21-byte kinematic block at idxLIS3MDLAltMagCalibration (154, FW NV_ALT_MAG_CALIBRATION). Shimmer3R only — on Shimmer3 those bytes are the unmodelled MPL mag region.',
    kind: 'bytes21',
    layoutKey: 'idxLIS3MDLAltMagCalibration',
    group: 'calibration',
    appliesTo: S3R_ONLY,
    configKey: 'calibration.altMag',
  },
] as const);

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/** Resolve a field's byte offset against a firmware/hardware-resolved layout. */
export function resolveFieldIndex(field: InfoMemFieldDefinition, layout: InfoMemLayout): number {
  const value = layout[field.layoutKey];
  if (typeof value !== 'number') {
    throw new TypeError(`InfoMem layout key '${String(field.layoutKey)}' is not a byte index`);
  }
  return value;
}

const GENERAL_CALIB_LEN = 21;
const NAME_LEN = 12;
const MAC_LEN = 6;
const MAX_NODES = 21;

function hex2(b: number): string {
  return (b & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/** Resolve a COMPOSITE field's high-part byte offset, or `undefined`. */
function resolveMsbIndex(field: InfoMemFieldDefinition, layout: InfoMemLayout): number | undefined {
  if (field.msbLayoutKey === undefined) return undefined;
  const value = layout[field.msbLayoutKey];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Read one schema field's raw value straight out of an InfoMem byte array.
 *
 * A COMPOSITE `bit` field (one declaring `msbLayoutKey`) returns the FULL
 * combined value, `(msb << width) | lsb`, matching
 * {@link import('./parse.js').parseInfoMem}.
 */
export function readInfoMemFieldValue(
  bytes: Uint8Array,
  field: InfoMemFieldDefinition,
  layout: InfoMemLayout,
): number | string | Uint8Array | string[] {
  const idx = resolveFieldIndex(field, layout);
  switch (field.kind) {
    case 'bit': {
      const shift = field.shift ?? 0;
      const width = field.width ?? 1;
      const mask = (1 << width) - 1;
      const lsb = ((bytes[idx] ?? 0) >> shift) & mask;
      const msbIdx = resolveMsbIndex(field, layout);
      if (msbIdx === undefined) return lsb;
      const msbMask = (1 << (field.msbWidth ?? 1)) - 1;
      const msb = ((bytes[msbIdx] ?? 0) >> (field.msbShift ?? 0)) & msbMask;
      return (msb << width) | lsb;
    }
    case 'u8':
      return bytes[idx] ?? 0;
    case 'u16le':
      return ((bytes[idx] ?? 0) & 0xff) | (((bytes[idx + 1] ?? 0) & 0xff) << 8);
    case 'u16be':
      return (((bytes[idx] ?? 0) & 0xff) << 8) | ((bytes[idx + 1] ?? 0) & 0xff);
    case 'u32be': {
      let v = 0;
      for (let i = 0; i < 4; i++) v = v * 256 + ((bytes[idx + i] ?? 0) & 0xff);
      return v;
    }
    case 'ascii12': {
      let s = '';
      for (let i = 0; i < NAME_LEN; i++) {
        const b = bytes[idx + i];
        if (b === undefined || b < 0x20 || b >= 0x7f) break;
        s += String.fromCharCode(b);
      }
      return s;
    }
    case 'bytes21': {
      const out = new Uint8Array(GENERAL_CALIB_LEN);
      out.set(bytes.subarray(idx, idx + GENERAL_CALIB_LEN), 0);
      return out;
    }
    case 'mac6[]': {
      const nodes: string[] = [];
      for (let n = 0; n < MAX_NODES; n++) {
        const at = idx + n * MAC_LEN;
        let allFf = true;
        let mac = '';
        for (let b = 0; b < MAC_LEN; b++) {
          const v = bytes[at + b] ?? 0xff;
          if (v !== 0xff) allFf = false;
          mac += hex2(v);
        }
        if (allFf) break;
        nodes.push(mac);
      }
      return nodes;
    }
  }
}

/**
 * Write one schema field's raw value into an InfoMem byte array, in place.
 *
 * `bit` fields are read-modify-write, so the other bits of the byte survive. A
 * COMPOSITE field splits the value across its two declared bytes, so both are
 * updated (and both read-modify-write).
 */
export function writeInfoMemFieldValue(
  bytes: Uint8Array,
  field: InfoMemFieldDefinition,
  layout: InfoMemLayout,
  value: number | string | Uint8Array | readonly string[],
): void {
  const idx = resolveFieldIndex(field, layout);
  switch (field.kind) {
    case 'bit': {
      const shift = field.shift ?? 0;
      const width = field.width ?? 1;
      const mask = (1 << width) - 1;
      const raw = Number(value);
      bytes[idx] = ((bytes[idx] & ~(mask << shift)) | ((raw & mask) << shift)) & 0xff;
      const msbIdx = resolveMsbIndex(field, layout);
      if (msbIdx === undefined) return;
      const msbShift = field.msbShift ?? 0;
      const msbMask = (1 << (field.msbWidth ?? 1)) - 1;
      const msb = (raw >> width) & msbMask;
      bytes[msbIdx] = ((bytes[msbIdx] & ~(msbMask << msbShift)) | (msb << msbShift)) & 0xff;
      return;
    }
    case 'u8':
      bytes[idx] = Number(value) & 0xff;
      return;
    case 'u16le': {
      const v = Number(value) & 0xffff;
      bytes[idx] = v & 0xff;
      bytes[idx + 1] = (v >> 8) & 0xff;
      return;
    }
    case 'u16be': {
      const v = Number(value) & 0xffff;
      bytes[idx] = (v >> 8) & 0xff;
      bytes[idx + 1] = v & 0xff;
      return;
    }
    case 'u32be': {
      const v = Number(value);
      for (let i = 0; i < 4; i++) {
        bytes[idx + i] = Math.floor(v / 2 ** (8 * (3 - i))) & 0xff;
      }
      return;
    }
    case 'ascii12': {
      const s = String(value);
      for (let i = 0; i < NAME_LEN; i++) {
        bytes[idx + i] = i < s.length ? s.charCodeAt(i) & 0xff : 0xff;
      }
      return;
    }
    case 'bytes21': {
      const src = value as Uint8Array;
      for (let i = 0; i < GENERAL_CALIB_LEN; i++) bytes[idx + i] = (src[i] ?? 0) & 0xff;
      return;
    }
    case 'mac6[]': {
      const macs = value as readonly string[];
      for (let n = 0; n < MAX_NODES; n++) {
        const at = idx + n * MAC_LEN;
        const mac = macs[n];
        if (mac === undefined || !/^[0-9a-fA-F]{12}$/.test(mac)) {
          for (let b = 0; b < MAC_LEN; b++) bytes[at + b] = 0xff;
        } else {
          for (let b = 0; b < MAC_LEN; b++) {
            bytes[at + b] = Number.parseInt(mac.slice(b * 2, b * 2 + 2), 16);
          }
        }
      }
      return;
    }
  }
}

/** The schema fields that apply to a given part generation, in schema order. */
export function infoMemFieldsFor(generation: Shimmer3Generation): InfoMemFieldDefinition[] {
  return SHIMMER3_INFOMEM_FIELD_SCHEMA.filter((f) => f.appliesTo.includes(generation));
}

/**
 * Expansion-board revision that marks a Shimmer3 base board as "new IMU"
 * (LSM303AH + ICM20948 instead of LSM303DLHC + MPU9150).
 * `Configuration.Shimmer3.NEW_IMU_EXP_REV` (Configuration.java:1300-1309).
 *
 * HARDWARE-VERIFY: this table is transcribed from the Java driver and has not
 * been checked against physical boards of each revision.
 */
export const NEW_IMU_EXP_REV = Object.freeze({
  /** SR31-6-0 and later base board (HW_ID_SR_CODES.SHIMMER3 = 31). */
  IMU: 6,
  /** SR48-3-0 GSR-unified. */
  GSR_UNIFIED: 3,
  /** SR47-3-0 ExG-unified (SR48-2 was skipped). */
  EXG_UNIFIED: 3,
  /** SR49-3-0 bridge-amp-unified. */
  BRIDGE_AMP: 3,
  PROTO3_DELUXE: 3,
  PROTO3_MINI: 3,
  /** SRx-x-171: any expansion board attached to a new-IMU base board. */
  ANY_EXP_BRD_WITH_SPECIAL_REV: 171,
} as const);

/** `HW_ID_SR_CODES.SHIMMER3` — the base board's own SR code. */
const SR_CODE_SHIMMER3 = 31;

/**
 * Decide which part generation a device is.
 *
 * - hardware id 10 (`HW_ID.SHIMMER_3R`) → `'shimmer3r'`
 * - hardware id 3 → new-vs-old IMU from the expansion-board revision:
 *   revision >= the board's {@link NEW_IMU_EXP_REV} threshold (or the
 *   `ANY_EXP_BRD_WITH_SPECIAL_REV` sentinel 171) means new IMU
 * - anything else, or no board info → `'shimmer3-old-imu'` (the safe default:
 *   the LSM303DLHC/MPU9150 option tables are the older, narrower ones)
 */
export function inferShimmer3Generation(
  ctx: InfoMemContext,
  expansionBoard?: { boardId: number; boardRev: number },
): Shimmer3Generation {
  if (ctx.hardwareVersion === HW_ID.SHIMMER_3R) return 'shimmer3r';
  if (ctx.hardwareVersion !== HW_ID.SHIMMER_3 || expansionBoard === undefined) {
    return 'shimmer3-old-imu';
  }
  const { boardId, boardRev } = expansionBoard;
  if (boardRev === NEW_IMU_EXP_REV.ANY_EXP_BRD_WITH_SPECIAL_REV) return 'shimmer3-new-imu';
  // The base board itself (SR31) uses the IMU threshold; every expansion board
  // in the Java table shares the "unified" threshold of 3.
  const threshold =
    boardId === SR_CODE_SHIMMER3 ? NEW_IMU_EXP_REV.IMU : NEW_IMU_EXP_REV.GSR_UNIFIED;
  return boardRev >= threshold ? 'shimmer3-new-imu' : 'shimmer3-old-imu';
}
