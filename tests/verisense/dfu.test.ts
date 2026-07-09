import { describe, it, expect, vi } from 'vitest';
import {
  VERISENSE_DFU_TRANSIENT_ERROR_REGEX,
  VERISENSE_DFU_BOOTLOADER_NAME_PREFIX,
  isRoutineVerisenseDfuLogMessage,
  verisenseDfuAttemptLabel,
  patchSecureDfuSendOperation,
  classifyVerisenseDfuError,
  promiseWithTimeout,
  isSafeFirmwareArchiveName,
  buildVerisenseDfuRequestDeviceOptions,
  setVerisenseDfuModeWithRetry,
  updateVerisenseDfuImageWithRetry,
  runVerisenseDfuUpdate,
  type VerisenseDfuImage,
} from '../../src/devices/verisense/dfu.js';

const image = (name: string): VerisenseDfuImage => ({
  type: name,
  imageFile: `${name}.bin`,
  initData: new ArrayBuffer(4),
  imageData: new ArrayBuffer(8),
});

const fakeDevice = () => {
  const gatt = { connected: true, disconnect: vi.fn(() => (gatt.connected = false)) };
  return { gatt } as unknown as BluetoothDevice & { gatt: typeof gatt };
};

describe('classifyVerisenseDfuError', () => {
  it('classifies a GATT disconnect as device-disconnected and transient', () => {
    const info = classifyVerisenseDfuError(
      new Error('NetworkError: GATT Server is disconnected. Cannot perform GATT operations.'),
    );
    expect(info.category).toBe('device-disconnected');
    expect(info.transient).toBe(true);
    expect(info.friendlyMessage).toMatch(/disconnected/i);
  });

  it('classifies the Chrome-on-Windows "unknown reason" wrapper as stack failure', () => {
    const info = classifyVerisenseDfuError(new Error('GATT operation failed for unknown reason.'));
    expect(info.category).toBe('stack-operation-failed');
    expect(info.transient).toBe(true);
  });

  it('passes DFU protocol errors through unclassified and non-transient', () => {
    const info = classifyVerisenseDfuError(new Error('Error: firmware version is too low'));
    expect(info.category).toBeNull();
    expect(info.friendlyMessage).toBeNull();
    expect(info.transient).toBe(false);
  });

  it('reports the DOMException name when present', () => {
    const err = Object.assign(new Error('GATT operation failed for unknown reason.'), {
      name: 'NotSupportedError',
    });
    expect(classifyVerisenseDfuError(err).name).toBe('NotSupportedError');
  });
});

describe('promiseWithTimeout', () => {
  it('resolves with the underlying value when fast enough', async () => {
    await expect(promiseWithTimeout(Promise.resolve(42), 1000, 'op')).resolves.toBe(42);
  });

  it('rejects after the timeout with a transient-matching message', async () => {
    const never = new Promise(() => {});
    const err = await promiseWithTimeout(never, 10, 'Enter DFU mode').catch((e) => e);
    expect(String(err)).toMatch(/Enter DFU mode timed out after 10ms/);
    // Must match the transient regex so the retry helpers pick it up.
    expect(VERISENSE_DFU_TRANSIENT_ERROR_REGEX.test(String(err))).toBe(true);
  });
});

describe('patchSecureDfuSendOperation', () => {
  const makeCtor = () => {
    const proto = {
      notifyFns: {} as Record<
        number,
        { resolve: (v: unknown) => void; reject: (e: unknown) => void }
      >,
      log: vi.fn(),
      delayPromise: () => Promise.resolve(),
      sendOperation: undefined as unknown as (
        c: { writeValue(v: BufferSource): Promise<unknown> },
        op: ArrayLike<number>,
        buf?: ArrayBuffer,
      ) => Promise<unknown>,
    };
    return { prototype: proto };
  };

  it('rejects (instead of hanging) when the write fails twice', async () => {
    const ctor = makeCtor();
    patchSecureDfuSendOperation(ctor);
    const characteristic = { writeValue: vi.fn().mockRejectedValue(new Error('write failed')) };
    const err = await ctor.prototype.sendOperation
      .call(ctor.prototype, characteristic, [0x06])
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/write failed/);
    expect(characteristic.writeValue).toHaveBeenCalledTimes(2);
    // The pending-notify entry must be cleaned up.
    expect(ctor.prototype.notifyFns[0x06]).toBeUndefined();
  });

  it('resolves via the notification callback on a successful write', async () => {
    const ctor = makeCtor();
    patchSecureDfuSendOperation(ctor);
    const characteristic = { writeValue: vi.fn().mockResolvedValue(undefined) };
    const pending = ctor.prototype.sendOperation.call(ctor.prototype, characteristic, [0x06]);
    // Simulate the DFU control-point notification arriving.
    await Promise.resolve();
    ctor.prototype.notifyFns[0x06].resolve('response');
    await expect(pending).resolves.toBe('response');
  });

  it('retries once after a single write failure', async () => {
    const ctor = makeCtor();
    patchSecureDfuSendOperation(ctor);
    const characteristic = {
      writeValue: vi
        .fn()
        .mockRejectedValueOnce(new Error('first write failed'))
        .mockResolvedValue(undefined),
    };
    const pending = ctor.prototype.sendOperation.call(ctor.prototype, characteristic, [0x01]);
    await vi.waitFor(() => expect(characteristic.writeValue).toHaveBeenCalledTimes(2));
    ctor.prototype.notifyFns[0x01].resolve('ok');
    await expect(pending).resolves.toBe('ok');
  });
});

describe('setVerisenseDfuModeWithRetry', () => {
  it('retries transient errors after a full GATT reset', async () => {
    const device = fakeDevice();
    const setDfuMode = vi
      .fn()
      .mockRejectedValueOnce(new Error('GATT Server is disconnected'))
      .mockResolvedValue(device);
    const onRetry = vi.fn();
    const result = await setVerisenseDfuModeWithRetry({ setDfuMode, update: vi.fn() }, device, {
      retryDelayMs: 1,
      onRetry,
    });
    expect(result).toBe(device);
    expect(setDfuMode).toHaveBeenCalledTimes(2);
    expect(device.gatt.disconnect).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'set-dfu-mode', attemptLabel: 'attempt 2 of 3' }),
    );
  });

  it('does not retry protocol errors', async () => {
    const device = fakeDevice();
    const setDfuMode = vi.fn().mockRejectedValue(new Error('Unsupported device'));
    await expect(
      setVerisenseDfuModeWithRetry({ setDfuMode, update: vi.fn() }, device, { retryDelayMs: 1 }),
    ).rejects.toThrow('Unsupported device');
    expect(setDfuMode).toHaveBeenCalledTimes(1);
  });

  it('normalises the buttonless-reboot undefined result to null', async () => {
    const device = fakeDevice();
    const setDfuMode = vi.fn().mockResolvedValue(undefined);
    await expect(
      setVerisenseDfuModeWithRetry({ setDfuMode, update: vi.fn() }, device),
    ).resolves.toBeNull();
  });

  it('gives up after the configured number of attempts', async () => {
    const device = fakeDevice();
    const setDfuMode = vi.fn().mockRejectedValue(new Error('connection lost'));
    await expect(
      setVerisenseDfuModeWithRetry({ setDfuMode, update: vi.fn() }, device, {
        attempts: 3,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow('connection lost');
    expect(setDfuMode).toHaveBeenCalledTimes(3);
  });

  it('clamps 0/negative/NaN attempts to at least one attempt', async () => {
    for (const attempts of [0, -2, Number.NaN]) {
      const device = fakeDevice();
      const setDfuMode = vi.fn().mockRejectedValue(new Error('connection lost'));
      await expect(
        setVerisenseDfuModeWithRetry({ setDfuMode, update: vi.fn() }, device, {
          attempts,
          retryDelayMs: 1,
        }),
      ).rejects.toThrow('connection lost');
      // 0/negative clamp to a single attempt; NaN falls back to the default (3).
      expect(setDfuMode.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(setDfuMode.mock.calls.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('updateVerisenseDfuImageWithRetry', () => {
  it('retries connection-level failures of the transfer', async () => {
    const device = fakeDevice();
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error('device no longer in range'))
      .mockResolvedValue(undefined);
    const statuses: string[] = [];
    await updateVerisenseDfuImageWithRetry({ setDfuMode: vi.fn(), update }, device, image('app'), {
      retryDelayMs: 1,
      onStatus: (m) => statuses.push(m),
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(statuses.some((s) => /Reconnecting to bootloader \(attempt 2 of 3\)/.test(s))).toBe(
      true,
    );
  });

  it('rethrows DFU protocol errors immediately', async () => {
    const device = fakeDevice();
    const update = vi.fn().mockRejectedValue(new Error('firmware version is too low'));
    await expect(
      updateVerisenseDfuImageWithRetry({ setDfuMode: vi.fn(), update }, device, image('app'), {
        retryDelayMs: 1,
      }),
    ).rejects.toThrow(/firmware version is too low/);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('runVerisenseDfuUpdate', () => {
  it('transfers the base image, waits for the reboot, then the app image', async () => {
    const device = fakeDevice();
    const update = vi.fn().mockResolvedValue(undefined);
    const statuses: string[] = [];
    await runVerisenseDfuUpdate(
      { setDfuMode: vi.fn(), update },
      device,
      {
        getBaseImage: () => Promise.resolve(image('softdevice_bootloader')),
        getAppImage: () => Promise.resolve(image('application')),
      },
      { rebootDelayMs: 1, retryDelayMs: 1, onStatus: (m) => statuses.push(m) },
    );
    expect(update).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([
      'Updating softdevice_bootloader: softdevice_bootloader.bin...',
      'SoftDevice/bootloader installed - device rebooting...',
      'Updating application: application.bin...',
    ]);
  });

  it('resumes an interrupted combined update when the base image is already installed', async () => {
    const device = fakeDevice();
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error('Error: firmware version is too low'))
      .mockResolvedValue(undefined);
    const statuses: string[] = [];
    await runVerisenseDfuUpdate(
      { setDfuMode: vi.fn(), update },
      device,
      {
        getBaseImage: () => Promise.resolve(image('softdevice_bootloader')),
        getAppImage: () => Promise.resolve(image('application')),
      },
      { rebootDelayMs: 1, retryDelayMs: 1, onStatus: (m) => statuses.push(m) },
    );
    expect(update).toHaveBeenCalledTimes(2);
    expect(statuses.some((s) => /already up to date - continuing with application/.test(s))).toBe(
      true,
    );
  });

  it('handles app-only packages (no base image)', async () => {
    const device = fakeDevice();
    const update = vi.fn().mockResolvedValue(undefined);
    await runVerisenseDfuUpdate(
      { setDfuMode: vi.fn(), update },
      device,
      {
        getBaseImage: () => Promise.resolve(null),
        getAppImage: () => Promise.resolve(image('application')),
      },
      { rebootDelayMs: 1, retryDelayMs: 1 },
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('propagates non-resumable base-image errors', async () => {
    const device = fakeDevice();
    const update = vi.fn().mockRejectedValue(new Error('signature mismatch'));
    await expect(
      runVerisenseDfuUpdate(
        { setDfuMode: vi.fn(), update },
        device,
        {
          getBaseImage: () => Promise.resolve(image('softdevice_bootloader')),
          getAppImage: () => Promise.resolve(image('application')),
        },
        { rebootDelayMs: 1, retryDelayMs: 1 },
      ),
    ).rejects.toThrow('signature mismatch');
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('small DFU helpers', () => {
  it('labels retry attempts counting down from the total', () => {
    expect(verisenseDfuAttemptLabel(3)).toBe('attempt 2 of 3');
    expect(verisenseDfuAttemptLabel(2)).toBe('attempt 3 of 3');
  });

  it('filters routine retransmission log noise', () => {
    expect(isRoutineVerisenseDfuLogMessage('object failed to validate, retrying')).toBe(true);
    expect(isRoutineVerisenseDfuLogMessage('crc mismatch, re-creating object')).toBe(true);
    expect(isRoutineVerisenseDfuLogMessage('starting DFU transfer')).toBe(false);
  });

  it('accepts only plain .zip firmware names', () => {
    expect(isSafeFirmwareArchiveName('ASM_IMU_FW_V2.00.013.zip')).toBe(true);
    expect(isSafeFirmwareArchiveName('../../evil.zip')).toBe(false);
    expect(isSafeFirmwareArchiveName('sub/dir.zip')).toBe(false);
    expect(isSafeFirmwareArchiveName('back\\slash.zip')).toBe(false);
    expect(isSafeFirmwareArchiveName('not-a-zip.bin')).toBe(false);
    expect(isSafeFirmwareArchiveName(42)).toBe(false);
  });

  it('builds a bootloader-only picker filter with the DFU service granted', () => {
    const opts = buildVerisenseDfuRequestDeviceOptions('fe59');
    expect(opts.filters).toEqual([{ namePrefix: VERISENSE_DFU_BOOTLOADER_NAME_PREFIX }]);
    expect(opts.optionalServices).toEqual(['fe59']);
  });
});
