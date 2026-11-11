/**
 * Audio files built as the firmware builds them: a port of log-and-stream-common
 * `Audio/shimmer_audio_file.c` (DEV-99), filled with the values its host test
 * (`Test/host/test_audio_file.c`) uses, so the decoder is held to the offsets
 * that test pins. The MAC is a placeholder of this repository's own.
 */

export interface AudioFileInfo {
  hwId: number;
  mode: number;
  openReason: number;
  fileIndex: number;
  dataFileTs: bigint;
  configTime: number;
  fwId: number;
  fwMajor: number;
  fwMinor: number;
  fwInternal: number;
  mac: number[];
  firstSampleTicks: bigint;
  decimation: number;
  gain: number;
  closed: number;
  fault: number;
  samples: number;
  lastSampleTicks: bigint;
  silenceSamples: number;
  escapeDrains: number;
  writeErrors: number;
  adfErrorEvents: number;
  adfSaturation: number;
  adfOverflow: number;
}

/** The firmware host test's `sample()`. */
export function sampleInfo(): AudioFileInfo {
  return {
    hwId: 10,
    mode: 3,
    openReason: 1,
    fileIndex: 0x0102,
    dataFileTs: 0x0123456789abcdefn,
    configTime: 0x11223344,
    fwId: 3,
    fwMajor: 1,
    fwMinor: 1,
    fwInternal: 26,
    mac: [0x00, 0x06, 0x66, 0x66, 0x80, 0x91],
    firstSampleTicks: 0x00003569d5d30000n,
    decimation: 24,
    gain: -8,
    closed: 1,
    fault: 4,
    samples: 57600000, // an hour
    lastSampleTicks: 0x00003569e1d30000n,
    silenceSamples: 2048,
    escapeDrains: 3,
    writeErrors: 5,
    adfErrorEvents: 700,
    adfSaturation: 650,
    adfOverflow: 1,
  };
}

export interface FpSummary {
  chunks: number;
  lastChunkTicks: bigint;
  records: number;
  chunksSkipped: number;
}

const put16 = (b: Uint8Array, o: number, v: number): void => {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
};
const put32 = (b: Uint8Array, o: number, v: number): void => {
  put16(b, o, v & 0xffff);
  put16(b, o + 2, (v >>> 16) & 0xffff);
};
const put64 = (b: Uint8Array, o: number, v: bigint): void => {
  put32(b, o, Number(v & 0xffffffffn));
  put32(b, o + 4, Number((v >> 32n) & 0xffffffffn));
};
const ascii = (b: Uint8Array, o: number, s: string): void => {
  for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i);
};

function packIdentity(out: Uint8Array, info: AudioFileInfo): void {
  ascii(out, 44, 'SAUD');
  out[48] = 1;
  out[49] = info.hwId;
  out[50] = info.mode;
  out[51] = info.openReason;
  put16(out, 52, info.fileIndex);
  put64(out, 56, info.dataFileTs);
  put32(out, 64, info.configTime);
  put16(out, 68, info.fwId);
  put16(out, 70, info.fwMajor);
  out[72] = info.fwMinor;
  out[73] = info.fwInternal;
  out.set(info.mac, 74);
  put64(out, 80, info.firstSampleTicks);
  put32(out, 88, info.decimation);
  put32(out, 92, info.gain >>> 0);
}

function packSessionSummary(out: Uint8Array, info: AudioFileInfo): void {
  out[96] = info.closed;
  out[97] = info.fault;
  put16(out, 116, info.escapeDrains);
  put16(out, 118, info.writeErrors);
  put32(out, 120, info.adfErrorEvents);
  put32(out, 124, info.adfSaturation);
  put32(out, 128, info.adfOverflow);
}

/** `ShimAudioFile_packHeader`: a WAV's 512-byte header. */
export function packWavHeader(info: AudioFileInfo): Uint8Array {
  const out = new Uint8Array(512);
  const dataBytes = (info.samples * 2) >>> 0;
  ascii(out, 0, 'RIFF');
  put32(out, 4, (512 - 8 + dataBytes) >>> 0);
  ascii(out, 8, 'WAVE');
  ascii(out, 12, 'fmt ');
  put32(out, 16, 16);
  put16(out, 20, 1);
  put16(out, 22, 1);
  put32(out, 24, 16000);
  put32(out, 28, 32000);
  put16(out, 32, 2);
  put16(out, 34, 16);
  ascii(out, 36, 'shim');
  put32(out, 40, 504 - 36 - 8);
  packIdentity(out, info);
  packSessionSummary(out, info);
  put32(out, 100, info.samples);
  put64(out, 104, info.lastSampleTicks);
  put32(out, 112, info.silenceSamples);
  ascii(out, 504, 'data');
  put32(out, 508, dataBytes);
  return out;
}

/** `ShimAudioFile_packFpHeader`: a fingerprint file's 512-byte header. */
export function packFpHeader(info: AudioFileInfo, fp: FpSummary): Uint8Array {
  const out = new Uint8Array(512);
  ascii(out, 0, 'SAFP');
  put16(out, 4, 1);
  put16(out, 6, 512);
  put16(out, 8, 16000);
  put16(out, 10, 256);
  put16(out, 12, 16);
  put16(out, 14, 4);
  put32(out, 16, 80000);
  put32(out, 20, 64000);
  packIdentity(out, info);
  packSessionSummary(out, info);
  put32(out, 100, fp.chunks);
  put64(out, 104, fp.lastChunkTicks);
  put32(out, 112, fp.records);
  put32(out, 132, fp.chunksSkipped);
  return out;
}

/** `ShimAudioFile_packFpChunkHeader`. */
export function packFpChunkHeader(chunk: number, startTicks: bigint, records: number): Uint8Array {
  const out = new Uint8Array(16);
  put16(out, 0, 0x4843);
  put16(out, 2, records);
  put32(out, 4, chunk);
  put64(out, 8, startTicks);
  return out;
}

/** `ShimAudioFile_packFpRecord`, which refuses a t1 or dt that does not fit. */
export function packFpRecord(t1: number, f1: number, f2: number, dt: number): Uint8Array {
  if (t1 > 0x1ff || dt > 0x3f) throw new RangeError('does not fit');
  const df = (f2 - f1) & 0x3f;
  const out = new Uint8Array(4);
  put32(out, 0, (t1 | (dt << 9) | (df << 15) | ((f1 & 0x7f) << 21)) >>> 0);
  return out;
}

/** audfprint's hash, as `audio_fingerprint.h` `af_hash` builds it. */
export function audfprintHash(f1: number, f2: number, dt: number): number {
  return (((f1 & 0x7f) << 25) | (((f2 - f1) & 0x3f) << 19) | dt) >>> 0;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
