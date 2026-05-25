import type { SensorField, FieldKind } from './types.js';

/**
 * Container for a single decoded sensor frame.
 *
 * Mirrors the ObjectCluster concept from the Shimmer C# SDK:
 * a named, typed bag of raw and calibrated signal values produced
 * by parsing one data packet from a device.
 *
 * @example
 * ```ts
 * const oc = new ObjectCluster('MyShimmer3R');
 * oc.add('GYRO_X', rawVal, null, 'raw');
 * oc.add('GYRO_X', degPerSec, 'deg/s', 'cal');
 *
 * const cal = oc.get('GYRO_X', 'cal');
 * console.log(cal?.value, cal?.unit); // e.g. 12.5  "deg/s"
 * ```
 */
export class ObjectCluster {
  /** Identifier of the source device (typically the BLE device name). */
  readonly deviceId: string;

  /** All signal fields decoded from this frame. */
  readonly fields: SensorField[];

  /**
   * The original unparsed byte array for this frame.
   * Populated by protocol parsers that keep the raw bytes for debug purposes.
   */
  raw: Uint8Array | null;

  constructor(deviceId: string) {
    this.deviceId = deviceId;
    this.fields = [];
    this.raw = null;
  }

  /**
   * Append a named field to this cluster.
   *
   * @param name   Signal name, e.g. `'GYRO_X'`.
   * @param value  Numeric value.
   * @param unit   Optional unit string, e.g. `'deg/s'`, `'µS'`, `'ticks'`.
   * @param kind   `'raw'` for ADC counts, `'cal'` for calibrated units, or `null`.
   */
  add(name: string, value: number, unit: string | null = null, kind: FieldKind = null): void {
    this.fields.push({ name, value, unit, kind });
  }

  /**
   * Look up a field by name and optional kind.
   *
   * When both a raw and a calibrated version exist for the same signal name,
   * pass `kind` to disambiguate.
   *
   * @returns The matching field, or `null` if not found.
   */
  get(name: string, kind: FieldKind = null): SensorField | null {
    return (
      this.fields.find(
        (f) => f.name === name && (kind === null || f.kind === kind),
      ) ?? null
    );
  }

  /**
   * Return all fields that match the given name (regardless of kind).
   */
  getAll(name: string): SensorField[] {
    return this.fields.filter((f) => f.name === name);
  }
}
