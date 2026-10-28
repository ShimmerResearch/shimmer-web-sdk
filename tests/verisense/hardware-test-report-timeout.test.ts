import { describe, it, expect, vi, afterEach } from 'vitest';
import { VerisenseBleDevice } from '../../src/devices/verisense/VerisenseClient.js';

// runHardwareTestReport's timeoutMs is an inactivity timeout: the report is
// given up only when the device has sent nothing for that long. It used to be a
// cap on the whole report, which cut off a long report that was still
// streaming - a NAND diagnostic build printing progress dots for over two
// minutes was stopped at 120 s mid-test.

const START = '//**************************** TEST START ************************************\r\n';
const END = '//***************************** TEST END *************************************//\r\n';

function makeDevice() {
  const v = new VerisenseBleDevice();
  // No transport: the start command and stopTestMode both go through
  // runTestMode, so record its payloads instead of writing them.
  const runTestMode = vi.spyOn(v, 'runTestMode').mockResolvedValue(undefined);
  const send = (text: string) => v.emit('testReportChunk', new TextEncoder().encode(text));
  return { v, runTestMode, send };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runHardwareTestReport timeout', () => {
  it('keeps a report going past timeoutMs while data keeps arriving', async () => {
    vi.useFakeTimers();
    const { v, runTestMode, send } = makeDevice();
    const report = v.runHardwareTestReport(1, 0, 0, { timeoutMs: 5000, marker: START });

    send(START);
    // 30 s of progress dots, 3 s apart: six times the timeout in total.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(3000);
      send('.');
    }
    send(`\r\n${END}`);

    const text = await report;
    expect(text).toContain('..........');
    expect(text).toContain('TEST END');
    // Only the start command: no stopTestMode was sent.
    expect(runTestMode).toHaveBeenCalledTimes(1);
    expect(Array.from(runTestMode.mock.calls[0][0] as Uint8Array)[0]).toBe(0xfe);
  });

  it('gives up after timeoutMs with no data, counted from the last chunk', async () => {
    vi.useFakeTimers();
    const { v, runTestMode, send } = makeDevice();
    const report = v.runHardwareTestReport(1, 0, 0, { timeoutMs: 5000, marker: START });
    const rejected = expect(report).rejects.toThrow(/no report data for 5000 ms/);

    await vi.advanceTimersByTimeAsync(3000);
    send('noise before the marker');
    // 7 s from the start but only 4 s since the last chunk: still waiting.
    await vi.advanceTimersByTimeAsync(4000);
    expect(runTestMode).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1100);
    await rejected;
    // The device is told to stop the report no one is reading any more.
    expect(runTestMode).toHaveBeenCalledTimes(2);
    expect(Array.from(runTestMode.mock.calls[1][0] as ArrayLike<number>)[0]).toBe(0x00);
  });
});
