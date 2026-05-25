import type { ObjectCluster } from './ObjectCluster.js';

/**
 * Discriminated kind tag for a data field in an ObjectCluster.
 */
export type FieldKind = 'raw' | 'cal' | null;

/**
 * A single named field stored inside an ObjectCluster.
 */
export interface SensorField {
  /** Signal name, e.g. 'GYRO_X', 'GSR', 'TIMESTAMP'. */
  name: string;
  /** Numeric value. */
  value: number;
  /** Optional unit string, e.g. 'deg/s', 'µS', 'ticks'. */
  unit: string | null;
  /** Whether the value is raw ADC counts or calibrated engineering units. */
  kind: FieldKind;
}

/**
 * Constructor options common to all Shimmer device clients.
 */
export interface ShimmerClientOptions {
  /** Enable verbose console logging. Defaults to `true`. */
  debug?: boolean;
}

/**
 * Contract that every Shimmer device client must satisfy.
 *
 * Both `Shimmer3RClient` and `VerisenseBleDevice` implement this interface,
 * allowing application code to remain device-agnostic for the common operations.
 */
export interface IShimmerClient {
  /** Open a BLE connection to the device (triggers the browser picker). */
  connect(...args: unknown[]): Promise<unknown>;

  /** Close the BLE connection. */
  disconnect(...args: unknown[]): Promise<unknown>;

  /** Start streaming sensor data. */
  startStreaming(): Promise<void>;

  /** Stop streaming sensor data. */
  stopStreaming(): Promise<void>;

  /**
   * Called for every decoded data frame while streaming.
   * For Shimmer3R this delivers an ObjectCluster; for Verisense it delivers
   * a raw streaming packet (see `VerisenseBleDevice` for the exact shape).
   */
  onStreamFrame: ((frame: ObjectCluster) => void) | null;

  /** Called whenever the client emits a human-readable status message. */
  onStatus: ((msg: string) => void) | null;
}

/**
 * Calibration parameters for a single inertial axis.
 */
export interface InertialCalibration {
  /** Zero-g or zero-rate offset. */
  offset: [number, number, number];
  /** 3×3 alignment/cross-axis correction matrix (row-major). */
  align: [[number, number, number], [number, number, number], [number, number, number]];
  /** Per-axis sensitivity in LSB/unit. */
  sensitivity: [number, number, number];
}
