/**
 * Channel format descriptor for a single Shimmer3R data channel.
 */
export interface ChannelFormat {
  /** Human-readable signal name stored in ObjectCluster fields. */
  name: string;
  /** Encoding format: i16, u16, i24, u24, i12*, u8. */
  fmt: 'i16' | 'u16' | 'i24' | 'u24' | 'i12*' | 'u8';
  /** Byte order for multi-byte values. */
  endian: 'le' | 'be';
  /** Number of bytes this channel occupies in the packet. */
  sizeBytes: number;
}

/**
 * Mapping from Shimmer3R channel ID byte to its format descriptor.
 * Channel IDs are reported in the INQUIRY_RSP payload.
 */
export const CHANNEL_FORMATS: Readonly<Record<number, ChannelFormat>> = Object.freeze({
  0x00: { name: 'LN_ACCEL_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x01: { name: 'LN_ACCEL_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x02: { name: 'LN_ACCEL_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x04: { name: 'WR_ACCEL_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x05: { name: 'WR_ACCEL_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x06: { name: 'WR_ACCEL_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x14: { name: 'HG_ACCEL_X', fmt: 'i12*', endian: 'le', sizeBytes: 2 },
  0x15: { name: 'HG_ACCEL_Y', fmt: 'i12*', endian: 'le', sizeBytes: 2 },
  0x16: { name: 'HG_ACCEL_Z', fmt: 'i12*', endian: 'le', sizeBytes: 2 },
  0x0a: { name: 'GYRO_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x0b: { name: 'GYRO_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x0c: { name: 'GYRO_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x07: { name: 'MAG_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x08: { name: 'MAG_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x09: { name: 'MAG_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x1d: { name: 'Exg1_Status', fmt: 'u8', endian: 'le', sizeBytes: 1 },
  0x20: { name: 'Exg2_Status', fmt: 'u8', endian: 'le', sizeBytes: 1 },
  0x1e: { name: 'Exg1_CH1_24Bit', fmt: 'i24', endian: 'be', sizeBytes: 3 },
  0x1f: { name: 'Exg1_CH2_24Bit', fmt: 'i24', endian: 'be', sizeBytes: 3 },
  0x21: { name: 'Exg2_CH1_24Bit', fmt: 'i24', endian: 'be', sizeBytes: 3 },
  0x22: { name: 'Exg2_CH2_24Bit', fmt: 'i24', endian: 'be', sizeBytes: 3 },
  0x23: { name: 'Exg1_CH1_16Bit', fmt: 'i16', endian: 'be', sizeBytes: 2 },
  0x24: { name: 'Exg1_CH2_16Bit', fmt: 'i16', endian: 'be', sizeBytes: 2 },
  0x25: { name: 'Exg2_CH1_16Bit', fmt: 'i16', endian: 'be', sizeBytes: 2 },
  0x26: { name: 'Exg2_CH2_16Bit', fmt: 'i16', endian: 'be', sizeBytes: 2 },
  0x12: { name: 'PPG', fmt: 'i16', endian: 'le', sizeBytes: 2 },
  0x1c: { name: 'GSR', fmt: 'u16', endian: 'le', sizeBytes: 2 },
});
