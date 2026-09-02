/**
 * A scripted Shimmer3-family firmware for the radio configuration tests:
 * version replies, a 384-byte InfoMem store served and written a chunk at a
 * time, and a calibration-RAM store behind the 0x9A/0x98 commands.
 *
 * Every test runs against BOTH transport shapes, because they are the two ways
 * the same firmware bytes reach the client and they fail differently. A framed
 * (BLE) transport delivers whole messages — and a long reply as a run of
 * notifications whose continuations carry no opcode of their own; an unframed
 * byte stream delivers whatever the OS had buffered, so a reply arrives three
 * bytes at a time and the framer has to put it back together.
 */

import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { INFOMEM_SIZE } from '../../src/devices/infomem/index.js';

export const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
export const NACK = OPCODES.NACK_COMMAND_PROCESSED; // 0xFE

/** `SHIMMER_CALIB_RAM_MAX` — the firmware's calibration RAM (1024 B on both). */
export const CALIB_RAM_SIZE = 1024;

/** Hardware ids, per `ShimmerVerDetails.HW_ID`. */
export const HW = { SHIMMER3: 3, SHIMMER3R: 10 } as const;

/** `[fwId, major, minor, internal]` for FW_VERSION_RESPONSE. */
export type FwTuple = readonly [number, number, number, number];

/** Shimmer3R + LogAndStream 1.0.40 → every layout branch, flat 0/128/256. */
export const FW_SHIMMER3R: FwTuple = [3, 1, 0, 40];
/** Shimmer3 + SDLog 0.8.68 → relocated offsets but LEGACY 0x1800 addressing. */
export const FW_LEGACY_SDLOG: FwTuple = [2, 0, 8, 68];

export interface ScriptedFirmwareOptions {
  /** BLE-shaped when true (the default), a byte stream when false. */
  framed?: boolean;
  hardwareVersion?: number;
  firmware?: FwTuple;
  /** The device's InfoMem. Defaults to a fresh zeroed image. */
  store?: Uint8Array;
  /** The device's calibration RAM. Defaults to a fresh zeroed 1024 B. */
  calibRam?: Uint8Array;
  /**
   * Framed only: split each reply into notifications of this many bytes,
   * emulating the ATT payload a real link negotiates. The ACK is always its own
   * notification.
   */
  notifyBytes?: number;
  /** Answer SET_RWC with a NACK. */
  nackRtc?: boolean;
  /** Answer every SET_INFOMEM with a NACK, as the firmware does while sensing. */
  nackInfoMemWrite?: boolean;
  /**
   * Mutate the COPY served on an InfoMem read, emulating the bytes real
   * firmware diverges after a write (the MAC it overwrites, the config-delay
   * flag it rewrites) without disturbing what the write actually stored.
   */
  divergeReadback?: (bytes: Uint8Array) => void;
}

export interface ScriptedFirmware {
  t: LoopbackTransport;
  client: Shimmer3RClient;
  store: Uint8Array;
  calibRam: Uint8Array;
  /** Every command the client wrote, in order, as plain byte arrays. */
  cmds: number[][];
  /** Commands with the given opcode. */
  cmdsOf(opcode: number): number[][];
}

/**
 * Map an InfoMem page address to a store offset. Legacy MSP430 addressing puts
 * the pages at absolute 0x1800/0x1880/0x1900; newer firmware uses flat
 * 0/128/256. Both are contiguous, so one subtraction covers either.
 */
export function pageOffset(addr: number): number {
  return addr >= 0x1800 ? addr - 0x1800 : addr;
}

function deliver(
  tr: LoopbackTransport,
  framed: boolean,
  notifyBytes: number | undefined,
  messages: number[][],
): void {
  if (!framed) {
    // A byte stream: one flat run of bytes with no message boundaries, handed
    // over in the 3-byte reads a real serial port produces.
    const flat = messages.flat();
    for (let i = 0; i < flat.length; i += 3) {
      const slice = flat.slice(i, i + 3);
      setTimeout(() => tr.notify(slice), 0);
    }
    return;
  }
  for (const m of messages) {
    if (notifyBytes !== undefined && m.length > notifyBytes) {
      for (let i = 0; i < m.length; i += notifyBytes) {
        const slice = m.slice(i, i + notifyBytes);
        setTimeout(() => tr.notify(slice), 0);
      }
    } else {
      setTimeout(() => tr.notify(m), 0);
    }
  }
}

/** Connect a {@link Shimmer3RClient} to a scripted firmware. */
export async function scriptedFirmware(
  opts: ScriptedFirmwareOptions = {},
): Promise<ScriptedFirmware> {
  const framed = opts.framed ?? true;
  const hw = opts.hardwareVersion ?? HW.SHIMMER3R;
  const [fwId, fwMajor, fwMinor, fwInternal] = opts.firmware ?? FW_SHIMMER3R;
  const store = opts.store ?? new Uint8Array(INFOMEM_SIZE);
  const calibRam = opts.calibRam ?? new Uint8Array(CALIB_RAM_SIZE);
  const cmds: number[][] = [];

  const t = new LoopbackTransport({
    ...(framed ? {} : { capabilities: { framed: false } }),
    deviceName: framed ? 'Shimmer3R-BLE' : 'Shimmer3R-SPP',
  });

  t.setOnWrite((bytes, tr) => {
    const b = new Uint8Array(bytes);
    cmds.push([...b]);
    const send = (...messages: number[][]): void => deliver(tr, framed, opts.notifyBytes, messages);

    switch (b[0]) {
      case OPCODES.GET_DEVICE_VERSION_COMMAND:
        send([ACK], [OPCODES.DEVICE_VERSION_RESPONSE, hw]);
        return;
      case OPCODES.GET_FW_VERSION_COMMAND:
        send(
          [ACK],
          [
            OPCODES.FW_VERSION_RESPONSE,
            fwId & 0xff,
            (fwId >> 8) & 0xff,
            fwMajor & 0xff,
            (fwMajor >> 8) & 0xff,
            fwMinor & 0xff,
            fwInternal & 0xff,
          ],
        );
        return;
      case OPCODES.GET_INFOMEM_COMMAND: {
        const len = b[1];
        const off = pageOffset(b[2] | (b[3] << 8));
        const view = store.slice();
        opts.divergeReadback?.(view);
        send([ACK], [OPCODES.INFOMEM_RESPONSE, len, ...view.subarray(off, off + len)]);
        return;
      }
      case OPCODES.SET_INFOMEM_COMMAND: {
        if (opts.nackInfoMemWrite) {
          send([NACK]);
          return;
        }
        const len = b[1];
        const off = pageOffset(b[2] | (b[3] << 8));
        store.set(b.subarray(4, 4 + len), off);
        send([ACK]);
        return;
      }
      case OPCODES.GET_CALIB_DUMP_COMMAND: {
        const len = b[1];
        const off = b[2] | (b[3] << 8);
        const data = [...calibRam.subarray(off, off + len)];
        while (data.length < len) data.push(0);
        send([ACK], [OPCODES.RSP_CALIB_DUMP_COMMAND, len, off & 0xff, (off >> 8) & 0xff, ...data]);
        return;
      }
      case OPCODES.SET_CALIB_DUMP_COMMAND: {
        const len = b[1];
        const off = b[2] | (b[3] << 8);
        calibRam.set(b.subarray(4, 4 + len), off);
        send([ACK]);
        return;
      }
      case OPCODES.SET_RWC_COMMAND:
        send([opts.nackRtc ? NACK : ACK]);
        return;
      case OPCODES.UPD_CALIB_DUMP_COMMAND:
      case OPCODES.UPD_SDLOG_CFG_COMMAND:
      case OPCODES.START_STREAMING_COMMAND:
      case OPCODES.STOP_STREAMING_COMMAND:
        // The two streaming commands are here only so a test can put the client
        // into its sensing state, which is what the refusal cases need.
        send([ACK]);
        return;
      default:
        send([NACK]);
        return;
    }
  });

  const client = new Shimmer3RClient({ debug: false, transport: t });
  await client.connect();
  return {
    t,
    client,
    store,
    calibRam,
    cmds,
    cmdsOf: (opcode: number) => cmds.filter((c) => c[0] === opcode),
  };
}
