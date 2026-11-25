import { describe, it, expect } from 'vitest';
import { VerisenseBleDevice } from '../../src/devices/verisense/VerisenseClient.js';
import {
  ASM_COMMAND,
  ASM_PROPERTY,
  DEBUG_COMMAND_ID,
  HUB_FW_UPLOAD_STAGE,
  MSBL,
  type AsmProperty,
} from '../../src/devices/verisense/constants.js';
import { buildHeader, buildMessage } from '../../src/devices/verisense/protocol.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

// DEV-1522. BEGIN erases the MAX32674C hub's application, and neither the
// device nor the SDK read the image's target, so a .msbl for another part went
// straight through: the only .msbl files in the Projects share are MAX32664C
// images (target "MAX32660"), which pass the length check. uploadHubFirmware
// now refuses any image whose header does not say "msbl" and "MAX32670" before
// it sends a byte.

const ERASED = Array.from(new Uint8Array(56).fill(0xff));
const HUB_VERSION = '50.4.4';

/** A minimal .msbl: the 0x4C-byte header, `pages` pages and the 4-byte trailer. */
function msblImage(
  target: string,
  { magic = MSBL.MAGIC, pages = 1 }: { magic?: string; pages?: number } = {},
): Uint8Array {
  const img = new Uint8Array(MSBL.HEADER_SIZE + pages * MSBL.PAGE_FILE_BYTES + 4);
  img.set(new TextEncoder().encode(magic), 0);
  img.set(new TextEncoder().encode(target), MSBL.OFF_TARGET); // NUL-padded, as ADI's are
  img.set(new TextEncoder().encode('AES-192'), 0x18);
  img[MSBL.OFF_NUMPAGES] = pages & 0xff;
  img[MSBL.OFF_NUMPAGES + 1] = pages >> 8;
  return img;
}

/**
 * A connected device that answers like the firmware's hub updater: an ACK for
 * every WRITE except a mid-page chunk, which gets no reply, and the hub's
 * version with the END ACK.
 */
async function connectedDevice(): Promise<{ v: VerisenseBleDevice; t: LoopbackTransport }> {
  const t = new LoopbackTransport();
  t.setOnWrite((bytes, tr) => {
    const command = bytes[0] & 0xf0;
    const property = (bytes[0] & 0x0f) as AsmProperty;
    if (command === ASM_COMMAND.READ) {
      setTimeout(() => tr.notify(buildMessage(ASM_COMMAND.RESPONSE, property, ERASED)), 0);
      return;
    }
    if (command !== ASM_COMMAND.WRITE) return;
    const isHubUpload =
      property === ASM_PROPERTY.DEBUG_COMMAND && bytes[3] === DEBUG_COMMAND_ID.HUB_FW_UPLOAD;
    if (isHubUpload && bytes[4] === HUB_FW_UPLOAD_STAGE.PAGE_CHUNK) {
      const payloadLen = bytes[1] | (bytes[2] << 8);
      const off = bytes[7] | (bytes[8] << 8);
      if (off + (payloadLen - 6) < MSBL.PAGE_FILE_BYTES) return; // mid-page: no reply
    }
    const reply =
      isHubUpload && bytes[4] === HUB_FW_UPLOAD_STAGE.END
        ? buildMessage(ASM_COMMAND.ACK, property, new TextEncoder().encode(HUB_VERSION))
        : [buildHeader(ASM_COMMAND.ACK, property), 0x00, 0x00];
    setTimeout(() => tr.notify(reply), 0);
  });
  const v = new VerisenseBleDevice({ debug: false, transport: t });
  await v.connect();
  return { v, t };
}

describe('uploadHubFirmware refuses an image for another part (DEV-1522)', () => {
  it('refuses a MAX32664 image (target MAX32660) without sending anything', async () => {
    const { v, t } = await connectedDevice();
    const before = t.writes.length;
    await expect(v.uploadHubFirmware(msblImage('MAX32660'))).rejects.toThrow(
      /built for "MAX32660", not the MAX32674C algorithm hub \(expected "MAX32670"\).*not erased/,
    );
    expect(t.writes.length).toBe(before);
  });

  it('refuses a file that is not a .msbl, naming what it starts with', async () => {
    const { v, t } = await connectedDevice();
    const before = t.writes.length;
    const zip = msblImage('MAX32670', { magic: 'PK\x03\x04' });
    await expect(v.uploadHubFirmware(zip)).rejects.toThrow(
      /not a \.msbl image \(header starts "PK\\x03\\x04", expected "msbl"\)/,
    );
    expect(t.writes.length).toBe(before);
  });

  it('refuses an empty target', async () => {
    const { v, t } = await connectedDevice();
    const before = t.writes.length;
    await expect(v.uploadHubFirmware(msblImage(''))).rejects.toThrow(/built for ""/);
    expect(t.writes.length).toBe(before);
  });

  it('flashes a MAX32670 image: BEGIN carries the header, END returns the hub version', async () => {
    const { v, t } = await connectedDevice();
    const before = t.writes.length;
    const img = msblImage('MAX32670', { pages: 2 });
    const progress: number[] = [];

    await expect(v.uploadHubFirmware(img, (done) => progress.push(done))).resolves.toBe(
      HUB_VERSION,
    );

    const begin = t.writes[before].bytes;
    expect(begin[0]).toBe(buildHeader(ASM_COMMAND.WRITE, ASM_PROPERTY.DEBUG_COMMAND));
    expect(begin[3]).toBe(DEBUG_COMMAND_ID.HUB_FW_UPLOAD);
    expect(begin[4]).toBe(HUB_FW_UPLOAD_STAGE.BEGIN);
    expect(Array.from(begin.subarray(5))).toEqual(Array.from(img.subarray(0, MSBL.HEADER_SIZE)));
    expect(progress).toEqual([1, 2]);
  });
});
