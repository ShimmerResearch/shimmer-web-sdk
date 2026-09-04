import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import { VerisenseBleDevice } from '../../src/devices/verisense/VerisenseClient.js';

// connectWithRetry() drives this.connect() in a loop; stub connect (and the
// GATT cleanup helper, which touches Web Bluetooth objects) so the retry
// policy itself can be exercised without a browser BLE stack.
// `connect` is REPLACED, not intersected: VerisenseBleDevice#connect takes an
// options object and returns Promise<boolean>, which has no overlap with the
// mock's signature, so a plain intersection reduces the whole type to `never`
// and every member access below fails.
//
// Both mocks carry the real signatures rather than `ReturnType<typeof vi.fn>`,
// which is effectively `any`: a stub that drifted from what the class declares
// would then sail through the very typecheck gate this suite now runs under.
// `_cleanupFailedBleConnectAttempt` is private, so its signature cannot be
// indexed off the class and is restated here — keep it in step with
// VerisenseClient.ts if that method changes.
type Stubbed = Omit<VerisenseBleDevice, 'connect'> & {
  connect: MockedFunction<VerisenseBleDevice['connect']>;
  _cleanupFailedBleConnectAttempt: MockedFunction<(retrySettleMs: number) => Promise<void>>;
};

function makeClient(): Stubbed {
  const v = new VerisenseBleDevice({ debug: false }) as unknown as Stubbed;
  v._cleanupFailedBleConnectAttempt = vi.fn(async () => {});
  return v;
}

const GATT_DROP = 'GATT Server is disconnected. Cannot retrieve services.';

describe('VerisenseBleDevice.connectWithRetry cancel-on-disconnect', () => {
  it('retries a transient GATT drop during bootstrap (baseline behaviour)', async () => {
    const v = makeClient();
    let attempts = 0;
    v.connect = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error(GATT_DROP);
      return true;
    });
    const onRetry = vi.fn();

    await expect(v.connectWithRetry({ maxRetries: 2, retrySettleMs: 0, onRetry })).resolves.toBe(
      true,
    );

    expect(v.connect).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0].reason).toBe('gatt-disconnected');
  });

  it('does NOT retry when the user disconnects mid-attempt', async () => {
    const v = makeClient();
    v.connect = vi.fn(async () => {
      // User clicks Disconnect while the connect attempt is hanging; the
      // teardown then surfaces as the same GATT-drop error a transient link
      // loss would produce.
      await v.disconnect({ reason: 'ui' });
      throw new Error(GATT_DROP);
    });
    const onRetry = vi.fn();

    await expect(v.connectWithRetry({ maxRetries: 2, retrySettleMs: 0, onRetry })).rejects.toThrow(
      /connect cancelled/i,
    );

    expect(v.connect).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('a disconnect from a previous session does not cancel a fresh retry loop', async () => {
    const v = makeClient();
    await v.disconnect({ reason: 'ui' });

    let attempts = 0;
    v.connect = vi.fn(async () => {
      attempts += 1;
      // Real connect() clears the cancel flag when a fresh attempt starts.
      if (attempts === 1) throw new Error(GATT_DROP);
      return true;
    });

    await expect(v.connectWithRetry({ maxRetries: 2, retrySettleMs: 0 })).resolves.toBe(true);
    expect(v.connect).toHaveBeenCalledTimes(2);
  });
});
