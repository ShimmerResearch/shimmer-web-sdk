/**
 * SDK version, exported so consumers (e.g. the webBLEDemos pages, which vendor
 * the built bundle) can log which build they are actually running — a stale
 * vendored copy is otherwise indistinguishable from a firmware fault.
 *
 * Kept in sync with package.json by tests/core/version.test.ts.
 */
export const SDK_VERSION = '0.1.21';
