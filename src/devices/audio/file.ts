/**
 * The Shimmer3R's audio files (DEV-99), which sit beside each SD data file:
 *
 *   data/<experimentId>_<configTime>/<shimmerName>-<NNN>/<NNN>
 *   audio/<experimentId>_<configTime>/<shimmerName>-<NNN>/<NNN>.WAV   modes 2 and 3
 *   audio/<experimentId>_<configTime>/<shimmerName>-<NNN>/<NNN>.AFP   modes 1 and 2
 *
 * The WAV is a standard 16 kHz, mono, 16-bit PCM WAV whose first 512 bytes
 * also carry a `shim` chunk saying which data file it goes with and when its
 * first and last samples were captured, on the Shimmer clock. The `.AFP` file
 * holds the audio fingerprint: audfprint's landmark hashes, in chunks of 5 s
 * analysed every 4 s.
 *
 * Format: log-and-stream-common `docs/SHIMMER3R_AUDIO.md` §3.1 and §3.2; the
 * encoder is `Audio/shimmer_audio_file.c`, whose host test pins the layout.
 * All fields are little-endian.
 *
 * HARDWARE-VERIFY: decoded from the firmware's encoder and doc only; no file
 * from a unit has been read through this SDK.
 */

/** The audio files' sizes, magics and rates. */
export const AUDIO_FILE = Object.freeze({
  /** Both headers are 512 bytes, so a WAV's samples start on a card sector. */
  HEADER_LENGTH: 512,
  /** The identity block's magic, at offset 44 in both files. */
  IDENTITY_MAGIC: 'SAUD',
  /** The only identity format version this decoder knows (byte 48). */
  FORMAT_VERSION: 1,
  SAMPLE_RATE_HZ: 16000,
  /** The Shimmer clock the headers' times count: 32768 ticks a second. */
  TICKS_PER_SECOND: 32768,
} as const);

/** The fingerprint file's layout constants. */
export const AUDIO_FINGERPRINT_FILE = Object.freeze({
  MAGIC: 'SAFP',
  /** The only chunk and record layout version this decoder knows (bytes 4-5). */
  FORMAT_VERSION: 1,
  CHUNK_HEADER_LENGTH: 16,
  RECORD_LENGTH: 4,
  /** `0x4843`, `CH` on the card: finds the chunks again in a file cut short. */
  CHUNK_MARK: 0x4843,
  /** A chunk is 5 s of audio, */
  CHUNK_SAMPLES: 80000,
  /** one every 4 s, */
  CHUNK_HOP_SAMPLES: 64000,
  /** and a record's `t1` counts frames of 256 samples (16 ms). */
  FRAME_HOP_SAMPLES: 256,
} as const);

/** Why an audio file was opened, byte 51. */
export const AUDIO_FILE_OPEN_REASON = Object.freeze({
  /** The session's first file. */
  SESSION_START: 0,
  /** The data file split, and this follows it. */
  SPLIT: 1,
} as const);

/** Thrown for bytes that are not an audio file this decoder can read. */
export class AudioFileFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioFileFormatError';
  }
}

/** Bytes 44-95 and 96-131, the same in both files except where each says. */
export interface AudioFileIdentity {
  /** Byte 48: the identity block's format version, 1. */
  formatVersion: number;
  /** 10, Shimmer3R. */
  hardwareId: number;
  /** Byte 233's mode as recorded, `AUDIO_MODE`. */
  mode: number;
  /** {@link AUDIO_FILE_OPEN_REASON}. */
  openReason: number;
  /** `NNN`, the data file's number. */
  fileNumber: number;
  /**
   * The data file's initial timestamp, all 64 bits: pair the two files by it.
   * The data file's own header keeps the low 40 (bytes 251-255), so compare
   * those.
   */
  dataFileTicks: bigint;
  /** Config time, Unix seconds. */
  configTime: number;
  firmwareId: number;
  firmwareVersion: { major: number; minor: number; internal: number };
  /** Bluetooth MAC, 12 upper-case hex digits. */
  macAddress: string;
  /** The ADF's sinc5 decimation ratio. */
  decimation: number;
  /** The ADF's gain code, SCALE, which follows the microphone fitted. */
  gain: number;
  /**
   * 1 when the file closed normally. A file whose closed byte is 0 was cut
   * short, by a flat battery or a removed card: its contents are good up to
   * its length, but its sizes and summary are not.
   */
  closed: boolean;
  /** The session's first fault, `AUDIO_FAULT`; 0 if none. */
  fault: number;
  /** Writes forced ahead of other tasks to save the capture ring, since the session began. */
  escapeDrains: number;
  writeErrors: number;
  /** ADF error interrupts since the session began, */
  adfErrors: number;
  /** of them saturation, */
  adfSaturation: number;
  /** and of them overflow. */
  adfOverflow: number;
}

/** A WAV's header, decoded. */
export interface AudioWavHeader extends AudioFileIdentity {
  /** The samples' offset in the file: 512. */
  dataOffset: number;
  /** Bytes 100-103: samples in the file, as the closing summary says. 0 until it closes. */
  samplesInHeader: number;
  /** The `data` chunk's byte count, as the header says. 0 until the file closes. */
  dataBytesInHeader: number;
  /**
   * Samples the file holds: from the header when the file closed normally, and
   * otherwise from the file's length, (size − 512) / 2, when the whole file was
   * given. Null for a file cut short when only its header was given.
   */
  samples: number | null;
  /** Shimmer clock of the first sample. */
  firstSampleTicks: bigint;
  /** Shimmer clock of the last sample. 0 until the file closes. */
  lastSampleTicks: bigint;
  /** Samples written as silence after an overrun. */
  silenceSamples: number;
}

/** A fingerprint file's header, decoded. */
export interface AudioFingerprintHeader extends AudioFileIdentity {
  /** Bytes 4-5: the version of the chunk and record layout, 1. */
  layoutVersion: number;
  /** Bytes 6-7: header bytes, 512; the first chunk starts here. */
  headerLength: number;
  sampleRateHz: number;
  /** Samples in a frame, which a record's `t1` counts: 256. */
  frameHopSamples: number;
  chunkHeaderLength: number;
  recordLength: number;
  /** Samples a chunk analyses: 80000, 5 s. */
  chunkSamples: number;
  /** Samples from one chunk's start to the next's: 64000, 4 s. */
  chunkHopSamples: number;
  /** Shimmer clock of the file's first chunk. */
  firstChunkTicks: bigint;
  /** Chunks in the file, as the closing summary says. 0 until it closes. */
  chunks: number;
  /** Shimmer clock of the file's last chunk. 0 until it closes. */
  lastChunkTicks: bigint;
  /** Records in the file. 0 until it closes. */
  records: number;
  /** Chunks skipped since the session began, because the analysis fell behind. */
  chunksSkipped: number;
}

/** One landmark: audfprint's hash, and when in its chunk it occurred. */
export interface AudioFingerprintRecord {
  /** The record as stored. */
  raw: number;
  /** The frame within the chunk, 0-312, in 256-sample (16 ms) frames. */
  t1: number;
  /** Frames from the first peak to the second. */
  dt: number;
  /** (f2 − f1) & 63. */
  df: number;
  /** f1 & 127. */
  f1: number;
  /** audfprint's hash, `f1 << 25 | df << 19 | dt`. */
  hash: number;
}

/** One chunk of a fingerprint file. */
export interface AudioFingerprintChunk {
  /** The chunk's number k, from the session's first chunk; a gap is chunks skipped. */
  index: number;
  /**
   * Shimmer clock of the chunk's first sample, measured. It can be a few
   * ticks late; for alignment finer than about 0.1 ms, fit a line through a
   * file's chunk clocks.
   */
  startTicks: bigint;
  /** Records its header says follow. */
  declaredRecords: number;
  /** The records that are in the file: fewer than declared only in a chunk cut short. */
  records: AudioFingerprintRecord[];
}

/** A decoded fingerprint file. */
export interface AudioFingerprintFile {
  header: AudioFingerprintHeader;
  chunks: AudioFingerprintChunk[];
  /**
   * Whether the last chunk has fewer records than its header says, which
   * happens only in a file cut short. Ignore that chunk.
   */
  lastChunkTruncated: boolean;
  /** Bytes after the last chunk that are not a whole chunk header. */
  trailingBytes: number;
}

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 2 ** 24;
}

function i32(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
}

function u64(b: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return v;
}

function ascii(b: Uint8Array, o: number, n: number): string {
  return String.fromCharCode(...b.subarray(o, o + n));
}

/** Bytes 44-95 and the summary fields both files share. */
function parseIdentity(b: Uint8Array): AudioFileIdentity {
  const magic = ascii(b, 44, 4);
  if (magic !== AUDIO_FILE.IDENTITY_MAGIC) {
    throw new AudioFileFormatError(
      `Not a Shimmer audio file: offset 44 holds "${magic}", not "${AUDIO_FILE.IDENTITY_MAGIC}".`,
    );
  }
  const formatVersion = b[48];
  if (formatVersion !== AUDIO_FILE.FORMAT_VERSION) {
    throw new AudioFileFormatError(`Audio file format version ${formatVersion} is not supported.`);
  }
  let macAddress = '';
  for (let i = 0; i < 6; i++) macAddress += b[74 + i].toString(16).toUpperCase().padStart(2, '0');
  return {
    formatVersion,
    hardwareId: b[49],
    mode: b[50],
    openReason: b[51],
    fileNumber: u16(b, 52),
    dataFileTicks: u64(b, 56),
    configTime: u32(b, 64),
    firmwareId: u16(b, 68),
    firmwareVersion: { major: u16(b, 70), minor: b[72], internal: b[73] },
    macAddress,
    decimation: u32(b, 88),
    gain: i32(b, 92),
    closed: b[96] === 1,
    fault: b[97],
    escapeDrains: u16(b, 116),
    writeErrors: u16(b, 118),
    adfErrors: u32(b, 120),
    adfSaturation: u32(b, 124),
    adfOverflow: u32(b, 128),
  };
}

/**
 * Decode a WAV's header: `audio/<experiment>/<session>/<NNN>.WAV`. Pass the
 * whole file, or at least its first 512 bytes; with the whole file, a file cut
 * short gets its sample count from its length.
 *
 * @throws AudioFileFormatError when the bytes are not a Shimmer audio WAV
 */
export function parseAudioWavHeader(bytes: Uint8Array): AudioWavHeader {
  if (bytes.length < AUDIO_FILE.HEADER_LENGTH) {
    throw new AudioFileFormatError(
      `An audio WAV's header is ${AUDIO_FILE.HEADER_LENGTH} bytes; got ${bytes.length}.`,
    );
  }
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new AudioFileFormatError('Not a WAV: no RIFF/WAVE header.');
  }
  if (ascii(bytes, 36, 4) !== 'shim') {
    throw new AudioFileFormatError('Not a Shimmer audio WAV: no "shim" chunk at offset 36.');
  }
  const identity = parseIdentity(bytes);
  const samplesInHeader = u32(bytes, 100);
  const dataBytesInHeader = u32(bytes, 508);
  // Only a whole file says how long it is; a header alone could be either.
  const fromLength =
    bytes.length > AUDIO_FILE.HEADER_LENGTH
      ? Math.floor((bytes.length - AUDIO_FILE.HEADER_LENGTH) / 2)
      : null;
  return {
    ...identity,
    dataOffset: AUDIO_FILE.HEADER_LENGTH,
    samplesInHeader,
    dataBytesInHeader,
    samples: identity.closed ? samplesInHeader : fromLength,
    firstSampleTicks: u64(bytes, 80),
    lastSampleTicks: u64(bytes, 104),
    silenceSamples: u32(bytes, 112),
  };
}

/**
 * The Shimmer clock of sample `n` of a WAV of `count` samples, spread evenly
 * between the header's first and last sample clocks.
 *
 * The audio clock runs from the 16 MHz crystal and the Shimmer clock from the
 * 32 kHz one, so the two drift apart by however far that unit's 32 kHz crystal
 * is off, up to about 200 ms an hour. Placing samples at n / 16000 s from the
 * first would carry that error; this does not.
 *
 * @returns the time in ticks, as a fraction; null when the file has no last
 *   sample clock (a file cut short) or fewer than two samples
 */
export function audioSampleTicks(
  header: Pick<AudioWavHeader, 'firstSampleTicks' | 'lastSampleTicks'>,
  n: number,
  count: number,
): number | null {
  if (count < 2 || header.lastSampleTicks <= header.firstSampleTicks) return null;
  const first = Number(header.firstSampleTicks);
  const span = Number(header.lastSampleTicks - header.firstSampleTicks);
  return first + (n * span) / (count - 1);
}

/**
 * Decode a fingerprint file's header: `audio/<experiment>/<session>/<NNN>.AFP`.
 *
 * @throws AudioFileFormatError when the bytes are not a fingerprint file this
 *   decoder can read
 */
export function parseAudioFingerprintHeader(bytes: Uint8Array): AudioFingerprintHeader {
  if (bytes.length < 16) throw new AudioFileFormatError('Too short to be a fingerprint file.');
  const magic = ascii(bytes, 0, 4);
  if (magic !== AUDIO_FINGERPRINT_FILE.MAGIC) {
    throw new AudioFileFormatError(
      `Not a fingerprint file: starts "${magic}", not "${AUDIO_FINGERPRINT_FILE.MAGIC}".`,
    );
  }
  const layoutVersion = u16(bytes, 4);
  if (layoutVersion !== AUDIO_FINGERPRINT_FILE.FORMAT_VERSION) {
    throw new AudioFileFormatError(`Fingerprint layout version ${layoutVersion} is not supported.`);
  }
  const headerLength = u16(bytes, 6);
  const chunkHeaderLength = u16(bytes, 12);
  const recordLength = u16(bytes, 14);
  if (
    headerLength < AUDIO_FILE.HEADER_LENGTH ||
    chunkHeaderLength < AUDIO_FINGERPRINT_FILE.CHUNK_HEADER_LENGTH ||
    recordLength < AUDIO_FINGERPRINT_FILE.RECORD_LENGTH
  ) {
    throw new AudioFileFormatError(
      `Fingerprint header gives a ${headerLength}-byte header, ${chunkHeaderLength}-byte chunk ` +
        `headers and ${recordLength}-byte records; at least 512, 16 and 4 are needed.`,
    );
  }
  if (bytes.length < headerLength) {
    throw new AudioFileFormatError('Fingerprint file header is cut short.');
  }
  return {
    ...parseIdentity(bytes),
    layoutVersion,
    headerLength,
    sampleRateHz: u16(bytes, 8),
    frameHopSamples: u16(bytes, 10),
    chunkHeaderLength,
    recordLength,
    chunkSamples: u32(bytes, 16),
    chunkHopSamples: u32(bytes, 20),
    firstChunkTicks: u64(bytes, 80),
    chunks: u32(bytes, 100),
    lastChunkTicks: u64(bytes, 104),
    records: u32(bytes, 112),
    chunksSkipped: u32(bytes, 132),
  };
}

/** Decode one landmark record, a u32. */
export function parseAudioFingerprintRecord(raw: number): AudioFingerprintRecord {
  const v = raw >>> 0;
  const t1 = v & 0x1ff;
  const dt = (v >>> 9) & 0x3f;
  const df = (v >>> 15) & 0x3f;
  const f1 = (v >>> 21) & 0x7f;
  return { raw: v, t1, dt, df, f1, hash: ((f1 << 25) | (df << 19) | dt) >>> 0 };
}

/**
 * Decode a fingerprint file: its header, then each chunk header and its
 * records, by the lengths the header gives, so a later layout with longer
 * chunk headers or records still decodes.
 *
 * A file whose closed byte is 0 was cut short. Its chunks are walked by their
 * headers all the same, and a last chunk with fewer records than its header
 * says is kept, flagged {@link AudioFingerprintFile.lastChunkTruncated}, for
 * the caller to ignore. The walk stops at anything that is not a chunk mark.
 *
 * @throws AudioFileFormatError when the header cannot be read
 */
export function parseAudioFingerprintFile(bytes: Uint8Array): AudioFingerprintFile {
  const header = parseAudioFingerprintHeader(bytes);
  const chunks: AudioFingerprintChunk[] = [];
  let pos = header.headerLength;
  let lastChunkTruncated = false;
  while (pos + header.chunkHeaderLength <= bytes.length) {
    if (u16(bytes, pos) !== AUDIO_FINGERPRINT_FILE.CHUNK_MARK) break;
    const declaredRecords = u16(bytes, pos + 2);
    const chunk: AudioFingerprintChunk = {
      index: u32(bytes, pos + 4),
      startTicks: u64(bytes, pos + 8),
      declaredRecords,
      records: [],
    };
    pos += header.chunkHeaderLength;
    for (let i = 0; i < declaredRecords; i++) {
      if (pos + header.recordLength > bytes.length) break;
      chunk.records.push(parseAudioFingerprintRecord(u32(bytes, pos)));
      pos += header.recordLength;
    }
    chunks.push(chunk);
    if (chunk.records.length < declaredRecords) {
      lastChunkTruncated = true;
      break;
    }
  }
  return { header, chunks, lastChunkTruncated, trailingBytes: bytes.length - pos };
}

/**
 * The Shimmer clock of a landmark: its chunk's clock plus `t1` frames of 256
 * samples of audio clock. Over one chunk the two clocks drift by under a
 * millisecond.
 */
export function audioFingerprintRecordTicks(
  chunk: Pick<AudioFingerprintChunk, 'startTicks'>,
  record: Pick<AudioFingerprintRecord, 't1'>,
): number {
  return (
    Number(chunk.startTicks) +
    (record.t1 * AUDIO_FINGERPRINT_FILE.FRAME_HOP_SAMPLES * AUDIO_FILE.TICKS_PER_SECOND) /
      AUDIO_FILE.SAMPLE_RATE_HZ
  );
}
