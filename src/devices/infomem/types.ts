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
  /** The full InfoMem bytes this config was parsed from (defensive copy). */
  raw: Uint8Array;
  /**
   * False when the first 6 InfoMem bytes are all 0xFF — an unconfigured device
   * (the Java driver loads defaults in this case). When false, the decoded
   * fields are neutral defaults and only {@link raw} is meaningful.
   */
  valid: boolean;
}
