/**
 * The Shimmer3R's audio files (DEV-99): the WAV's header and the fingerprint
 * file, decoded from bytes packed as the firmware packs them
 * (log-and-stream-common `docs/SHIMMER3R_AUDIO.md` §3.1 and §3.2).
 */
import { describe, it, expect } from 'vitest';
import {
  AUDIO_FILE,
  AudioFileFormatError,
  audioFingerprintRecordTicks,
  audioSampleTicks,
  parseAudioFingerprintFile,
  parseAudioFingerprintHeader,
  parseAudioFingerprintRecord,
  parseAudioWavHeader,
} from '../../src/devices/audio/file.js';
import {
  audfprintHash,
  concat,
  packFpChunkHeader,
  packFpHeader,
  packFpRecord,
  packWavHeader,
  sampleInfo,
} from './fixtures.js';

describe('parseAudioWavHeader', () => {
  it('reads every field at the offset the firmware writes it', () => {
    const h = parseAudioWavHeader(packWavHeader(sampleInfo()));
    expect(h).toMatchObject({
      formatVersion: 1,
      hardwareId: 10,
      mode: 3,
      openReason: 1,
      fileNumber: 0x0102,
      dataFileTicks: 0x0123456789abcdefn,
      configTime: 0x11223344,
      firmwareId: 3,
      firmwareVersion: { major: 1, minor: 1, internal: 26 },
      macAddress: 'CF9B9E3615BC',
      firstSampleTicks: 0x00003569d5d30000n,
      decimation: 24,
      gain: -8,
      closed: true,
      fault: 4,
      dataOffset: 512,
      samplesInHeader: 57600000,
      dataBytesInHeader: 115200000,
      samples: 57600000,
      lastSampleTicks: 0x00003569e1d30000n,
      silenceSamples: 2048,
      escapeDrains: 3,
      writeErrors: 5,
      adfErrors: 700,
      adfSaturation: 650,
      adfOverflow: 1,
    });
  });

  it('takes the sample count of a file cut short from its length, not its header', () => {
    const info = { ...sampleInfo(), closed: 0, samples: 0, lastSampleTicks: 0n };
    const file = concat([packWavHeader(info), new Uint8Array(2 * 1000 + 1)]);
    const h = parseAudioWavHeader(file);
    expect(h.closed).toBe(false);
    expect(h.samplesInHeader).toBe(0);
    expect(h.samples).toBe(1000);
    // Given only the header, a cut-short file's length is unknown.
    expect(parseAudioWavHeader(packWavHeader(info)).samples).toBeNull();
  });

  it('refuses a WAV without the shim chunk, and anything not a WAV', () => {
    const plain = packWavHeader(sampleInfo());
    plain.set([0x4c, 0x49, 0x53, 0x54], 36); // LIST
    expect(() => parseAudioWavHeader(plain)).toThrow(AudioFileFormatError);
    expect(() => parseAudioWavHeader(new Uint8Array(512))).toThrow(/RIFF/);
    expect(() => parseAudioWavHeader(new Uint8Array(100))).toThrow(/512/);
    const future = packWavHeader(sampleInfo());
    future[48] = 2;
    expect(() => parseAudioWavHeader(future)).toThrow(/version 2/);
  });

  it('places samples between the first and last clocks, not at n / 16000 s', () => {
    const h = { firstSampleTicks: 1000n, lastSampleTicks: 1000n + 32769n };
    // 16001 samples a nominal second apart at the audio clock, measured 32769 ticks
    expect(audioSampleTicks(h, 0, 16001)).toBe(1000);
    expect(audioSampleTicks(h, 16000, 16001)).toBe(1000 + 32769);
    expect(audioSampleTicks(h, 8000, 16001)).toBe(1000 + 32769 / 2);
    expect(audioSampleTicks({ firstSampleTicks: 5n, lastSampleTicks: 0n }, 1, 10)).toBeNull();
    expect(audioSampleTicks(h, 0, 1)).toBeNull();
  });
});

describe('the fingerprint file', () => {
  const fp = {
    chunks: 899,
    lastChunkTicks: 0x00003569e1d20000n,
    records: 1234567,
    chunksSkipped: 7,
  };

  it('reads its own fields, and the identity the WAV shares', () => {
    const info = { ...sampleInfo(), mode: 1 };
    const h = parseAudioFingerprintHeader(packFpHeader(info, fp));
    expect(h).toMatchObject({
      layoutVersion: 1,
      headerLength: 512,
      sampleRateHz: 16000,
      frameHopSamples: 256,
      chunkHeaderLength: 16,
      recordLength: 4,
      chunkSamples: 80000,
      chunkHopSamples: 64000,
      mode: 1,
      fileNumber: 0x0102,
      dataFileTicks: 0x0123456789abcdefn,
      firstChunkTicks: 0x00003569d5d30000n,
      closed: true,
      fault: 4,
      chunks: 899,
      lastChunkTicks: 0x00003569e1d20000n,
      records: 1234567,
      escapeDrains: 3,
      writeErrors: 5,
      adfErrors: 700,
      adfSaturation: 650,
      adfOverflow: 1,
      chunksSkipped: 7,
    });
    // Bytes 44-95 are the WAV's, byte for byte.
    const wav = parseAudioWavHeader(packWavHeader(info));
    expect(h.macAddress).toBe(wav.macAddress);
    expect(h.configTime).toBe(wav.configTime);
  });

  it("decodes a record into audfprint's hash and its frame", () => {
    const r = parseAudioFingerprintRecord(
      new DataView(packFpRecord(312, 200, 180, 62).buffer).getUint32(0, true),
    );
    expect(r).toMatchObject({ t1: 312, dt: 62, df: (180 - 200) & 63, f1: 200 & 127 });
    expect(r.hash).toBe(audfprintHash(200, 180, 62));
    const rising = parseAudioFingerprintRecord(
      new DataView(packFpRecord(0, 3, 40, 2).buffer).getUint32(0, true),
    );
    expect(rising.hash).toBe(audfprintHash(3, 40, 2));
  });

  it('walks the chunks, and keeps the numbers a skipped chunk leaves a gap in', () => {
    const file = concat([
      packFpHeader(sampleInfo(), { ...fp, chunks: 2, records: 3 }),
      packFpChunkHeader(0, 100000n, 2),
      packFpRecord(1, 10, 12, 3),
      packFpRecord(2, 20, 25, 4),
      packFpChunkHeader(2, 100000n + 2n * 131072n, 1),
      packFpRecord(300, 30, 31, 5),
    ]);
    const f = parseAudioFingerprintFile(file);
    expect(f.chunks.map((c) => [c.index, c.startTicks, c.records.length])).toEqual([
      [0, 100000n, 2],
      [2, 362144n, 1],
    ]);
    expect(f.chunks[1].records[0].hash).toBe(audfprintHash(30, 31, 5));
    expect(f.lastChunkTruncated).toBe(false);
    expect(f.trailingBytes).toBe(0);
    // t1 300 frames of 256 samples at 16 kHz is 4.8 s, 157286.4 ticks.
    expect(audioFingerprintRecordTicks(f.chunks[1], f.chunks[1].records[0])).toBeCloseTo(
      362144 + 157286.4,
      6,
    );
  });

  it('flags a last chunk cut short, and stops at anything that is not a chunk', () => {
    const cut = concat([
      packFpHeader(
        { ...sampleInfo(), closed: 0 },
        { chunks: 0, lastChunkTicks: 0n, records: 0, chunksSkipped: 0 },
      ),
      packFpChunkHeader(0, 5n, 1),
      packFpRecord(1, 1, 2, 3),
      packFpChunkHeader(1, 6n, 3),
      packFpRecord(1, 1, 2, 3),
      new Uint8Array([0xaa, 0xbb]),
    ]);
    const f = parseAudioFingerprintFile(cut);
    expect(f.header.closed).toBe(false);
    expect(f.chunks.map((c) => [c.declaredRecords, c.records.length])).toEqual([
      [1, 1],
      [3, 1],
    ]);
    expect(f.lastChunkTruncated).toBe(true);

    const junk = concat([packFpHeader(sampleInfo(), fp), new Uint8Array(20)]);
    const j = parseAudioFingerprintFile(junk);
    expect(j.chunks).toEqual([]);
    expect(j.trailingBytes).toBe(20);
  });

  it('refuses another magic, a later layout and a short header', () => {
    const wav = packWavHeader(sampleInfo());
    expect(() => parseAudioFingerprintHeader(wav)).toThrow(/SAFP/);
    const later = packFpHeader(sampleInfo(), fp);
    later[4] = 2;
    expect(() => parseAudioFingerprintHeader(later)).toThrow(/version 2/);
    expect(() =>
      parseAudioFingerprintHeader(packFpHeader(sampleInfo(), fp).subarray(0, 300)),
    ).toThrow(/cut short/);
    expect(AUDIO_FILE.HEADER_LENGTH).toBe(512);
  });
});
