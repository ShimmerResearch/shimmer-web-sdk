/**
 * SDK version, exported so consumers (e.g. the webBLEDemos pages, which vendor
 * the built bundle) can log which build they are actually running — a stale
 * vendored copy is otherwise indistinguishable from a firmware fault.
 *
 * Kept in sync with package.json by tests/core/version.test.ts, and stamped
 * from it by the Bump step in cut-release.yml — the release bumps this file
 * as well as package.json, so a published bundle reports its own version.
 */
export const SDK_VERSION = '0.4.0';
