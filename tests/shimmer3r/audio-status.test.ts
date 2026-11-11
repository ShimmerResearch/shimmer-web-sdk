/**
 * The audio recorder over Bluetooth (DEV-99): `supportsAudio`, which decides
 * whether byte 233 is offered, and `getAudioStatus` (0xBC → `[ACK][0xBD][32]`).
 *
 * LogAndStream_Shimmer3R v1.01.026 is the first release with audio, and its
 * version answers on its own. The development builds before it that have
 * audio report the release they were cut from, v1.01.025, so there the client
 * asks. 0xBC was never a command before DEV-99 and takes no arguments, so
 * firmware without audio drops it and sends nothing: the probe times out.
 */
import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import {
  shimmer3RMayRecordAudio,
  shimmer3RRecordsAudio,
} from '../../src/devices/shimmer3/protocol.js';
import { FW_ID, HW_ID } from '../../src/devices/infomem/layout.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { appendCrc, CRC_MODE, type CrcMode } from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { AUDIO_FAULT, AUDIO_STATE } from '../../src/devices/audio/status.js';
import { versionReply, type FwTuple } from './configFirmware.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const INQUIRY_BODY = [OPCODES.INQUIRY_RESPONSE, 0x80, 0x02, 0, 0, 0, 0, 0, 0, 0, 3, 1, 0, 1, 2];

/** A development build with audio reports the release before it. */
const FW_AUDIO: FwTuple = [3, 1, 1, 25];
/** The release before that. */
const FW_OLDER: FwTuple = [3, 1, 1, 24];
/** The first release with audio. */
const FW_RELEASE: FwTuple = [3, 1, 1, 26];

/** The status payload of a unit four minutes into a raw audio and fingerprint session. */
const STATUS: number[] = [
  1, // version
  2, // mode: fingerprint and raw
  AUDIO_STATE.RECORDING,
  AUDIO_FAULT.OVERRUN,
  0xf0,
  0x00,
  0x00,
  0x00, // 240 s
  0x00,
  0x00,
  0x01,
  0x00, // 65536 silence samples
  0x8c,
  0x00, // 140 escape drains
  0x00,
  0x00, // no write errors
  0x0e,
  0x01,
  0x00,
  0x00, // 270 ADF errors
  0x0a,
  0x01,
  0x00,
  0x00, // 266 of them saturation
  0x3b,
  0x00,
  0x00,
  0x00, // 59 chunks
  0x03,
  0x00,
  0x00,
  0x00, // 3 skipped
];

const LINKS = [
  { name: 'BLE', framed: true },
  { name: 'classic SPP', framed: false },
] as const;
const MODES = [CRC_MODE.OFF, CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE] as const;

async function device(
  link: (typeof LINKS)[number],
  mode: CrcMode,
  opts: { fw?: FwTuple; hasAudio?: boolean } = {},
) {
  const t = new LoopbackTransport({ capabilities: { framed: link.framed } });
  const fw = opts.fw ?? FW_AUDIO;
  const dev = { crc: CRC_MODE.OFF as CrcMode, written: [] as number[] };
  t.setOnWrite((bytes, tr) => {
    const op = bytes[0];
    dev.written.push(op);
    const reply = (msg: number[]): void => {
      const packet = appendCrc(new Uint8Array(msg), dev.crc);
      setTimeout(() => tr.notify(packet), 0);
    };
    const version = versionReply(op, undefined, fw);
    if (version) reply(version);
    else if (op === OPCODES.INQUIRY_COMMAND) reply([ACK, ...INQUIRY_BODY]);
    else if (op === OPCODES.SET_CRC_COMMAND) {
      dev.crc = bytes[1] as CrcMode;
      reply([ACK]);
    } else if (op === OPCODES.GET_AUDIO_STATUS_COMMAND) {
      // Firmware without audio drops the unknown byte and sends nothing.
      if (opts.hasAudio !== false) reply([ACK, OPCODES.AUDIO_STATUS_RESPONSE, ...STATUS]);
    } else reply([ACK]);
  });
  const client = new Shimmer3RClient({ debug: false });
  await client.connect(t);
  await client.inquiry();
  if (mode !== CRC_MODE.OFF) await client.setCrcMode(mode);
  return { client, t, dev };
}

describe('getAudioStatus', () => {
  for (const link of LINKS) {
    for (const mode of MODES) {
      it(`decodes the 32-byte reply (${link.name}, CRC mode ${mode})`, async () => {
        const s = await device(link, mode);
        await expect(s.client.getAudioStatus()).resolves.toEqual({
          version: 1,
          mode: 2,
          state: AUDIO_STATE.RECORDING,
          fault: AUDIO_FAULT.OVERRUN,
          seconds: 240,
          silenceSamples: 65536,
          escapeDrains: 140,
          writeErrors: 0,
          adfErrors: 270,
          adfSaturation: 266,
          fingerprintChunks: 59,
          fingerprintChunksSkipped: 3,
        });
      });
    }
  }
});

describe('supportsAudio', () => {
  for (const link of LINKS) {
    it(`is true when the unit answers the probe, and asks once a link (${link.name})`, async () => {
      const s = await device(link, CRC_MODE.TWO_BYTE);
      await expect(s.client.supportsAudio()).resolves.toBe(true);
      await expect(s.client.supportsAudio()).resolves.toBe(true);
      expect(s.dev.written.filter((op) => op === OPCODES.GET_AUDIO_STATUS_COMMAND)).toHaveLength(1);
    });

    it(`is true from v1.01.026, the first release with audio, without asking (${link.name})`, async () => {
      const s = await device(link, CRC_MODE.OFF, { fw: FW_RELEASE });
      await expect(s.client.supportsAudio()).resolves.toBe(true);
      await expect(s.client.supportsAudio()).resolves.toBe(true);
      expect(s.dev.written).not.toContain(OPCODES.GET_AUDIO_STATUS_COMMAND);
    });

    it(`never asks firmware older than the builds with audio (${link.name})`, async () => {
      const s = await device(link, CRC_MODE.OFF, { fw: FW_OLDER });
      await expect(s.client.supportsAudio()).resolves.toBe(false);
      expect(s.dev.written).not.toContain(OPCODES.GET_AUDIO_STATUS_COMMAND);
    });

    it(`is false when the probe goes unanswered, and remembers it (${link.name})`, async () => {
      const s = await device(link, CRC_MODE.OFF, { hasAudio: false });
      await expect(s.client.supportsAudio()).resolves.toBe(false);
      await expect(s.client.supportsAudio()).resolves.toBe(false);
      expect(s.dev.written.filter((op) => op === OPCODES.GET_AUDIO_STATUS_COMMAND)).toHaveLength(1);
      // The link is still usable after the silence.
      await expect(s.client.readFwVersion()).resolves.toMatchObject({ minor: 1, patch: 25 });
    });
  }

  it('never asks a unit that is not LogAndStream', async () => {
    const s = await device(LINKS[0], CRC_MODE.OFF, { fw: [1, 1, 1, 25] });
    await expect(s.client.supportsAudio()).resolves.toBe(false);
    expect(s.dev.written).not.toContain(OPCODES.GET_AUDIO_STATUS_COMMAND);
  });

  it('asks again after a reconnect, which may be to a different sensor', async () => {
    const s = await device(LINKS[0], CRC_MODE.OFF);
    await s.client.supportsAudio();
    await s.client.disconnect();
    await s.client.connect(s.t);
    await s.client.supportsAudio();
    expect(s.dev.written.filter((op) => op === OPCODES.GET_AUDIO_STATUS_COMMAND)).toHaveLength(2);
  });
});

describe('the audio version gates', () => {
  const v = (internal: number, minor = 1, firmwareIdentifier: number = FW_ID.LOGANDSTREAM) => ({
    firmwareIdentifier,
    major: 1,
    minor,
    internal,
  });

  it('say yes from v1.01.026, ask on v1.01.025, and rule out older firmware', () => {
    const cases: [ReturnType<typeof v>, boolean, boolean][] = [
      [v(24), false, false],
      [v(25), true, false],
      [v(26), true, true],
      [v(27), true, true],
      [v(0, 2), true, true], // v1.02.000
    ];
    for (const [fw, may, records] of cases) {
      expect(shimmer3RMayRecordAudio(fw, HW_ID.SHIMMER_3R), JSON.stringify(fw)).toBe(may);
      expect(shimmer3RRecordsAudio(fw, HW_ID.SHIMMER_3R), JSON.stringify(fw)).toBe(records);
    }
  });

  it('say no for a Shimmer3, which has no microphone, and for other firmware', () => {
    expect(shimmer3RMayRecordAudio(v(26), HW_ID.SHIMMER_3)).toBe(false);
    expect(shimmer3RRecordsAudio(v(26), HW_ID.SHIMMER_3)).toBe(false);
    expect(shimmer3RRecordsAudio(v(26, 1, FW_ID.SDLOG), HW_ID.SHIMMER_3R)).toBe(false);
  });
});
