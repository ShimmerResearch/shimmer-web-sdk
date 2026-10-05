// Vitest configuration — runs without a browser so protocol/calibration logic
// can be tested independently of Web Bluetooth.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /* Persist transformed modules between runs. Transforming is a third of this
     * suite's tracked time, and without this it is redone from scratch on every
     * invocation - so a warm local run drops from ~16.9s to ~15.7s and its
     * spread tightens considerably.
     *
     * Two things this does NOT do, so nobody reads more into it. It does
     * nothing in CI: `npm ci` recreates node_modules, and `cache: npm` in the
     * workflow caches the npm download directory rather than node_modules, so
     * the cache below starts empty on every run. And the first run after any
     * install is marginally SLOWER, because that is the run that writes the
     * cache.
     *
     * Left at the default location, `node_modules/.vitest-cache` (~7 MB): it is
     * inside node_modules deliberately, so reinstalling dependencies discards
     * it, and it needs no .gitignore entry. Moving it elsewhere to make CI
     * benefit would trade that invalidation guarantee for about a second. */
    fsModuleCache: true,
  },
});
