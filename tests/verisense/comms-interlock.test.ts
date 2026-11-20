import { describe, it, expect } from 'vitest';
import {
  createBlankVerisenseOperationalConfig,
  VERISENSE_OPERATIONAL_FIELD_SCHEMA,
  readVerisenseOperationalFieldValue,
  writeVerisenseOperationalFieldValue,
  enforceVerisenseCommsChannelInterlock,
  enforceVerisenseBluetoothOffFirmwareGuard,
  isVerisenseBluetoothEnabled,
  supportsVerisenseBluetoothOff,
  VERISENSE_BLUETOOTH_OFF_MIN_FW,
  type VerisenseOperationalField,
} from '../../src/devices/verisense/operationalConfig.js';
import { VerisenseBleDevice } from '../../src/devices/verisense/VerisenseClient.js';
import { ASM_COMMAND, ASM_PROPERTY } from '../../src/devices/verisense/constants.js';
import { buildHeader } from '../../src/devices/verisense/protocol.js';

const field = (key: string): VerisenseOperationalField => {
  const f = VERISENSE_OPERATIONAL_FIELD_SCHEMA.find((d) => d.key === key);
  if (!f) throw new Error(`field ${key} not found`);
  return f as VerisenseOperationalField;
};
const BLUETOOTH_EN = field('BLUETOOTH_EN');
const USB_EN = field('USB_EN');

const makeOp = (bluetooth: number, usb: number): Uint8Array => {
  const op = createBlankVerisenseOperationalConfig();
  writeVerisenseOperationalFieldValue(op, BLUETOOTH_EN, bluetooth);
  writeVerisenseOperationalFieldValue(op, USB_EN, usb);
  return op;
};

describe('enforceVerisenseCommsChannelInterlock', () => {
  it('forces both channels on when both are disabled (0/0 -> 1/1)', () => {
    const op = makeOp(0, 0);
    const changed = enforceVerisenseCommsChannelInterlock(op);
    expect(changed).toBe(true);
    expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(1);
    expect(readVerisenseOperationalFieldValue(op, USB_EN)).toBe(1);
  });

  it('leaves USB-only configs untouched (0/1)', () => {
    const op = makeOp(0, 1);
    const changed = enforceVerisenseCommsChannelInterlock(op);
    expect(changed).toBe(false);
    expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(0);
    expect(readVerisenseOperationalFieldValue(op, USB_EN)).toBe(1);
  });

  it('leaves Bluetooth-only configs untouched (1/0)', () => {
    const op = makeOp(1, 0);
    const changed = enforceVerisenseCommsChannelInterlock(op);
    expect(changed).toBe(false);
    expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(1);
    expect(readVerisenseOperationalFieldValue(op, USB_EN)).toBe(0);
  });

  it('leaves both-enabled configs untouched (1/1)', () => {
    const op = makeOp(1, 1);
    const changed = enforceVerisenseCommsChannelInterlock(op);
    expect(changed).toBe(false);
    expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(1);
    expect(readVerisenseOperationalFieldValue(op, USB_EN)).toBe(1);
  });

  it('does not disturb other GEN_CFG_0 bits when correcting', () => {
    // RECORDING_EN + DEVICE_EN set, both comms channels off.
    const op = makeOp(0, 0);
    writeVerisenseOperationalFieldValue(op, field('RECORDING_EN'), 1);
    writeVerisenseOperationalFieldValue(op, field('DEVICE_EN'), 1);
    enforceVerisenseCommsChannelInterlock(op);
    expect(readVerisenseOperationalFieldValue(op, field('RECORDING_EN'))).toBe(1);
    expect(readVerisenseOperationalFieldValue(op, field('DEVICE_EN'))).toBe(1);
    expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(1);
    expect(readVerisenseOperationalFieldValue(op, USB_EN)).toBe(1);
  });

  it('is a no-op on too-short buffers', () => {
    expect(enforceVerisenseCommsChannelInterlock(new Uint8Array(0))).toBe(false);
  });
});

// DEV-1096: before V2.01.003, ASM_Production handled USB only while its
// SoftDevice was on, and started the SoftDevice only for Bluetooth. A USB-only
// config (0/1), which the interlock allows, left such a sensor unreachable.
describe('supportsVerisenseBluetoothOff', () => {
  it('is V2.01.003', () => {
    expect(VERISENSE_BLUETOOTH_OFF_MIN_FW).toEqual({ major: 2, minor: 1, internal: 3 });
  });

  it('is false before V2.01.003 and true from it', () => {
    expect(supportsVerisenseBluetoothOff({ major: 2, minor: 1, internal: 2 })).toBe(false);
    expect(supportsVerisenseBluetoothOff({ major: 2, minor: 0, internal: 7 })).toBe(false);
    expect(supportsVerisenseBluetoothOff({ major: 1, minor: 9, internal: 99 })).toBe(false);
    expect(supportsVerisenseBluetoothOff({ major: 2, minor: 1, internal: 3 })).toBe(true);
    expect(supportsVerisenseBluetoothOff({ major: 2, minor: 2, internal: 0 })).toBe(true);
    expect(supportsVerisenseBluetoothOff({ major: 3, minor: 0, internal: 0 })).toBe(true);
  });

  it('is false when the version is unknown', () => {
    expect(supportsVerisenseBluetoothOff(null)).toBe(false);
    expect(supportsVerisenseBluetoothOff(undefined)).toBe(false);
  });
});

describe('isVerisenseBluetoothEnabled', () => {
  it('reads BLUETOOTH_EN', () => {
    expect(isVerisenseBluetoothEnabled(makeOp(1, 0))).toBe(true);
    expect(isVerisenseBluetoothEnabled(makeOp(0, 1))).toBe(false);
  });

  it('is false for a missing or too-short buffer', () => {
    expect(isVerisenseBluetoothEnabled(null)).toBe(false);
    expect(isVerisenseBluetoothEnabled(new Uint8Array(0))).toBe(false);
  });
});

describe('enforceVerisenseBluetoothOffFirmwareGuard', () => {
  it('keeps Bluetooth on for firmware before V2.01.003', () => {
    const op = makeOp(0, 1);
    expect(enforceVerisenseBluetoothOffFirmwareGuard(op, { major: 2, minor: 1, internal: 2 })).toBe(
      true,
    );
    expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(1);
    expect(readVerisenseOperationalFieldValue(op, USB_EN)).toBe(1);
  });

  it('keeps Bluetooth on for firmware older than the flag, which leaves it in EEPROM', () => {
    const op = makeOp(0, 1);
    expect(enforceVerisenseBluetoothOffFirmwareGuard(op, { major: 2, minor: 0, internal: 6 })).toBe(
      true,
    );
    expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(1);
  });

  it('keeps Bluetooth on when the version is unknown', () => {
    for (const fw of [null, undefined]) {
      const op = makeOp(0, 1);
      expect(enforceVerisenseBluetoothOffFirmwareGuard(op, fw)).toBe(true);
      expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(1);
    }
  });

  it('lets Bluetooth off through from V2.01.003', () => {
    for (const fw of [
      { major: 2, minor: 1, internal: 3 },
      { major: 2, minor: 2, internal: 0 },
    ]) {
      const op = makeOp(0, 1);
      expect(enforceVerisenseBluetoothOffFirmwareGuard(op, fw)).toBe(false);
      expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(0);
    }
  });

  it('leaves configs with Bluetooth on untouched, whatever the firmware', () => {
    const op = makeOp(1, 0);
    expect(enforceVerisenseBluetoothOffFirmwareGuard(op, null)).toBe(false);
    expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(1);
    expect(readVerisenseOperationalFieldValue(op, USB_EN)).toBe(0);
  });

  it('does not disturb other GEN_CFG_0 bits when correcting', () => {
    const op = makeOp(0, 1);
    writeVerisenseOperationalFieldValue(op, field('RECORDING_EN'), 1);
    writeVerisenseOperationalFieldValue(op, field('DEVICE_EN'), 1);
    enforceVerisenseBluetoothOffFirmwareGuard(op, { major: 2, minor: 1, internal: 2 });
    expect(readVerisenseOperationalFieldValue(op, field('RECORDING_EN'))).toBe(1);
    expect(readVerisenseOperationalFieldValue(op, field('DEVICE_EN'))).toBe(1);
    expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(1);
    expect(readVerisenseOperationalFieldValue(op, USB_EN)).toBe(1);
  });

  it('is a no-op on too-short buffers', () => {
    expect(enforceVerisenseBluetoothOffFirmwareGuard(new Uint8Array(0), null)).toBe(false);
  });
});

// The client applies the guard to every operational-config write, with the
// firmware version the sensor reports in its production config.
describe('VerisenseBleDevice.writeOperationalConfig firmware guard', () => {
  /** A production config reporting firmware major.minor.internal: bytes 9 and
   * 10, then 11-12 little-endian. */
  const prodConfigReporting = (major: number, minor: number, internal: number): Uint8Array => {
    const prod = new Uint8Array(56);
    prod[0] = 0x01;
    prod[7] = 68;
    prod[8] = 9;
    prod[9] = major;
    prod[10] = minor;
    prod[11] = internal & 0xff;
    prod[12] = (internal >> 8) & 0xff;
    return prod;
  };

  /** A client whose writes are recorded; the tests answer for the sensor. */
  const fakeClient = (productionConfig: Uint8Array | null) => {
    const v = new VerisenseBleDevice({ debug: false });
    const sent: Uint8Array[] = [];
    const record = async (b: ArrayBuffer | ArrayBufferView) => {
      sent.push(
        ArrayBuffer.isView(b)
          ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice()
          : new Uint8Array(b).slice(),
      );
    };
    (v as unknown as { tx: unknown }).tx = {
      writeValue: record,
      writeValueWithoutResponse: record,
    };
    v.productionConfig = productionConfig;
    return { v, sent };
  };

  /** Writes `op`, acknowledges it as the sensor would, and returns the config
   * that went out. */
  const writeAndAck = async (
    v: VerisenseBleDevice,
    sent: Uint8Array[],
    op: Uint8Array,
  ): Promise<Uint8Array> => {
    const done = v.writeOperationalConfig(op);
    for (let i = 0; sent.length === 0 && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const ack = new Uint8Array([
      buildHeader(ASM_COMMAND.ACK, ASM_PROPERTY.OPERATIONAL_CONFIGURATION),
      0x00,
      0x00,
    ]);
    (v as unknown as { _feedStreamBytes(c: Uint8Array): void })._feedStreamBytes(ack);
    await done;
    expect(sent).toHaveLength(1);
    return sent[0].slice(3); // after the header and the 2-byte length
  };

  it('keeps Bluetooth on for a sensor reporting V2.01.002, and leaves the caller its buffer', async () => {
    const { v, sent } = fakeClient(prodConfigReporting(2, 1, 2));
    const op = makeOp(0, 1);
    const out = await writeAndAck(v, sent, op);
    expect(readVerisenseOperationalFieldValue(out, BLUETOOTH_EN)).toBe(1);
    expect(readVerisenseOperationalFieldValue(out, USB_EN)).toBe(1);
    expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(0);
  });

  it('lets Bluetooth off through for a sensor reporting V2.01.003', async () => {
    const { v, sent } = fakeClient(prodConfigReporting(2, 1, 3));
    const out = await writeAndAck(v, sent, makeOp(0, 1));
    expect(readVerisenseOperationalFieldValue(out, BLUETOOTH_EN)).toBe(0);
    expect(readVerisenseOperationalFieldValue(out, USB_EN)).toBe(1);
  });

  it('keeps Bluetooth on when the production config is erased, so holds no version', async () => {
    const { v, sent } = fakeClient(new Uint8Array(56).fill(0xff));
    const out = await writeAndAck(v, sent, makeOp(0, 1));
    expect(readVerisenseOperationalFieldValue(out, BLUETOOTH_EN)).toBe(1);
  });

  it('keeps Bluetooth on when the version is the 0xFF sentinel, not a release', async () => {
    const { v, sent } = fakeClient(prodConfigReporting(255, 255, 65535));
    const out = await writeAndAck(v, sent, makeOp(0, 1));
    expect(readVerisenseOperationalFieldValue(out, BLUETOOTH_EN)).toBe(1);
  });

  it('reports the version it applies the guard with', () => {
    expect(fakeClient(prodConfigReporting(2, 1, 2)).v.getReportedFirmwareVersion()).toEqual({
      major: 2,
      minor: 1,
      internal: 2,
    });
    for (const prod of [
      null,
      new Uint8Array(56).fill(0xff),
      new Uint8Array(56),
      prodConfigReporting(255, 255, 65535),
    ]) {
      expect(fakeClient(prod).v.getReportedFirmwareVersion()).toBeNull();
    }
  });

  it('keeps Bluetooth on when the version cannot be read', async () => {
    const { v, sent } = fakeClient(null);
    (
      v as unknown as { readProductionConfigFromDevice(): Promise<never> }
    ).readProductionConfigFromDevice = async () => {
      throw new Error('Request timeout');
    };
    const out = await writeAndAck(v, sent, makeOp(0, 1));
    expect(readVerisenseOperationalFieldValue(out, BLUETOOTH_EN)).toBe(1);
  });

  it('does not look the version up for a write that keeps Bluetooth on', async () => {
    const { v, sent } = fakeClient(null);
    let reads = 0;
    (
      v as unknown as { readProductionConfigFromDevice(): Promise<never> }
    ).readProductionConfigFromDevice = async () => {
      reads++;
      throw new Error('Request timeout');
    };
    const out = await writeAndAck(v, sent, makeOp(1, 0));
    expect(reads).toBe(0);
    expect(readVerisenseOperationalFieldValue(out, BLUETOOTH_EN)).toBe(1);
    expect(readVerisenseOperationalFieldValue(out, USB_EN)).toBe(0);
  });
});
