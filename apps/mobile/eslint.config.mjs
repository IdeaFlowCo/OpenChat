import tseslint from 'typescript-eslint';

// Design-token ratchet for the product client (OpenChat-eo3n.1). This config
// deliberately enforces one thing: new font sizes, corner radii and hex
// colours come from `src/theme/` (tokens.ts, palette.ts), not literals.
//
// Existing literals are recorded in `eslint-suppressions.json`, so lint only
// fails on new ones. After migrating a file to tokens, shrink the baseline:
//   npx eslint src --prune-suppressions
// Never regenerate it with --suppress-all to hide new literals.
const restricted = [
  {
    selector: "Property[key.name='fontSize'][value.type='Literal']",
    message: 'Use a type style from theme/tokens.ts (e.g. ...type.body) instead of a fontSize literal.',
  },
  {
    selector: "Property[key.name='borderRadius'][value.type='Literal'][value.value!=0]",
    message: 'Use radius.sm / md / lg / pill from theme/tokens.ts instead of a borderRadius literal.',
  },
  {
    selector: 'Literal[value=/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
    message: 'Use a colour role from theme (getColors / roles in tokens.ts) instead of a hex literal.',
  },
];

export default [
  { ignores: ['dist-*/**', 'node_modules/**', 'ios/**', 'android/**'] },
  {
    files: ['src/**/*.{ts,tsx}', 'App.tsx'],
    ignores: ['src/theme/**', '**/*.test.ts', '**/*.test.tsx'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    // Registered so existing `@typescript-eslint/...` disable comments resolve.
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { 'no-restricted-syntax': ['error', ...restricted] },
  },
];
