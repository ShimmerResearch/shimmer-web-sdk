/**
 * The TCXO bit, ExperimentConfig1 bit 4, which every LogAndStream build clears
 * (`ShimConfig_checkAndCorrectConfig`, `#if !IS_SUPPORTED_TCXO`).
 */
import { describe, it, expect } from 'vitest';
import { applyTcxoRule } from '../../src/devices/infomem/tcxo.js';
import { resolveInfoMemLayout, INFOMEM_SIZE } from '../../src/devices/infomem/layout.js';
import { CTX } from './fixtures.js';

describe('applyTcxoRule', () => {
  for (const [name, ctx] of [
    ['Shimmer3', CTX.modernShimmer3],
    ['Shimmer3R', CTX.shimmer3R],
  ] as const) {
    it(`clears bit 4 of byte 218 and nothing else (${name})`, () => {
      const layout = resolveInfoMemLayout(ctx);
      const im = new Uint8Array(INFOMEM_SIZE).fill(0xa5);
      im[layout.idxSDExperimentConfig1] = 0xff;
      expect(applyTcxoRule(im, layout)).toEqual([layout.idxSDExperimentConfig1]);
      expect(im[layout.idxSDExperimentConfig1]).toBe(0xef);
      expect(im.filter((b, i) => i !== layout.idxSDExperimentConfig1 && b !== 0xa5)).toHaveLength(
        0,
      );
    });

    it(`changes nothing when the bit is already clear (${name})`, () => {
      const layout = resolveInfoMemLayout(ctx);
      const im = new Uint8Array(INFOMEM_SIZE);
      im[layout.idxSDExperimentConfig1] = 0xef;
      expect(applyTcxoRule(im, layout)).toEqual([]);
      expect(im[layout.idxSDExperimentConfig1]).toBe(0xef);
    });
  }
});
