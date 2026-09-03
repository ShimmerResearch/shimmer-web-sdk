/**
 * The red-LED override: a firmware TOGGLE with no "set", so `setRedLed` has to
 * read the status bit, decide, and read it back.
 */
import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;

/**
 * A sensor that models the firmware's own bookkeeping: TOGGLE_LED flips
 * `shimmerStatus.toggleLedRedCmd`, and GET_STATUS reports it as bit 7
 * (`ShimBt_assembleStatusBytes`).
 */
async function connectedSensor(initialRedLedOn = false) {
  const t = new LoopbackTransport({ capabilities: { framed: true } });
  const state = { redLedOn: initialRedLedOn, toggles: 0, statusReads: 0 };
  t.setOnWrite((raw) => {
    const cmd = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (cmd[0] === OPCODES.TOGGLE_LED_COMMAND) {
      state.redLedOn = !state.redLedOn;
      state.toggles += 1;
      setTimeout(() => t.notify(new Uint8Array([ACK])), 0);
      return;
    }
    if (cmd[0] === OPCODES.GET_STATUS_COMMAND) {
      state.statusReads += 1;
      setTimeout(
        () =>
          t.notify(
            new Uint8Array([
              ACK,
              OPCODES.INSTREAM_CMD_RESPONSE,
              OPCODES.STATUS_RESPONSE,
              state.redLedOn ? 0x80 : 0x00,
              0x00,
            ]),
          ),
        0,
      );
      return;
    }
    setTimeout(() => t.notify(new Uint8Array([ACK])), 0);
  });
  const client = new Shimmer3RClient({ debug: false });
  await client.connect(t);
  return { t, client, state };
}

describe('Shimmer3RClient.toggleLed', () => {
  it('sends the bare toggle command and waits for its ACK', async () => {
    const { t, client, state } = await connectedSensor();
    await client.toggleLed();
    expect(state.toggles).toBe(1);
    expect(t.writes.map((w) => Array.from(w.bytes))).toContainEqual([OPCODES.TOGGLE_LED_COMMAND]);
    const status = await client.getStatus();
    expect(status.redLedOn).toBe(true);
  });

  it('writes without waiting for an ACK while streaming', async () => {
    /* Every inbound byte belongs to the data plane then, so an ACK wait would
       time out on a command the firmware did in fact run. */
    const { client, state } = await connectedSensor();
    (client as unknown as { _streaming: boolean })._streaming = true;
    await client.toggleLed();
    expect(state.toggles).toBe(1);
  });
});

describe('Shimmer3RClient.setRedLed', () => {
  it('turns the LED on from off, and verifies the sensor followed', async () => {
    const { client, state } = await connectedSensor(false);
    await expect(client.setRedLed(true)).resolves.toBe(true);
    expect(state.redLedOn).toBe(true);
    expect(state.toggles).toBe(1);
    expect(state.statusReads).toBe(2); // read, toggle, read back
  });

  it('writes nothing when the LED is already in the wanted state', async () => {
    const { client, state } = await connectedSensor(true);
    await expect(client.setRedLed(true)).resolves.toBe(true);
    expect(state.toggles).toBe(0);
    expect(state.statusReads).toBe(1);
  });

  it('is idempotent both ways', async () => {
    const { client, state } = await connectedSensor(false);
    await client.setRedLed(true);
    await client.setRedLed(true);
    expect(state.toggles).toBe(1);
    await client.setRedLed(false);
    await client.setRedLed(false);
    expect(state.toggles).toBe(2);
    expect(state.redLedOn).toBe(false);
  });

  it('refuses while streaming, because the state read it needs is lost', async () => {
    const { client, state } = await connectedSensor(false);
    (client as unknown as { _streaming: boolean })._streaming = true;
    await expect(client.setRedLed(true)).rejects.toThrow(/streaming/i);
    expect(state.toggles).toBe(0);
  });

  it('throws when the read-back does not agree', async () => {
    /* A sensor whose flag does not follow — something else moved it between
       the two reads. Reporting success would be worse than saying so. */
    const t = new LoopbackTransport({ capabilities: { framed: true } });
    t.setOnWrite((raw) => {
      const cmd = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (cmd[0] === OPCODES.GET_STATUS_COMMAND) {
        setTimeout(
          () =>
            t.notify(
              new Uint8Array([
                ACK,
                OPCODES.INSTREAM_CMD_RESPONSE,
                OPCODES.STATUS_RESPONSE,
                0x00, // always off, whatever we do
                0x00,
              ]),
            ),
          0,
        );
        return;
      }
      setTimeout(() => t.notify(new Uint8Array([ACK])), 0);
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await expect(client.setRedLed(true)).rejects.toThrow(/did not follow/i);
  });
});
