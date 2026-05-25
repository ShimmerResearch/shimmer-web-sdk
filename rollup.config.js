import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import dts from 'rollup-plugin-dts';

/** @type {import('rollup').RollupOptions[]} */
export default [
  // ESM bundle
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/shimmer-ble.esm.js',
      format: 'esm',
      sourcemap: true,
    },
    plugins: [resolve(), typescript({ tsconfig: './tsconfig.json', declaration: false })],
  },
  // CJS bundle (for Node.js / CommonJS consumers)
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/shimmer-ble.cjs',
      format: 'cjs',
      sourcemap: true,
    },
    plugins: [resolve(), typescript({ tsconfig: './tsconfig.json', declaration: false })],
  },
  // UMD bundle (for CDN / <script> tag usage)
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/shimmer-ble.umd.js',
      format: 'umd',
      name: 'ShimmerBLE',
      sourcemap: true,
    },
    plugins: [resolve(), typescript({ tsconfig: './tsconfig.json', declaration: false })],
  },
  // TypeScript declaration bundle
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/shimmer-ble.d.ts',
      format: 'esm',
    },
    plugins: [dts()],
  },
];
