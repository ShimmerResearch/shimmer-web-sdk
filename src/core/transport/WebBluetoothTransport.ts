import { toArrayBuffer } from '../arrayBuffer.js';
import type {
  ShimmerTransport,
  ShimmerTransportKind,
  TransportCapabilities,
  TransportWriteOptions,
  Unsubscribe,
} from './types.js';

/** Constructor options for {@link WebBluetoothTransport}. */
export interface WebBluetoothTransportOptions {
  /** Primary GATT service UUID the write/notify characteristics live under. */
  serviceUUID: string;
  /** Characteristic the host writes command frames to (host → device). */
  writeCharUUID: string;
  /** Characteristic the host receives notifications from (device → host). */
  notifyCharUUID: string;
  /**
   * Options passed straight to `navigator.bluetooth.requestDevice`. When omitted
   * a filter on `serviceUUID` is used. Ignored when {@link device} is supplied.
   */
  requestDeviceOptions?: RequestDeviceOptions;
  /**
   * A pre-selected device (skips the `requestDevice` picker). Useful for
   * reconnect flows that already hold a `BluetoothDevice`.
   */
  device?: BluetoothDevice | null;
  /**
   * Default acknowledgement mode for {@link write} when the per-write option is
   * unset. `true` → write-with-response (`writeValue`); `false` →
   * write-without-response when the characteristic supports it, else
   * `writeValue`.
   */
  defaultWriteWithResponse?: boolean;
  /** Enable verbose console logging. */
  debug?: boolean;
  /** Log tag prefix. Defaults to `[WebBluetoothTransport]`. */
  logTag?: string;
}

/**
 * A {@link ShimmerTransport} over the Web Bluetooth GATT API.
 *
 * Parameterised by service / write-characteristic / notify-characteristic UUIDs
 * so it serves both Shimmer3R and Verisense (which use different UUIDs, and
 * mirror-image write/notify roles). It performs no protocol interpretation: each
 * `characteristicvaluechanged` notification is forwarded verbatim to
 * `onNotify`, preserving chunk boundaries.
 *
 * The concrete GATT handles ({@link device}, {@link server},
 * {@link writeCharacteristic}, {@link notifyCharacteristic}) are exposed so a
 * client can reach adjacent services on the same connection (e.g. Verisense's
 * Nordic buttonless-DFU control point) without the transport having to model
 * them.
 */
export class WebBluetoothTransport implements ShimmerTransport {
  readonly kind: ShimmerTransportKind = 'ble';
  readonly capabilities: TransportCapabilities = { framed: true };

  private readonly _serviceUUID: string;
  private readonly _writeCharUUID: string;
  private readonly _notifyCharUUID: string;
  private readonly _requestDeviceOptions?: RequestDeviceOptions;
  private readonly _defaultWriteWithResponse: boolean;
  private readonly _debug: boolean;
  private readonly _logTag: string;

  private _device: BluetoothDevice | null = null;
  private _server: BluetoothRemoteGATTServer | null = null;
  private _service: BluetoothRemoteGATTService | null = null;
  private _writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private _notifyChar: BluetoothRemoteGATTCharacteristic | null = null;

  private readonly _notifyCbs = new Set<(data: Uint8Array) => void>();
  private readonly _disconnectCbs = new Set<(reason?: Error) => void>();

  constructor(opts: WebBluetoothTransportOptions) {
    this._serviceUUID = opts.serviceUUID;
    this._writeCharUUID = opts.writeCharUUID;
    this._notifyCharUUID = opts.notifyCharUUID;
    this._requestDeviceOptions = opts.requestDeviceOptions;
    this._device = opts.device ?? null;
    this._defaultWriteWithResponse = opts.defaultWriteWithResponse ?? false;
    this._debug = opts.debug ?? false;
    this._logTag = opts.logTag ?? '[WebBluetoothTransport]';
  }

  /** The selected `BluetoothDevice`, once chosen. */
  get device(): BluetoothDevice | null {
    return this._device;
  }
  /** The connected GATT server, once connected. */
  get server(): BluetoothRemoteGATTServer | null {
    return this._server;
  }
  /** The write characteristic (host → device), once discovered. */
  get writeCharacteristic(): BluetoothRemoteGATTCharacteristic | null {
    return this._writeChar;
  }
  /** The notify characteristic (device → host), once discovered. */
  get notifyCharacteristic(): BluetoothRemoteGATTCharacteristic | null {
    return this._notifyChar;
  }
  get deviceName(): string | undefined {
    return this._device?.name ?? undefined;
  }

  private _log(...args: unknown[]): void {
    if (this._debug) console.log(this._logTag, ...args);
  }

  async connect(): Promise<void> {
    if (!this._device) {
      const requestOpts: RequestDeviceOptions = this._requestDeviceOptions ?? {
        filters: [{ services: [this._serviceUUID] }],
        optionalServices: [this._serviceUUID],
      };
      this._device = await navigator.bluetooth.requestDevice(requestOpts);
    }

    // Register the link-drop listener before connecting so an immediate drop is
    // never missed.
    this._device.addEventListener('gattserverdisconnected', this._onGattServerDisconnected);

    this._server = await this._device.gatt!.connect();
    this._service = await this._server.getPrimaryService(this._serviceUUID);
    this._writeChar = await this._service.getCharacteristic(this._writeCharUUID);
    this._notifyChar = await this._service.getCharacteristic(this._notifyCharUUID);

    await this._notifyChar.startNotifications();
    this._notifyChar.addEventListener('characteristicvaluechanged', this._onCharacteristicChanged);
    this._log('connected', this._device.name ?? '(unnamed)');
  }

  async disconnect(): Promise<void> {
    try {
      if (this._notifyChar) {
        try {
          await this._notifyChar.stopNotifications();
        } catch {
          /* ignore */
        }
        this._notifyChar.removeEventListener(
          'characteristicvaluechanged',
          this._onCharacteristicChanged,
        );
      }
      if (this._device) {
        this._device.removeEventListener('gattserverdisconnected', this._onGattServerDisconnected);
      }
      if (this._device?.gatt?.connected) this._device.gatt.disconnect();
    } finally {
      this._server = null;
      this._service = null;
      this._writeChar = null;
      this._notifyChar = null;
      // Keep `_device` so a caller can reconnect to the same peripheral.
    }
  }

  async write(data: Uint8Array, opts?: TransportWriteOptions): Promise<void> {
    if (!this._writeChar) throw new Error('Not connected (write characteristic missing)');
    const withResponse = opts?.withResponse ?? this._defaultWriteWithResponse;
    const buf = toArrayBuffer(data);
    this._log('write', data);

    if (withResponse) {
      await this._writeChar.writeValue(buf);
      return;
    }
    const ext = this._writeChar as BluetoothRemoteGATTCharacteristic & {
      writeValueWithoutResponse?(value: BufferSource): Promise<void>;
    };
    if (ext.writeValueWithoutResponse) {
      await ext.writeValueWithoutResponse(buf);
    } else {
      await this._writeChar.writeValue(buf);
    }
  }

  onNotify(cb: (data: Uint8Array) => void): Unsubscribe {
    this._notifyCbs.add(cb);
    return () => this._notifyCbs.delete(cb);
  }

  onDisconnect(cb: (reason?: Error) => void): Unsubscribe {
    this._disconnectCbs.add(cb);
    return () => this._disconnectCbs.delete(cb);
  }

  private _onCharacteristicChanged = (evt: Event): void => {
    const dv = (evt.target as BluetoothRemoteGATTCharacteristic | null)?.value;
    if (!dv) return;
    // Copy the exact notification bytes (preserving chunk boundaries). No
    // protocol interpretation happens here.
    const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
    for (const cb of this._notifyCbs) {
      try {
        cb(bytes);
      } catch (e) {
        this._log('notify handler error', e);
      }
    }
  };

  private _onGattServerDisconnected = (): void => {
    for (const cb of this._disconnectCbs) {
      try {
        cb();
      } catch (e) {
        this._log('disconnect handler error', e);
      }
    }
  };
}
