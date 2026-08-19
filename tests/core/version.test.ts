import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SDK_VERSION } from '../../src/version.js';

describe('SDK_VERSION', () => {
  it('matches package.json (bump both together)', () => {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
