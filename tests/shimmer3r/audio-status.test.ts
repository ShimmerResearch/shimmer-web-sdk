/**
 * Whether a Shimmer3R records audio (DEV-99): `supportsAudio`, which decides
 * whether byte 233 is offered.
 *
 * Status byte 1 is all the link carries about audio. Bit 3 says the firmware
 * records audio and the board has a microphone (`ShimAudio_statusBits`,
 * log-and-stream-common `Audio/shimmer_audio.c`). A build with audio reports
 * the release it was cut from, v1.01.025, so the version can only rule older
 * firmware out; on v1.01.025 the client reads the status. Firmware before
 * DEV-99 sends 0 in bit 3.
 */
import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { appendCrc, CRC_MODE, type CrcMode } from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { AUDIO_STATUS_BITS } from '../../src/devices/audio/status.js';
import { versionReply, type FwTuple } from './configFirmware.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const INQUIRY_BODY = [OPCODES.INQUIRY_RESPONSE, 0x80, 0x02, 0, 0, 0, 0, 0, 0, 0, 3, 1, 0, 1, 2];

/** A build with audio reports the release before it. */
const FW_AUDIO: FwTuple = [3, 1, 1, 25];
/** The release before that. */
const FW_OLDER: FwTuple = [3, 1, 1, 24];

const LINKS = [
  { name: 'BLE', framed: true },
  { name: 'classic SPP', framed: false },
] as const;

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
    } else if (op === OPCODES.GET_STATUS_COMMAND) {
      // Docked, SD present; USB plugged in, and the audio bit as the build sets it.
      const s1 = 0x01 | (opts.hasAudio === false ? 0 : AUDIO_STATUS_BITS.AVAILABLE);
      reply([ACK, OPCODES.INSTREAM_CMD_RESPONSE, OPCODES.STATUS_RESPONSE, 0x21, s1]);
    } else reply([ACK]);
  });
  const client = new Shimmer3RClient({ debug: false });
  await client.connect(t);
  await client.inquiry();
  if (mode !== CRC_MODE.OFF) await client.setCrcMode(mode);
  return { client, t, dev };
}

const statusReads = (written: number[]): number =>
  written.filter((op) => op === OPCODES.GET_STATUS_COMMAND).length;

describe('supportsAudio', () => {
  for (const link of LINKS) {
    for (const mode of [CRC_MODE.OFF, CRC_MODE.TWO_BYTE] as const) {
      it(`is true when status byte 1 bit 3 is set, and reads it once a link (${link.name}, CRC mode ${mode})`, async () => {
        const s = await device(link, mode);
        await expect(s.client.supportsAudio()).resolves.toBe(true);
        await expect(s.client.supportsAudio()).resolves.toBe(true);
        expect(statusReads(s.dev.written)).toBe(1);
      });
    }

    it(`is false when bit 3 is clear, and remembers it (${link.name})`, async () => {
      const s = await device(link, CRC_MODE.OFF, { hasAudio: false });
      await expect(s.client.supportsAudio()).resolves.toBe(false);
      await expect(s.client.supportsAudio()).resolves.toBe(false);
      expect(statusReads(s.dev.written)).toBe(1);
    });

    it(`never asks firmware older than the builds with audio (${link.name})`, async () => {
      const s = await device(link, CRC_MODE.OFF, { fw: FW_OLDER });
      await expect(s.client.supportsAudio()).resolves.toBe(false);
      expect(statusReads(s.dev.written)).toBe(0);
    });
  }

  it('never asks a unit that is not LogAndStream', async () => {
    const s = await device(LINKS[0], CRC_MODE.OFF, { fw: [1, 1, 1, 25] });
    await expect(s.client.supportsAudio()).resolves.toBe(false);
    expect(statusReads(s.dev.written)).toBe(0);
  });

  it('sends nothing but the status read: no command a firmware might not know', async () => {
    const s = await device(LINKS[1], CRC_MODE.OFF);
    const before = s.dev.written.length;
    await s.client.supportsAudio();
    const sent = s.dev.written.slice(before);
    expect(
      sent.every((op) =>
        [
          OPCODES.GET_STATUS_COMMAND,
          OPCODES.GET_FW_VERSION_COMMAND,
          OPCODES.GET_DEVICE_VERSION_COMMAND,
        ].includes(op),
      ),
    ).toBe(true);
  });

  it('asks again after a reconnect, which may be to a different sensor', async () => {
    const s = await device(LINKS[0], CRC_MODE.OFF);
    await s.client.supportsAudio();
    await s.client.disconnect();
    await s.client.connect(s.t);
    await s.client.supportsAudio();
    expect(statusReads(s.dev.written)).toBe(2);
  });
});
