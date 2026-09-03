/**
 * Public types for the Shimmer3-family InfoMem (configuration-memory) codec.
 *
 * The InfoMem is the 384-byte region of the MSP430/STM32 microcontroller
 * memory that holds a Shimmer's full device configuration (sampling rate,
 * enabled sensors, calibration, SD-logging / trial settings, sync node list,
 * …). It is the SAME configuration surface the Consensys desktop app reads and
 * writes when a Shimmer3/3R is docked — see the Java driver's
 * `ShimmerObject#configBytesParse` / `#configBytesGenerate` and
 * `ConfigByteLayoutShimmer3`.
 *
 * This module ports the read/parse and generate/write halves so a docked
 * Shimmer can be configured over the dock UART (configure-while-docked).
 */

/**
 * Firmware / hardware identity needed to resolve the correct InfoMem byte
 * layout (the Java `ConfigByteLayoutShimmer3` constructor mutates offsets and
 * the address base by firmware version and hardware id). This is exactly the
 * information the wired VER response already yields
 * ({@link import('../dock/protocol.js').WiredVersionInfo}).
 */
export interface InfoMemContext {
  /** Hardware version code (HW_ID): Shimmer3 = 3, Shimmer3R = 10. */
  hardwareVersion: number;
  /** Firmware identifier (FW_ID): BtStream = 1, SDLog = 2, LogAndStream = 3, StroKare = 15. */
  firmwareId: number;
  /** Firmware version triplet. */
  firmwareVersion: { major: number; minor: number; internal: number };
}

/**
 * IMU sensor rate/range settings held in the InfoMem config-setup bytes.
 *
 * The SAME bits mean different things on Shimmer3 and Shimmer3R because the
 * firmware reuses them for the newer parts — the field names here follow the
 * firmware `gConfigBytes` struct (the neutral, part-independent naming), with
 * each Java accessor named in the JSDoc.
 */
export interface InfoMemImuConfig {
  /**
   * Wide-range accel range. ConfigSetupByte0 (idx 6) bits 2-3
   * (`bitShiftLSM303DLHCAccelRange`, FW `wrAccelRange`). LSM303DLHC/LSM303AH on
   * Shimmer3, LIS2DW12 on Shimmer3R; 0-3 = ±2/4/8/16 g on both.
   */
  wrAccelRange: number;
  /**
   * Wide-range accel sampling rate. ConfigSetupByte0 bits 4-7
   * (`bitShiftLSM303DLHCAccelSamplingRate`, FW `wrAccelRate`). Register-code
   * enum whose labels depend on the part AND on {@link wrAccelLpm}.
   */
  wrAccelRate: number;
  /**
   * Wide-range accel low-power mode. ConfigSetupByte0 bit 1
   * (`bitShiftLSM303DLHCAccelLPM`, FW `wrAccelLpModeLsb`).
   *
   * The firmware also has a `wrAccelLpModeMsb` at ConfigSetupByte4 bit 1 with
   * no Java equivalent; it is not modelled and its bit survives round-trip.
   */
  wrAccelLpm: boolean;
  /**
   * Wide-range accel high-resolution mode. ConfigSetupByte0 bit 0
   * (`bitShiftLSM303DLHCAccelHRM`, FW `wrAccelHrMode`).
   */
  wrAccelHrm: boolean;
  /**
   * Gyro range — COMPOSITE. Low 2 bits at ConfigSetupByte2 (idx 8) bits 0-1
   * (`bitShiftMPU9150GyroRange`, FW `gyroRangeLsb`) plus, on Shimmer3R only, a
   * 3rd bit at ConfigSetupByte4 (idx 130) bit 2 (`bitShiftLSM6DSVGyroRangeMSB`,
   * FW `gyroRangeMsb`), combined as `(msb << 2) | lsb`
   * (SensorLSM6DSV.java:1017). 0-3 on Shimmer3 (MPU9x50 ±250…±2000 dps), 0-5
   * on Shimmer3R (LSM6DSV ±125…±4000 dps).
   */
  gyroRange: number;
  /**
   * IMU accel+gyro sampling rate — the whole of ConfigSetupByte1 (idx 7)
   * (`bitShiftMPU9150AccelGyroSamplingRate`, FW `gyroRate`). A raw MPU9x50
   * rate-divider byte 0-255 on Shimmer3; an LSM6DSV ODR enum 0-12 on
   * Shimmer3R.
   */
  imuRate: number;
  /**
   * Mag range. ConfigSetupByte2 bits 5-7 (`bitShiftLSM303DLHCMagRange`).
   * On Shimmer3 this is the LSM303DLHC mag range (FW `magRange`, 1-7); on
   * Shimmer3R the firmware names it `altMagRange` and it carries the LIS3MDL
   * ALT-mag range 0-3 (SensorLIS3MDL.java:806) — the LIS2MDL "mag" has a fixed
   * range and its range write is commented out in SensorLIS2MDL.java:579.
   */
  magRange: number;
  /**
   * Mag sampling rate. ConfigSetupByte2 bits 2-4
   * (`bitShiftLSM303DLHCMagSamplingRate`, FW `magRate`). NOT composite: the
   * declared `bitShiftLIS2MDLMagRateMSB` is commented out in both
   * SensorLIS2MDL.configBytesGenerate (@581) and .configBytesParse (@602), and
   * the firmware struct has no mag-rate MSB bit anywhere.
   */
  magRate: number;
  /**
   * ConfigSetupByte3 (idx 9) bits 6-7 (`bitShiftMPU9150AccelRange`). On
   * Shimmer3 the ALT-accel (MPU9x50) range (FW `altAccelRange`); on Shimmer3R
   * the firmware names the same bits `lnAccelRange` and Java writes the
   * LSM6DSV low-noise accel range there (SensorLSM6DSV.java:979). 0-3 =
   * ±2/4/8/16 g in both cases.
   */
  altAccelRange: number;
  /**
   * Pressure oversampling ratio — COMPOSITE. Low 2 bits at ConfigSetupByte3
   * bits 4-5 (`bitShiftBMPX80PressureResolution`, FW
   * `pressureOversamplingRatioLsb`) plus, on Shimmer3R only, a 3rd bit at
   * ConfigSetupByte4 bit 0 (`bitShiftBMP390PressureResolution`, FW
   * `pressureOversamplingRatioMsb`), combined as `(msb << 2) | lsb`
   * (SensorBMP390.java:490, SensorBMP581.java:371). 0-3 on Shimmer3
   * (BMP180/BMP280), 0-5 (BMP390) / 0-7 (BMP581) on Shimmer3R.
   */
  pressureOversampling: number;
  /**
   * Alt-mag (LIS3MDL) sampling rate. ConfigSetupByte5 (idx 131) bits 0-5
   * (`maskLIS3MDLAltMagSamplingRate` 0x3F, SensorLIS3MDL.java:809; FW
   * `altMagRate`). Raw LIS3MDL CTRL_REG1 code, e.g. 0x01 = 1000 Hz.
   *
   * The byte means this on **both** generations — the field sits outside every
   * `#if` in the shared firmware's config struct (`Configuration/
   * shimmer_config.h`, "Idx 131") — but only a Shimmer3R carries the LIS3MDL
   * it configures, so on a Shimmer3 it is inert rather than absent. It is
   * parsed and written back unconditionally so a read-modify-write preserves
   * whatever the byte held; a host should offer it only where the hardware has
   * the part, which is what the field schema's `appliesTo` expresses.
   */
  altMagRate: number;
  /**
   * Alt-accel (ADXL371) sampling rate. ConfigSetupByte4 bits 6-7
   * (`bitShiftADXL371AltAccelSamplingRate`, SensorADXL371.java:356; FW
   * `altAccelRate`). 0-3 = 320/640/1280/2560 Hz.
   *
   * As with {@link InfoMemImuConfig.altMagRate}, the byte carries this meaning
   * on both generations and is inert on a Shimmer3, which has no ADXL371.
   */
  altAccelRate: number;
}

/** SD-logging / sync timing bytes in InfoMem C. */
export interface InfoMemSdConfig {
  /**
   * Sync broadcast interval in seconds. `idxSDBTInterval` (idx 219, FW
   * `btIntervalSecs`), ShimmerObject.java:5313.
   */
  btInterval: number;
  /**
   * Estimated experiment length, big-endian u16 at idx 220 (MSB) / 221 (LSB)
   * — ShimmerObject.java:5316-5317, used for SD sync.
   *
   * UNIT MISMATCH: the Java accessor is `getTrialDurationEstimatedInSecs()`
   * while the firmware struct field is
   * `experimentLengthEstimatedInSecMsb/Lsb`; the Java layout comment says
   * "Maximum and Estimated Length in minutes". The codec stores the raw u16
   * either way — HARDWARE-VERIFY the unit before labelling it in a UI.
   */
  estimatedExpLengthMin: number;
  /**
   * Maximum experiment length (auto-stop), big-endian u16 at idx 222 (MSB) /
   * 223 (LSB) — ShimmerObject.java:5318-5319. Firmware struct field is
   * `experimentLengthMaxInMinutesMsb/Lsb` (minutes) while the Java accessor is
   * `getTrialDurationMaximumInSecs()`; see the note on
   * {@link estimatedExpLengthMin}.
   */
  maxExpLengthMin: number;
}

/**
 * The six 21-byte kinematic calibration blocks, kept VERBATIM (bias/
 * sensitivity big-endian i16, alignment 3×3 i8 ×0.01 — see
 * `parseKinematicCalibBlock` / `generateKinematicCalibBlock` in
 * `devices/calibration/kinematic.ts`). The codec never re-encodes them, so an
 * unedited config round-trips byte-identically; a caller that wants to change
 * a calibration replaces the whole 21-byte array.
 */
export interface InfoMemCalibrationBlocks {
  /** Low-noise accel: `idxAnalogAccelCalibration` (34), FW NV_LN_ACCEL_CALIBRATION. */
  lnAccel: Uint8Array;
  /** Gyro: `idxMPU9150GyroCalibration` (55), FW NV_GYRO_CALIBRATION. */
  gyro: Uint8Array;
  /** Mag: `idxLSM303DLHCMagCalibration` (76), FW NV_MAG_CALIBRATION. */
  mag: Uint8Array;
  /** Wide-range accel: `idxLSM303DLHCAccelCalibration` (97), FW NV_WR_ACCEL_CALIBRATION. */
  wrAccel: Uint8Array;
  /**
   * Alt-accel (ADXL371): `idxADXL371AltAccelCalibration` (133), FW
   * NV_ALT_ACCEL_CALIBRATION. Shimmer3R only — on Shimmer3 those bytes are the
   * (unmodelled) MPL accel calibration region, so the field is absent.
   */
  altAccel?: Uint8Array;
  /**
   * Alt-mag (LIS3MDL): `idxLIS3MDLAltMagCalibration` (154), FW
   * NV_ALT_MAG_CALIBRATION. Shimmer3R only — on Shimmer3 those bytes are the
   * (unmodelled) MPL mag calibration region, so the field is absent.
   */
  altMag?: Uint8Array;
}

/**
 * A decoded Shimmer3/3R device configuration. Read via {@link parseInfoMem};
 * write via {@link generateInfoMem}. Field-level semantics mirror the Java
 * `ShimmerObject` config accessors.
 */
export interface InfoMemDeviceConfig {
  /** Sampling rate in Hz (`32768 / divider`, divider stored LSB-first at bytes 0-1). */
  samplingRateHz: number;
  /**
   * Enabled-sensors bitmap. Bits 0-23 are sensors bytes 0-2 (always present);
   * bits 24-39 (sensors bytes 3-4) are only populated on MPL firmware
   * (Shimmer3 + SDLog in [0.7.0, 0.8.0)), which no supported device runs, so in
   * practice this is a 24-bit field. Kept as a `number` (max 40 bits < 2^53).
   */
  enabledSensors: number;
  /** Derived-channels bitmap (up to 8 bytes / 64 bits → `bigint`). */
  derivedSensors: bigint;
  /** GSR range (ConfigSetupByte3 bits 1-3): 0-3 fixed, 4 = auto. */
  gsrRange: number;
  /** Internal expansion-board power enable (ConfigSetupByte3 bit 0). */
  expPowerEnabled: boolean;
  /** Device (Shimmer) name, ≤ 12 ASCII chars. */
  deviceName: string;
  /** Trial / experiment name, ≤ 12 ASCII chars. */
  trialName: string;
  /** Configuration timestamp (Unix seconds), stored big-endian at config-time bytes. */
  configTime: number;
  /** SD-logging / multi-Shimmer trial settings. */
  trial: {
    /** Trial id byte. */
    id: number;
    /** Number of Shimmers in the trial. */
    numShimmers: number;
    /** Sync-when-logging (ExperimentConfig0 bit 2). */
    syncWhenLogging: boolean;
    /** This Shimmer is the sync master (ExperimentConfig0 bit 1). */
    masterShimmer: boolean;
    /** Start logging on button press (ExperimentConfig0 bit 5). */
    buttonStart: boolean;
    /** Single-touch start (ExperimentConfig1 bit 7). */
    singleTouch: boolean;
    /** TCXO enabled (ExperimentConfig1 bit 4). */
    tcxo: boolean;
    /** Bluetooth disabled while logging (ExperimentConfig0 bit 3). */
    disableBluetooth: boolean;
  };
  /** Bluetooth baud-rate index byte. */
  btBaudRate: number;
  /**
   * MAC address as read from InfoMem, 12-char UPPERCASE hex. Read-only /
   * informational: on a device write the MAC is forced to all-0xFF so the
   * firmware re-reads it from the Bluetooth transceiver (see
   * {@link generateInfoMem}).
   */
  macAddress: string;
  /** Raw 10-byte ADS1292R chip-1 (EXG1) register bank. */
  exg1: Uint8Array;
  /** Raw 10-byte ADS1292R chip-2 (EXG2) register bank. */
  exg2: Uint8Array;
  /** IMU rate/range settings from the config-setup bytes. */
  imu: InfoMemImuConfig;
  /** SD-logging interval / experiment-length bytes. */
  sd: InfoMemSdConfig;
  /** The six 21-byte kinematic calibration blocks, verbatim. */
  calibration: InfoMemCalibrationBlocks;
  /**
   * Multi-Shimmer sync node MAC list (InfoMem B, `idxNode0` = 256 + i*6, at
   * most 21 entries), as 12-char UPPERCASE hex. Parsing stops at the first
   * all-0xFF slot (ShimmerObject.java:5359-5366); generate pads the unused
   * slots back to 0xFF.
   */
  syncNodes: string[];
  /** The full InfoMem bytes this config was parsed from (defensive copy). */
  raw: Uint8Array;
  /**
   * False when the first 6 InfoMem bytes are all 0xFF — an unconfigured device
   * (the Java driver loads defaults in this case). When false, the decoded
   * fields are neutral defaults and only {@link raw} is meaningful.
   */
  valid: boolean;
}
