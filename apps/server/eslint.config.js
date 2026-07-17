import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Flat config for the server (Node + TypeScript, ESM). Type-aware linting is
// intentionally skipped to keep lint fast and avoid requiring a full tsconfig
// program; typecheck is covered separately by `npm run typecheck`.
export default tseslint.config(
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // `any` is used pragmatically across the transport/graph layers.
      '@typescript-eslint/no-explicit-any': 'off',
      // Surface unused symbols as warnings; allow intentional `_`-prefixed ones.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Noisy against the defensive "declare with a fallback default, then
      // reassign inside try/catch" pattern used throughout the services.
      'no-useless-assignment': 'off',
    },
  },
  {
    // The PWA service worker ships as plain JS and runs in the ServiceWorker
    // global scope (self, caches, fetch, ...), not Node.
    files: ['**/*.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },
);
