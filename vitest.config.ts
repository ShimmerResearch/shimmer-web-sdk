// Vitest configuration — runs without a browser so protocol/calibration logic
// can be tested independently of Web Bluetooth.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
