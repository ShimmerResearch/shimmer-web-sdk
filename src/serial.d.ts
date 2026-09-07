/**
 * Minimal ambient type declarations for the Web Serial API.
 * Web Serial is not yet part of the official TypeScript DOM lib.
 * These types match the current Living Standard.
 */

declare global {
  type ParityType = 'none' | 'even' | 'odd';
  type FlowControlType = 'none' | 'hardware';

  /**
   * A Bluetooth service class ID: a 16-/32-bit UUID alias, a full UUID string,
   * or a name from the GATT assigned-services registry. Classic-Bluetooth
   * serial ports are identified by their RFCOMM service class rather than by a
   * USB VID/PID pair (they have none).
   */
  type BluetoothServiceClassId = number | string;

  interface SerialPortFilter {
    usbVendorId?: number;
    usbProductId?: number;
    /** Match a Bluetooth (RFCOMM) serial port by its service class. */
    bluetoothServiceClassId?: BluetoothServiceClassId;
  }

  interface SerialOptions {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: ParityType;
    flowControl?: FlowControlType;
    bufferSize?: number;
  }

  interface SerialPort extends EventTarget {
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
    open(options: SerialOptions): Promise<void>;
    close(): Promise<void>;
    getInfo(): {
      usbVendorId?: number;
      usbProductId?: number;
      /** Present (and the VID/PID absent) for a Bluetooth RFCOMM port. */
      bluetoothServiceClassId?: BluetoothServiceClassId;
    };
  }

  interface SerialPortRequestOptions {
    filters?: SerialPortFilter[];
    /**
     * Service class IDs the picker is permitted to surface Bluetooth serial
     * ports for. Chrome hides Bluetooth ports unless the origin names their
     * service class here, so this must be supplied (not just `filters`) to
     * reach a paired Classic-Bluetooth device.
     */
    allowedBluetoothServiceClassIds?: BluetoothServiceClassId[];
  }

  interface Serial extends EventTarget {
    requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
    getPorts(): Promise<SerialPort[]>;
  }
}

export {};
