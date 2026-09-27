import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['src/**/*.ts', 'evals/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { project: './tsconfig.check.json', tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // Numbers in messages are fine; objects and nullables in a template are the bug this rule exists for.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // `displayName || name` means "fall back on an empty string too", which `??` would not do.
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
      eqeqeq: 'error',
      'no-console': 'error',
    },
  },
  // The eval runner is a command-line tool; its output is the console.
  { files: ['evals/run.ts'], rules: { 'no-console': 'off' } },
  // The logger: stdout carries the MCP protocol, so everything else goes to stderr here.
  { files: ['src/config.ts'], rules: { 'no-console': 'off' } },
  // The auth and config tests came with the OAuth code from tacticlaunch/mcp-linear and lean on
  // fetch mocks and non-null assertions; production code is held to the full rule set.
  {
    files: ['src/__tests__/auth-*.test.ts', 'src/__tests__/config.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
    },
  },
);
