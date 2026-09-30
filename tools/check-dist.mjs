// Checks the built bundles in dist/, which is what every consumer vendors.
//
// The test suite imports src/, so nothing else loads what `npm run build`
// produces. A build that drops an export, or bundles one format differently
// from another, would pass CI and then be copied into every consumer. This runs
// after the build and checks, in plain Node:
//
//   1. The ESM, CJS and UMD bundles each load. The UMD bundle is loaded with no
//      module system, the way a plain <script> tag loads it, so the global it
//      defines is what is checked. A UMD dependency (neurolynq-web-sdk takes
//      shimmer-web-sdk as the `ShimmerBLE` global) is loaded into the same
//      context first, from that package's own UMD bundle.
//   2. Each reports SDK_VERSION equal to package.json's version.
//   3. All three export the same names.
//   4. Every runtime export is declared in the .d.ts.
//   5. Each bundle has its source map.
//
// The bundle names come from package.json's "module" field, so the same file
// serves shimmer-web-sdk and neurolynq-web-sdk; keep the copies identical.
//
// Run it with `npm run test:dist` after `npm run build`.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const base = pkg.module.replace(/^(\.\/)?dist\//, '').replace(/\.esm\.js$/, '');
const file = (ext) => join(dist, `${base}.${ext}`);
const require = createRequire(import.meta.url);

const failures = [];
const fail = (message) => failures.push(message);

for (const ext of ['esm.js', 'cjs', 'umd.js', 'd.ts']) {
  if (!existsSync(file(ext))) {
    console.error(`dist/${base}.${ext} is missing. Run \`npm run build\` first.`);
    process.exit(1);
  }
}

const esm = await import(pathToFileURL(file('esm.js')).href);
const cjs = require(file('cjs'));

// No `module`, `exports` or `define`, so the UMD wrapper takes its global branch.
// A fresh context has only the language built-ins, so hand it the host APIs the
// bundle may touch at load time.
const HOST_GLOBALS = [
  'console',
  'TextEncoder',
  'TextDecoder',
  'URL',
  'URLSearchParams',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'structuredClone',
  'crypto',
  'performance',
  'navigator',
  'AbortController',
  'AbortSignal',
  'EventTarget',
  'Event',
  'Blob',
  'atob',
  'btoa',
];
const sandbox = {};
for (const name of HOST_GLOBALS) if (name in globalThis) sandbox[name] = globalThis[name];
vm.createContext(sandbox);
const runUmd = (path) => vm.runInContext(readFileSync(path, 'utf8'), sandbox, { filename: path });

// The wrapper's two branches name the global and its dependencies, in order:
//   factory(exports, require('dep'))  ...  factory(global.Name = {}, global.Dep)
const umdText = readFileSync(file('umd.js'), 'utf8');
const globalName = umdText.match(/factory\(\s*\(?\s*global\.([A-Za-z_$][\w$]*)\s*=\s*\{\s*\}/)?.[1];
const depPackages = [
  ...(umdText.match(/factory\(exports((?:,\s*require\([^)]*\))*)\)/)?.[1] ?? '').matchAll(
    /require\(['"]([^'"]+)['"]\)/g,
  ),
].map((m) => m[1]);
for (const dep of depPackages) {
  // Its package.json is not in its "exports", so find it from the entry point.
  let depRoot = dirname(require.resolve(dep));
  while (!existsSync(join(depRoot, 'package.json')) && dirname(depRoot) !== depRoot)
    depRoot = dirname(depRoot);
  const depPkg = JSON.parse(readFileSync(join(depRoot, 'package.json'), 'utf8'));
  const depUmd = join(depRoot, depPkg.module.replace(/\.esm\.js$/, '.umd.js'));
  if (!existsSync(depUmd)) fail(`the UMD dependency ${dep} has no UMD bundle at ${depUmd}`);
  else runUmd(depUmd);
}
if (!globalName) fail(`dist/${base}.umd.js: could not read the global name from its UMD wrapper`);
runUmd(file('umd.js'));
const umd = globalName ? sandbox[globalName] : undefined;
if (globalName && !umd) fail(`dist/${base}.umd.js defined no ${globalName} global`);

const bundles = { esm, cjs, umd: umd ?? {} };
const exportNames = (bundle) =>
  Object.keys(bundle)
    .filter((name) => name !== 'default' && name !== '__esModule')
    .sort();

// 2. Version.
for (const [format, bundle] of Object.entries(bundles)) {
  if (bundle.SDK_VERSION !== pkg.version) {
    fail(`${format}: SDK_VERSION is ${bundle.SDK_VERSION}, but package.json says ${pkg.version}`);
  }
}

// 3. Same names in every format.
const esmNames = exportNames(esm);
if (esmNames.length < 50) fail(`esm: only ${esmNames.length} exports; the build looks truncated`);
for (const [format, bundle] of Object.entries(bundles)) {
  if (format === 'esm') continue;
  const names = exportNames(bundle);
  const missing = esmNames.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !esmNames.includes(name));
  if (missing.length)
    fail(`${format}: missing ${missing.length} esm export(s): ${missing.join(', ')}`);
  if (extra.length) fail(`${format}: ${extra.length} export(s) esm lacks: ${extra.join(', ')}`);
}

// 4. Declared in the .d.ts.
const dts = readFileSync(file('d.ts'), 'utf8');
const declared = new Set();
for (const [, list] of dts.matchAll(/export\s*\{([^}]*)\}/g)) {
  for (const part of list.split(',')) {
    const name = part
      .trim()
      .replace(/^type\s+/, '')
      .split(/\s+as\s+/)
      .pop()
      ?.trim();
    if (name) declared.add(name);
  }
}
for (const [, name] of dts.matchAll(
  /export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|enum)\s+([A-Za-z_$][\w$]*)/g,
)) {
  declared.add(name);
}
const undeclared = esmNames.filter((name) => !declared.has(name));
if (undeclared.length)
  fail(`d.ts: declares no type for ${undeclared.length} export(s): ${undeclared.join(', ')}`);

// 5. Source maps.
for (const ext of ['esm.js', 'cjs', 'umd.js']) {
  if (!existsSync(`${file(ext)}.map`)) fail(`dist/${base}.${ext}.map is missing`);
}

if (failures.length) {
  for (const message of failures) console.error(`FAIL ${message}`);
  process.exit(1);
}
console.log(
  `dist ${pkg.version}: esm, cjs and umd load, ${esmNames.length} exports each, all declared in the .d.ts.`,
);
