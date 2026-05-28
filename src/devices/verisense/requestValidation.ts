import { ASM_COMMAND, type AsmCommand } from './constants.js';
import { isNackCommand, type VerisenseMessage } from './protocol.js';
import type { PendingCommandRequest, VerisenseCommandResponse } from './VerisenseTypes.js';

export function defaultAcceptedCommands(command: AsmCommand): ReadonlySet<AsmCommand> {
  if (command === ASM_COMMAND.READ) return new Set<AsmCommand>([ASM_COMMAND.RESPONSE]);
  if (command === ASM_COMMAND.WRITE) {
    return new Set<AsmCommand>([ASM_COMMAND.ACK, ASM_COMMAND.ACK_NEXT_STAGE, ASM_COMMAND.RESPONSE]);
  }
  return new Set<AsmCommand>([ASM_COMMAND.ACK, ASM_COMMAND.ACK_NEXT_STAGE, ASM_COMMAND.RESPONSE]);
}

export function toCommandResponse(msg: VerisenseMessage): VerisenseCommandResponse {
  return {
    header: msg.header,
    command: msg.command,
    property: msg.property,
    payload: msg.payload,
  };
}

export function validatePendingResponse(
  pending: PendingCommandRequest,
  msg: VerisenseMessage,
): Error | null {
  if (isNackCommand(msg.command)) {
    return new Error(
      `Device returned NACK command=0x${msg.command.toString(16)} property=0x${msg.property.toString(16)}`,
    );
  }

  if (pending.acceptedProperties?.size) {
    if (!pending.acceptedProperties.has(msg.property)) {
      return new Error(
        `Unexpected response property 0x${msg.property.toString(16)} (expected one of ${Array.from(
          pending.acceptedProperties,
        )
          .map((p) => `0x${p.toString(16)}`)
          .join(', ')})`,
      );
    }
  } else if (msg.property !== pending.expectedProperty) {
    return new Error(
      `Unexpected response property 0x${msg.property.toString(16)} (expected 0x${pending.expectedProperty.toString(16)})`,
    );
  }

  if (!pending.acceptedCommands.has(msg.command)) {
    return new Error(
      `Unexpected response command 0x${msg.command.toString(16)} for property 0x${msg.property.toString(16)}`,
    );
  }

  return null;
}
