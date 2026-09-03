import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

// The two stop commands are written WITHOUT waiting for their ACK
// (`stopStreaming`, `stopStreamingAndLogging`) — deliberately, so a residual
// stream tail cannot desync the wait — but the firmware ACKs them anyway. That
// ACK is therefore still in flight when a host issues its next command, and
// the client must not let it stand in for that command's own.
//
// The firmware here holds the stop's ACK and releases it the moment the NEXT
// command is written. That is deterministically what a real BLE link does by
// accident: the ACK takes tens of ms, by which time a host that asked for
// something straight after the stop has long since written it. Delivering it
// on a timer instead would make the race a flake.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
const INSTREAM = OPCODES.INSTREAM_CMD_RESPONSE; // 0x8A
const STATUS = OPCODES.STATUS_RESPONSE; // 0x71
const VBATT = OPCODES.VBATT_RESPONSE; // 0x94
const FW_RSP = OPCODES.FW_VERSION_RESPONSE; // 0x2F

/** docked, sensing, rtcSet, sdLogging, sdPresent — and usbPluggedIn in byte 1. */
const S0 = 0x2f;
const S1 = 1;

interface Scripted {
  t: LoopbackTransport;
  client: Shimmer3RClient;
}

/**
 * A device that ACKs the stop late.
 *
 * @param stopOpcode Which stop the test drives.
 * @param framed     BLE-shaped when true (ACK coalesced into one notification
 *                   with the reply that followed it), a byte stream when false.
 */
async function lateStopAck(stopOpcode: number, framed: boolean): Promise<Scripted> {
  const t = new LoopbackTransport({
    capabilities: framed ? {} : { framed: false },
    deviceName: framed ? 'Shimmer3R-BLE' : 'Shimmer3R-SPP',
  });

  /** One firmware message, or several, as the link would carry them. */
  const send = (bytes: number[], delayMs = 0): void => {
    if (framed) {
      setTimeout(() => t.notify(bytes), delayMs);
      return;
    }
    // A byte stream: whatever the OS had buffered, in 3-byte reads.
    for (let i = 0; i < bytes.length; i += 3) {
      const slice = bytes.slice(i, i + 3);
      setTimeout(() => t.notify(slice), delayMs);
    }
  };

  let stopAckHeld = false;
  t.setOnWrite((bytes) => {
    const op = bytes[0];
    if (op === stopOpcode) {
      stopAckHeld = true; // ACKed, but not yet
      return;
    }
    if (stopAckHeld) {
      stopAckHeld = false;
      send([ACK]); // …now, with the next command already on the wire
    }
    // The reply rides in the same notification as its ACK, which is what the
    // BLE module does and what puts the ACK byte in front of the message.
    switch (op) {
      case OPCODES.START_STREAMING_COMMAND:
      case OPCODES.START_SDBT_COMMAND:
        send([ACK], 1);
        return;
      case OPCODES.GET_STATUS_COMMAND:
        send([ACK, INSTREAM, STATUS, S0, S1], 1);
        return;
      case OPCODES.GET_VBATT_COMMAND:
        send([ACK, INSTREAM, VBATT, 0x00, 0x08, 0x00], 1);
        return;
      case OPCODES.GET_FW_VERSION_COMMAND:
        send([ACK, FW_RSP, 3, 0, 1, 0, 0, 40], 1);
        return;
      default:
        return;
    }
  });

  const client = new Shimmer3RClient({ debug: false, transport: t });
  await client.connect();
  return { t, client };
}

for (const framed of [true, false]) {
  const shape = framed ? 'BLE' : 'byte stream';

  describe(`Shimmer3RClient command straight after a stop (${shape})`, () => {
    it('reads the status in the same task turn as stopStreaming', async () => {
      const { client } = await lateStopAck(OPCODES.STOP_STREAMING_COMMAND, framed);
      await client.startStreaming();
      await client.stopStreaming();
      // No await in between: the stop's ACK has not landed yet.
      expect(await client.getStatus()).toMatchObject({ sdLogging: true, docked: true });
    });

    it('reads the status in the same task turn as stopStreamingAndLogging', async () => {
      const { client } = await lateStopAck(OPCODES.STOP_SDBT_COMMAND, framed);
      await client.startStreamingAndLogging();
      await client.stopStreamingAndLogging();
      expect(await client.getStatus()).toMatchObject({ sdLogging: true, docked: true });
    });

    it('reads the battery in the same task turn as a stop', async () => {
      const { client } = await lateStopAck(OPCODES.STOP_STREAMING_COMMAND, framed);
      await client.startStreaming();
      await client.stopStreaming();
      expect(await client.getBattery()).toMatchObject({ chargingStatus: expect.any(String) });
    });

    it('reads a plain-opcode reply in the same task turn as a stop', async () => {
      // `_waitForResponse`, not the instream waiter — the same hazard reaches
      // every command that reads something back, not just the 0x8A ones.
      const { client } = await lateStopAck(OPCODES.STOP_STREAMING_COMMAND, framed);
      await client.startStreaming();
      await client.stopStreaming();
      expect(await client.readFwVersion()).toMatchObject({ major: 1, minor: 0, patch: 40 });
    });
  });
}
