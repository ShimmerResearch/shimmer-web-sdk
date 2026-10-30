/**
 * Configuration byte 232, against the firmware's own rules
 * (log-and-stream-common `Configuration/shimmer_button_log_mode.c`, whose host
 * test `Test/host/test_button_log_mode.c` these mirror).
 */
import { describe, it, expect } from 'vitest';
import {
  BUTTON_LOG_MODE,
  BUTTON_MODE,
  LOG_TRIGGERS,
  allowsSingleTouch,
  applyButtonLogModeRules,
  buttonModeOf,
  correctButtonLogMode,
  decodeButtonLogMode,
  describeButtonLogMode,
  doesPressToggleLogging,
  doesUndockStartLogging,
  encodeButtonLogMode,
  eventChannelBoardSupport,
  isDoublePress,
  isLoggingDisabled,
  isTtlInputEnabled,
  nearestUserButtonEnable,
  recordsButtonPresses,
  withoutPressRecording,
} from '../../src/devices/events/buttonLogMode.js';
import {
  SHIMMER3_INFOMEM_FIELD_SCHEMA,
  readInfoMemFieldValue,
  writeInfoMemFieldValue,
} from '../../src/devices/infomem/schema.js';
import { resolveInfoMemLayout, INFOMEM_SIZE } from '../../src/devices/infomem/layout.js';
import { parseInfoMem } from '../../src/devices/infomem/parse.js';
import { generateInfoMem } from '../../src/devices/infomem/generate.js';
import { CTX } from '../infomem/fixtures.js';

const ALL = Array.from({ length: 256 }, (_unused, v) => v);

describe('correctButtonLogMode', () => {
  it('reads every value the way the firmware does', () => {
    for (const raw of ALL) {
      const mode = raw & 0x07;
      const trig = (raw >> 3) & 0x03;
      let want: number;
      if (raw & 0x80) want = 0;
      else if (mode >= 1 && mode <= 5 && trig <= 2) want = raw & 0x3f;
      else want = raw & 0x20;
      expect(correctButtonLogMode(raw), `0x${raw.toString(16)}`).toBe(want);
    }
  });

  it('leaves 60 values standing, and correcting twice changes nothing', () => {
    const standing = ALL.filter((v) => correctButtonLogMode(v) === v);
    // 0, 0x20, and 5 modes x 3 triggers x TTL on/off
    expect(standing).toHaveLength(2 + 5 * 3 * 2);
    for (const raw of ALL) {
      expect(correctButtonLogMode(correctButtonLogMode(raw))).toBe(correctButtonLogMode(raw));
    }
  });

  it('reads 0xFF, what older firmware leaves, as "as before" with no TTL', () => {
    expect(decodeButtonLogMode(0xff)).toEqual({
      buttonMode: BUTTON_MODE.LEGACY,
      logTriggers: LOG_TRIGGERS.HOST,
      ttlInput: false,
    });
  });

  it('gives every query the same answer for a raw byte as for its corrected form', () => {
    for (const raw of ALL) {
      const c = correctButtonLogMode(raw);
      for (const ube of [false, true]) {
        expect(doesPressToggleLogging(raw, ube)).toBe(doesPressToggleLogging(c, ube));
        expect(doesUndockStartLogging(raw, ube)).toBe(doesUndockStartLogging(c, ube));
        expect(nearestUserButtonEnable(raw, ube)).toBe(nearestUserButtonEnable(c, ube));
      }
      expect(isTtlInputEnabled(raw)).toBe(isTtlInputEnabled(c));
      expect(recordsButtonPresses(raw)).toBe(recordsButtonPresses(c));
      expect(allowsSingleTouch(raw)).toBe(allowsSingleTouch(c));
    }
  });
});

describe('what each mode does', () => {
  it('leaves a legacy byte to userButtonEnable', () => {
    expect(doesPressToggleLogging(0, true)).toBe(true);
    expect(doesUndockStartLogging(0, true)).toBe(false);
    expect(doesPressToggleLogging(0, false)).toBe(false);
    expect(doesUndockStartLogging(0, false)).toBe(true);
    expect(doesUndockStartLogging(0, false, true)).toBe(false); // single touch
  });

  it('follows the mode table', () => {
    // [mode, press toggles, double, records]
    const table: [number, boolean, boolean, boolean][] = [
      [BUTTON_MODE.DISABLED, false, false, false],
      [BUTTON_MODE.SINGLE_PRESS, true, false, false],
      [BUTTON_MODE.DOUBLE_PRESS, true, true, false],
      [BUTTON_MODE.DOUBLE_RECORDED, true, true, true],
      [BUTTON_MODE.RECORDED, false, false, true],
    ];
    for (const [mode, toggles, double, records] of table) {
      for (const trig of [LOG_TRIGGERS.HOST, LOG_TRIGGERS.HOST_UNDOCK, LOG_TRIGGERS.NONE]) {
        const raw = mode | (trig << 3);
        expect(doesPressToggleLogging(raw, false), `mode ${mode}`).toBe(toggles);
        expect(isDoublePress(raw)).toBe(double);
        expect(recordsButtonPresses(raw)).toBe(records);
        expect(doesUndockStartLogging(raw, true)).toBe(trig === LOG_TRIGGERS.HOST_UNDOCK);
        expect(isLoggingDisabled(raw)).toBe(trig === LOG_TRIGGERS.NONE);
      }
    }
  });

  it('never adds an undock start when a host falls back to byte 217', () => {
    for (const raw of ALL) {
      if (buttonModeOf(raw) === BUTTON_MODE.LEGACY) continue;
      const ube = nearestUserButtonEnable(raw, true);
      // Legacy behaviour on the nearest userButtonEnable
      const fallbackUndock = !ube;
      if (fallbackUndock) expect(doesUndockStartLogging(raw, ube)).toBe(true);
    }
    // 0 only for "a press cannot start logging, an undock does"
    const zero = ALL.filter(
      (v) => correctButtonLogMode(v) === v && buttonModeOf(v) && !nearestUserButtonEnable(v, true),
    );
    expect(zero.map((v) => v & 0x1f).sort((a, b) => a - b)).toEqual([0x09, 0x09, 0x0d, 0x0d]);
  });

  it('takes press recording out for a board with no button edges', () => {
    expect(withoutPressRecording(0x24)).toBe(0x23);
    expect(withoutPressRecording(0x15)).toBe(0x11);
    expect(withoutPressRecording(0x0a)).toBe(0x0a);
    expect(withoutPressRecording(0xff)).toBe(0);
  });
});

describe('encodeButtonLogMode', () => {
  it('round-trips every value the firmware keeps', () => {
    for (const raw of ALL) {
      const c = correctButtonLogMode(raw);
      expect(encodeButtonLogMode(decodeButtonLogMode(c))).toBe(c);
    }
  });

  it('drops the log triggers of a legacy mode, and keeps the TTL bit', () => {
    expect(encodeButtonLogMode({ buttonMode: 0, logTriggers: 2, ttlInput: true })).toBe(0x20);
    expect(encodeButtonLogMode({ buttonMode: 9, logTriggers: 1, ttlInput: true })).toBe(0x20);
    expect(encodeButtonLogMode({ buttonMode: 1, logTriggers: 2, ttlInput: false })).toBe(0x11);
  });
});

describe('describeButtonLogMode', () => {
  it('says what button off, logging off does', () => {
    const d = describeButtonLogMode(0x11, true, true);
    expect(d).toMatchObject({
      corrected: 0x11,
      buttonDisabled: true,
      loggingDisabled: true,
      pressTogglesLogging: false,
      undockStartsLogging: false,
      userButtonEnable: true,
    });
  });

  it('works out an undock start where single touch cannot apply', () => {
    // Single touch is cleared by the firmware for mode 1, so it no longer blocks.
    expect(describeButtonLogMode(0x09, true, true).undockStartsLogging).toBe(true);
  });
});

describe('the byte 232 schema fields', () => {
  const fields = Object.fromEntries(
    SHIMMER3_INFOMEM_FIELD_SCHEMA.filter((f) => f.configKey === 'buttonLogMode').map((f) => [
      f.key,
      f,
    ]),
  );

  it('are left out of a layout whose firmware has not said it has the byte', () => {
    expect(resolveInfoMemLayout(CTX.shimmer3R).idxButtonLogMode).toBeUndefined();
    expect(resolveInfoMemLayout({ ...CTX.shimmer3R, eventChannel: true }).idxButtonLogMode).toBe(
      BUTTON_LOG_MODE.INFOMEM_OFFSET,
    );
    // Firmware that does not log to SD has no such byte whatever it says
    expect(
      resolveInfoMemLayout({ ...CTX.shimmer3R, firmwareId: 1, eventChannel: true })
        .idxButtonLogMode,
    ).toBeUndefined();
  });

  it('read a 0xFF byte as 0, and write it from 0', () => {
    const layout = resolveInfoMemLayout({ ...CTX.shimmer3R, eventChannel: true });
    const image = new Uint8Array(INFOMEM_SIZE).fill(0xff);
    for (const key of ['buttonMode', 'logTriggers', 'ttlInput']) {
      expect(readInfoMemFieldValue(image, fields[key], layout)).toBe(0);
    }
    writeInfoMemFieldValue(image, fields.buttonMode, layout, BUTTON_MODE.DISABLED);
    expect(image[232]).toBe(0x01);
    writeInfoMemFieldValue(image, fields.logTriggers, layout, LOG_TRIGGERS.NONE);
    writeInfoMemFieldValue(image, fields.ttlInput, layout, 1);
    expect(image[232]).toBe(0x31);
    expect(readInfoMemFieldValue(image, fields.logTriggers, layout)).toBe(LOG_TRIGGERS.NONE);
  });

  it('land the same byte whichever order they are written in', () => {
    const layout = resolveInfoMemLayout({ ...CTX.shimmer3R, eventChannel: true });
    const a = new Uint8Array(INFOMEM_SIZE).fill(0xff);
    writeInfoMemFieldValue(a, fields.logTriggers, layout, LOG_TRIGGERS.NONE);
    writeInfoMemFieldValue(a, fields.buttonMode, layout, BUTTON_MODE.DISABLED);
    expect(a[232]).toBe(0x11);
  });
});

describe('parseInfoMem / generateInfoMem', () => {
  it('carry the byte as stored, and leave it alone on an unedited write', () => {
    const ctx = { ...CTX.shimmer3R, eventChannel: true };
    const image = new Uint8Array(INFOMEM_SIZE);
    image[0] = 0x80; // valid
    image[232] = 0xff;
    const cfg = parseInfoMem(image, ctx);
    expect(cfg.buttonLogMode).toBe(0xff);
    expect(generateInfoMem(cfg, ctx)[232]).toBe(0xff);
    expect(generateInfoMem({ ...cfg, buttonLogMode: 0x24 }, ctx)[232]).toBe(0x24);
  });

  it('do not touch byte 232 without the event channel', () => {
    const image = new Uint8Array(INFOMEM_SIZE);
    image[0] = 0x80;
    image[232] = 0x5a;
    const cfg = parseInfoMem(image, CTX.shimmer3R);
    expect(cfg.buttonLogMode).toBe(0);
    expect(generateInfoMem(cfg, CTX.shimmer3R)[232]).toBe(0x5a);
  });
});

describe('applyButtonLogModeRules', () => {
  const layout = resolveInfoMemLayout({ ...CTX.shimmer3R, eventChannel: true });
  const UBE = 0x20; // byte 217 bit 5
  const SINGLE_TOUCH = 0x80; // byte 218 bit 7

  function image(b232: number, b217 = UBE, b218 = 0): Uint8Array {
    const im = new Uint8Array(INFOMEM_SIZE);
    im[232] = b232;
    im[217] = b217;
    im[218] = b218;
    return im;
  }

  it('corrects the byte and writes it back', () => {
    const im = image(0xff);
    expect(applyButtonLogModeRules(im, layout)).toEqual([232]);
    expect(im[232]).toBe(0);
    expect(im[217]).toBe(UBE); // legacy leaves userButtonEnable alone
  });

  it('holds userButtonEnable at the nearest equivalent', () => {
    const im = image(0x09);
    applyButtonLogModeRules(im, layout);
    expect(im[217] & UBE).toBe(0);
    const on = image(0x11, 0);
    applyButtonLogModeRules(on, layout);
    expect(on[217] & UBE).toBe(UBE);
  });

  it('clears single touch where no press can start logging', () => {
    const im = image(0x01, UBE, SINGLE_TOUCH | 0x01);
    applyButtonLogModeRules(im, layout);
    expect(im[218]).toBe(0x01);
    const kept = image(0x03, UBE, SINGLE_TOUCH);
    applyButtonLogModeRules(kept, layout);
    expect(kept[218]).toBe(SINGLE_TOUCH);
  });

  it('takes out press recording and the TTL input on SR48-6-0', () => {
    const board = eventChannelBoardSupport(10, { boardId: 48, boardRev: 6, specialRev: 0 });
    expect(board).toEqual({ recordsButtonEdges: false, ttlInputSupported: false });
    const im = image(0x24);
    applyButtonLogModeRules(im, layout, board);
    expect(im[232]).toBe(0x03);
    // Not on another board, and never on a Shimmer3
    expect(eventChannelBoardSupport(10, { boardId: 48, boardRev: 7, specialRev: 0 })).toEqual({
      recordsButtonEdges: true,
      ttlInputSupported: true,
    });
    expect(eventChannelBoardSupport(3, { boardId: 48, boardRev: 6, specialRev: 0 })).toEqual({
      recordsButtonEdges: true,
      ttlInputSupported: true,
    });
  });

  it('does nothing without byte 232 in the layout', () => {
    const im = image(0xff);
    expect(applyButtonLogModeRules(im, resolveInfoMemLayout(CTX.shimmer3R))).toEqual([]);
    expect(im[232]).toBe(0xff);
  });
});
