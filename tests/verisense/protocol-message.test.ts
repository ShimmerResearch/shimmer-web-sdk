import { describe, it, expect } from 'vitest';
import {
  ASM_COMMAND,
  ASM_PROPERTY,
  DEBUG_COMMAND_ID,
} from '../../src/devices/verisense/constants.js';
import {
  buildHeader,
  parseHeader,
  buildMessage,
  parseMessage,
  parsePendingEvents,
  isAckCommand,
  isNackCommand,
  computeVerisensePairingPin,
} from '../../src/devices/verisense/protocol.js';

describe('Verisense protocol header helpers', () => {
  it('buildHeader and parseHeader round-trip command/property', () => {
    const header = buildHeader(ASM_COMMAND.WRITE, ASM_PROPERTY.DEBUG_COMMAND);
    expect(header).toBe(0x29);

    const decoded = parseHeader(header);
    expect(decoded.command).toBe(ASM_COMMAND.WRITE);
    expect(decoded.property).toBe(ASM_PROPERTY.DEBUG_COMMAND);
  });

  it('classifies ACK/NACK command classes', () => {
    expect(isAckCommand(ASM_COMMAND.ACK)).toBe(true);
    expect(isAckCommand(ASM_COMMAND.ACK_NEXT_STAGE)).toBe(true);
    expect(isAckCommand(ASM_COMMAND.RESPONSE)).toBe(false);

    expect(isNackCommand(ASM_COMMAND.NACK_GENERIC)).toBe(true);
    expect(isNackCommand(ASM_COMMAND.NACK_BAD_HEADER_COMMAND)).toBe(true);
    expect(isNackCommand(ASM_COMMAND.RESPONSE)).toBe(false);
  });
});

describe('Verisense protocol message helpers', () => {
  it('builds and parses a payload-bearing message', () => {
    const msg = buildMessage(ASM_COMMAND.WRITE, ASM_PROPERTY.DEBUG_COMMAND, [DEBUG_COMMAND_ID.CLEAR_PENDING_EVENTS]);
    expect(msg).toEqual(new Uint8Array([0x29, 0x01, 0x00, 0x09]));

    const parsed = parseMessage(msg);
    expect(parsed.command).toBe(ASM_COMMAND.WRITE);
    expect(parsed.property).toBe(ASM_PROPERTY.DEBUG_COMMAND);
    expect(parsed.payloadLength).toBe(1);
    expect(parsed.payload).toEqual(new Uint8Array([0x09]));
  });

  it('builds a zero-payload message using the same framing as the protocol constants used to', () => {
    const msg = buildMessage(ASM_COMMAND.READ, ASM_PROPERTY.DATA);
    expect(msg).toEqual(new Uint8Array([0x12, 0x00, 0x00]));
  });

  it('throws when length bytes do not match payload size', () => {
    const broken = new Uint8Array([0x39, 0x02, 0x00, 0xaa]);
    expect(() => parseMessage(broken)).toThrow(/length/i);
  });

  it('parses pending-events payload into property IDs', () => {
    const pending = parsePendingEvents(new Uint8Array([0x01, 0x02, 0x05]));
    expect(pending).toEqual([
      ASM_PROPERTY.STATUS1,
      ASM_PROPERTY.DATA,
      ASM_PROPERTY.TIME,
    ]);
  });
});

describe('computeVerisensePairingPin', () => {
  it('derives the PIN from the unique identifier examples in the design document', () => {
    expect(computeVerisensePairingPin('1809260136F8')).toBe('896248');
    expect(computeVerisensePairingPin('180926013608')).toBe('896008');
    expect(computeVerisensePairingPin('19100501363F')).toBe('905063');
  });
});
