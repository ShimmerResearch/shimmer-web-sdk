import { describe, it, expect } from 'vitest';
import {
  createBlankVerisenseOperationalConfig,
  VERISENSE_OPERATIONAL_FIELD_SCHEMA,
  readVerisenseOperationalFieldValue,
  writeVerisenseOperationalFieldValue,
  enforceVerisenseCommsChannelInterlock,
  type VerisenseOperationalField,
} from '../../src/devices/verisense/operationalConfig.js';

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

  it('leaves Bluetooth-only configs untouched (0/1)', () => {
    const op = makeOp(0, 1);
    const changed = enforceVerisenseCommsChannelInterlock(op);
    expect(changed).toBe(false);
    expect(readVerisenseOperationalFieldValue(op, BLUETOOTH_EN)).toBe(0);
    expect(readVerisenseOperationalFieldValue(op, USB_EN)).toBe(1);
  });

  it('leaves USB-only configs untouched (1/0)', () => {
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
