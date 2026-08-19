import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;

describe('Shimmer3RClient.runDataRateTest', () => {
  it('counts blasted bytes and stops the test afterwards', async () => {
    const t = new LoopbackTransport();
    let blast: ReturnType<typeof setInterval> | null = null;
    t.setOnWrite((bytes, tr) => {
      const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 1) {
        setTimeout(() => tr.notify([ACK]), 0);
        let counterVal = 0;
        blast = setInterval(() => {
          // 20 x 5-byte [0xA5][u32 counter] packets per tick
          const chunk = new Uint8Array(100);
          for (let i = 0; i < 20; i++) {
            chunk[i * 5] = OPCODES.DATA_RATE_TEST_RESPONSE;
            new DataView(chunk.buffer).setUint32(i * 5 + 1, counterVal++, true);
          }
          tr.notify(chunk);
        }, 5);
      } else if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 0) {
        if (blast) clearInterval(blast);
        blast = null;
        setTimeout(() => tr.notify([ACK]), 0);
      } else {
        setTimeout(() => tr.notify([ACK]), 0);
      }
    });

    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const progress: number[] = [];
    const res = await client.runDataRateTest(300, (b) => progress.push(b));
    expect(blast).toBeNull(); // stop command reached the "firmware"
    expect(res.bytesReceived).toBeGreaterThan(1000);
    expect(res.kBps).toBeGreaterThan(0);
    expect(res.durationMs).toBeGreaterThanOrEqual(300);
    expect(progress.length).toBeGreaterThan(0);
  });
});
