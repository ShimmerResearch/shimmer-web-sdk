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

  // cut-release.yml bumps package.json and package-lock.json together (npm version
  // rewrites both the lockfile root "version" and packages[""].version), so a
  // lockfile left behind is always a hand-edit mistake rather than a release step.
  it('matches package-lock.json (both version fields)', () => {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    const lockPath = fileURLToPath(new URL('../../package-lock.json', import.meta.url));
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });
});
