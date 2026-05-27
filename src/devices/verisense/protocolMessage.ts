import {
  ASM_COMMAND,
  type AsmCommand,
  type AsmProperty,
  type AsmProperty as PendingEventProperty,
} from './constants.js';
import { u16le } from './protocolUtils.js';

export interface VerisenseMessage {
  header: number;
  command: AsmCommand;
  property: AsmProperty;
  payloadLength: number;
  payload: Uint8Array;
}

/** Build a protocol header byte from command/property nibbles. */
export function buildHeader(command: AsmCommand, property: AsmProperty): number {
  return ((command & 0xf0) | (property & 0x0f)) & 0xff;
}

/** Decode a protocol header byte into command/property fields. */
export function parseHeader(header: number): { command: AsmCommand; property: AsmProperty } {
  return {
    command: (header & 0xf0) as AsmCommand,
    property: (header & 0x0f) as AsmProperty,
  };
}

/** Build a complete protocol message (header + 16-bit LE payload length + payload bytes). */
export function buildMessage(
  command: AsmCommand,
  property: AsmProperty,
  payloadBytes: Uint8Array | number[] = [],
): Uint8Array {
  const payload = payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array(payloadBytes);
  const out = new Uint8Array(3 + payload.length);
  out[0] = buildHeader(command, property);
  out[1] = payload.length & 0xff;
  out[2] = (payload.length >> 8) & 0xff;
  out.set(payload, 3);
  return out;
}

/** Parse a complete protocol message into structured fields. */
export function parseMessage(msg: Uint8Array): VerisenseMessage {
  if (msg.length < 3) throw new Error('Invalid Verisense message: header is incomplete');
  const header = msg[0];
  const payloadLength = u16le(msg[1], msg[2]);
  if (msg.length !== payloadLength + 3) {
    throw new Error(
      `Invalid Verisense message: length=${payloadLength}, actualPayload=${Math.max(0, msg.length - 3)}`,
    );
  }
  const { command, property } = parseHeader(header);
  return {
    header,
    command,
    property,
    payloadLength,
    payload: msg.slice(3),
  };
}

export function isAckCommand(command: AsmCommand): boolean {
  return command === ASM_COMMAND.ACK || command === ASM_COMMAND.ACK_NEXT_STAGE;
}

export function isNackCommand(command: AsmCommand): boolean {
  return (
    command === ASM_COMMAND.NACK_BAD_HEADER_COMMAND ||
    command === ASM_COMMAND.NACK_BAD_HEADER_PROPERTY ||
    command === ASM_COMMAND.NACK_GENERIC
  );
}

/** Convert a pending-events payload (property IDs) into a typed array. */
export function parsePendingEvents(payload: Uint8Array): PendingEventProperty[] {
  const out: PendingEventProperty[] = [];
  for (let i = 0; i < payload.length; i++) out.push((payload[i] & 0x0f) as PendingEventProperty);
  return out;
}