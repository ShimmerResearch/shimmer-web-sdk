/**
 * Minimal ambient type declarations for the Web Serial API.
 * Web Serial is not yet part of the official TypeScript DOM lib.
 * These types match the current Living Standard.
 */

declare global {
  type ParityType = 'none' | 'even' | 'odd';
  type FlowControlType = 'none' | 'hardware';

  interface SerialPortFilter {
    usbVendorId?: number;
    usbProductId?: number;
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
    getInfo(): { usbVendorId?: number; usbProductId?: number };
  }

  interface SerialPortRequestOptions {
    filters?: SerialPortFilter[];
  }

  interface Serial extends EventTarget {
    requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
    getPorts(): Promise<SerialPort[]>;
  }
}

export {};
