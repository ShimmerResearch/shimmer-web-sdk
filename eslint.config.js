// Flat ESLint config (ESLint v9+/v10). Replaces the legacy .eslintrc.cjs.
// Mirrors the previous setup: eslint:recommended + @typescript-eslint/recommended,
// browser globals, and the two project rule overrides.
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  // Paths never linted (node_modules is ignored by default).
  {
    ignores: ['dist/', 'docs/', 'coverage/', 'rollup.config.js', 'vitest.config.ts'],
  },

  // Core ESLint recommended rules (was `extends: ['eslint:recommended']`).
  js.configs.recommended,

  // TypeScript recommended, flat form (was `plugin:@typescript-eslint/recommended`).
  // Sets the @typescript-eslint parser/plugin and disables the core rules that
  // TypeScript already handles for .ts files.
  ...tseslint.configs['flat/recommended'],

  // Project sources: language options + rule overrides.
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      // Allow unused vars/args prefixed with _ (intentionally unused params).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Permit explicit `any` as a warning rather than an error during adoption.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
