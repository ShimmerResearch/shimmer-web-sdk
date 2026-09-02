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

  it('matches package-lock.json (bump all three together)', () => {
    // The lockfile was the one version with no guard, so it is the one that
    // drifted: a release bumped package.json and src/version.ts, the paired
    // test above passed, and the lock quietly stayed a version behind until a
    // reviewer noticed. `npm ci` installs from the lockfile, so a stale
    // version there is what a consumer actually resolves.
    const lockPath = fileURLToPath(new URL('../../package-lock.json', import.meta.url));
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe(SDK_VERSION);
    // The root entry of `packages` restates the version and is the one npm
    // reads; they are separate fields and can disagree.
    expect(lock.packages['']?.version).toBe(SDK_VERSION);
  });
});
