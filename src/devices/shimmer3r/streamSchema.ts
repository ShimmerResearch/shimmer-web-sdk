/**
 * Building the streaming packet schema from an inquiry response's channel list.
 *
 * Shared by both families: `Shimmer3RClient` (framed BLE) and
 * `buildShimmer3Schema` (unframed classic Bluetooth) put the same channel-ID
 * bytes through the same table, and any difference in how they treat a channel
 * they do not recognise would be a difference in how quietly they corrupt data.
 * So the logic lives here once.
 *
 * The packet itself carries no per-channel length — a data frame is a preamble
 * byte, a timestamp, and then the channels' bytes back to back in the order the
 * inquiry listed them. The channel ID is therefore the *only* thing that says
 * how wide a channel is, and a wrong width does not fail: it shifts every
 * channel after it and decodes plausible-looking rubbish. That is why an
 * unrecognised ID has to be reported rather than assumed away.
 */

import { TIMESTAMP_FIELD, type TimestampFmt } from './constants.js';
import { hex2 } from './protocol.js';
import { channelIdToSensorBit } from './SensorBitmap.js';
import {
  UNKNOWN_CHANNEL_ASSUMED_BYTES,
  channelLayoutDiffersByGeneration,
  isGenerationSensitiveChannel,
  resolveChannelFormat,
  type ShimmerGeneration,
} from './channelFormats.js';

/** One decoded channel within a streaming data frame. */
export interface StreamSchemaField {
  id: number;
  name: string;
  fmt: string;
  endian: string;
  sizeBytes: number;
  /**
   * True when this SDK has no description for the channel ID and
   * {@link UNKNOWN_CHANNEL_ASSUMED_BYTES} was assumed. The value decoded into
   * this field is meaningless.
   */
  assumed?: boolean;
  /**
   * False when this field's byte offset within the frame sits at or after an
   * assumed width, so the offset — and therefore the value — cannot be relied
   * on. Absent or true means the offset came entirely from described channels.
   */
  offsetTrusted?: boolean;
}

/** Describes how to slice a streaming data frame, built from an inquiry. */
export interface StreamSchemaBase {
  timestampFmt: TimestampFmt;
  fields: StreamSchemaField[];
  /** Total bytes per frame, including the preamble byte. */
  frameBytes: number;
  enabledSensors: number;
  dataPreambleByte: number;
  /** Which generation's channel table resolved the IDs. */
  generation?: ShimmerGeneration;
  /**
   * True when {@link generation} was a default rather than something the device
   * was asked for. Harmless unless the channel list contains a
   * generation-sensitive channel, in which case {@link trusted} is false.
   */
  generationAssumed?: boolean;
  /**
   * Channel IDs in the inquiry that this SDK cannot describe. Empty when every
   * channel was recognised.
   */
  unknownChannelIds?: number[];
  /**
   * False when the field offsets, and hence `frameBytes`, may not match the
   * packet the firmware is actually sending. Absent or true means they do.
   *
   * A host must check this before publishing or storing the decoded values: a
   * false here means at least one channel's width was guessed, or the hardware
   * generation was, and the numbers after that point are not measurements. The
   * fixes, in order of preference, are to update this SDK so the channel is
   * described, to call `readDeviceVersion()` before `inquiry()` so the
   * generation is known rather than assumed, or to disable the offending sensor.
   */
  trusted?: boolean;
}

/** What {@link buildStreamSchema} needs beyond the channel list. */
export interface BuildStreamSchemaOptions {
  /** Generation whose channel table resolves the IDs. */
  generation: ShimmerGeneration;
  /** True when `generation` is this SDK's default rather than the device's answer. */
  generationAssumed?: boolean;
  /** Frame preamble byte (DATA_PACKET, 0x00 on both families). */
  dataPreambleByte?: number;
  /**
   * Called once per problem found, with a sentence fit for a status log. Wired
   * to the client's `onStatus` so an unrecognised channel is visible to the
   * host rather than only to the schema.
   */
  onProblem?: (message: string) => void;
}

/**
 * Build a stream schema from the channel-ID list reported by an inquiry.
 *
 * Mirrors `ShimmerObject#interpretDataPacketFormat`, with one deliberate
 * departure: where the Java driver falls through to a default width for an
 * unrecognised signal ID, this records the guess. See
 * {@link StreamSchemaBase.trusted}.
 */
export function buildStreamSchema(
  channelIds: ArrayLike<number>,
  timestampFmt: TimestampFmt,
  opts: BuildStreamSchemaOptions,
): Required<Pick<StreamSchemaBase, 'generation' | 'unknownChannelIds' | 'trusted'>> &
  StreamSchemaBase {
  const { generation, generationAssumed = false, dataPreambleByte = 0x00, onProblem } = opts;

  const fields: StreamSchemaField[] = [];
  const ts = timestampFmt === 'u24' ? TIMESTAMP_FIELD.u24 : TIMESTAMP_FIELD.u16;
  let frameBytes = 1 + ts.sizeBytes; // 1 = preamble byte
  let enabledSensors = 0;
  const unknownChannelIds: number[] = [];
  // Once a width has been guessed every later offset is downstream of the
  // guess, so trust is lost for the rest of the frame and never regained.
  let offsetTrusted = true;

  for (let i = 0; i < channelIds.length; i++) {
    const id = channelIds[i];
    const fmt = resolveChannelFormat(id, generation);

    if (!fmt) {
      unknownChannelIds.push(id);
      // Keep the historical `CH_xx` name and 2-byte width so a packet with one
      // unfamiliar channel stays decodable up to that point, and so a consumer
      // that already reads `CH_xx` fields keeps seeing them.
      fields.push({
        id,
        name: `CH_${hex2(id)}`,
        fmt: 'i16',
        endian: 'le',
        sizeBytes: UNKNOWN_CHANNEL_ASSUMED_BYTES,
        assumed: true,
        offsetTrusted,
      });
      frameBytes += UNKNOWN_CHANNEL_ASSUMED_BYTES;
      offsetTrusted = false;
      onProblem?.(
        `Unknown channel ID 0x${hex2(id)} at position ${i} of the inquiry's channel list. ` +
          `This SDK has no width for it, so ${UNKNOWN_CHANNEL_ASSUMED_BYTES} bytes were assumed ` +
          `and every channel after it may be decoding from the wrong offset. ` +
          `Treat this frame's values as unusable (schema.trusted === false) and update the SDK.`,
      );
      continue;
    }

    fields.push({ id, ...fmt, offsetTrusted });
    frameBytes += fmt.sizeBytes;
    enabledSensors |= channelIdToSensorBit(id);
  }

  // An assumed generation only matters if something in the list actually
  // depends on it — a gyro-only packet decodes identically either way. Of the
  // channels that do differ, only those whose *layout* differs can misread the
  // frame: across the ADC block the two generations disagree about the channel's
  // name while `u16`/little-endian/2 bytes holds on both, so guessing wrong
  // there mislabels a column without moving a single offset. Reporting that as
  // untrustworthy would cry wolf on the commonest expansion-board setup, so it
  // is said out loud and the schema stays trusted.
  const sensitive = [...new Set(Array.from(channelIds).filter(isGenerationSensitiveChannel))];
  const misdecoded = sensitive.filter(channelLayoutDiffersByGeneration);
  const mislabelled = sensitive.filter((id) => !channelLayoutDiffersByGeneration(id));
  const generationMatters = generationAssumed && misdecoded.length > 0;
  if (generationMatters) {
    onProblem?.(
      `Channel(s) ${misdecoded.map((id) => `0x${hex2(id)}`).join(', ')} are decoded differently on ` +
        `a Shimmer3 and a Shimmer3R, and this schema assumed ${generation} because the device ` +
        `version has not been read. Call readDeviceVersion() before inquiry() to settle it.`,
    );
  }
  if (generationAssumed && mislabelled.length > 0) {
    onProblem?.(
      `Channel(s) ${mislabelled.map((id) => `0x${hex2(id)}`).join(', ')} carry a different name on ` +
        `a Shimmer3 and a Shimmer3R, and this schema assumed ${generation} because the device ` +
        `version has not been read. The bytes are laid out identically on both, so the frame ` +
        `decodes correctly and stays trusted — only these channel names may be wrong. Call ` +
        `readDeviceVersion() before inquiry() to settle them.`,
    );
  }

  return {
    timestampFmt,
    fields,
    frameBytes,
    enabledSensors,
    dataPreambleByte,
    generation,
    generationAssumed,
    unknownChannelIds,
    trusted: unknownChannelIds.length === 0 && !generationMatters,
  };
}
