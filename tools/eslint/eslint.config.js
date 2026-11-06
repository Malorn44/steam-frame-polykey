// ESLint for the TypeScript and the build scripts: ESLint's and typescript-eslint's recommended rules,
// with type information, so unhandled promises, `any` leaking out of JSON and the like are caught, not
// only syntax. No style rules; tsc (npm run typecheck) already reports unused names and missing returns.
//
// It lives apart from the main install: typescript-eslint needs TypeScript 6's compiler API, and the
// project builds with TypeScript 7. Run it from the repo root: npm run lint:eslint.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const root = new URL('../..', import.meta.url).pathname;

export default defineConfig(
  { basePath: root, ignores: ['dist/', '.venv/', '.github/'] },
  {
    basePath: root,
    files: ['src/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: root },
    },
    rules: {
      // It guards `this` in methods passed around. Nothing here has a `this`: objects are made of
      // closures (handlers, views, pickers), and their interfaces declare them as methods.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    basePath: root,
    files: ['tests/**/*.ts'],
    rules: {
      // Fakes stand in for async functions without awaiting anything.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    basePath: root,
    files: ['scripts/**/*.mjs', 'tools/eslint/eslint.config.js', 'prettier.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
);
