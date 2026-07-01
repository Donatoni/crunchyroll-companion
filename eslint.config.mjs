import tseslint from 'typescript-eslint';
import noUnsanitized from 'eslint-plugin-no-unsanitized';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '.pkg/'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts'],
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      // XSS guard for the extension pages: every innerHTML sink must be a
      // literal or pass through esc(). One forgotten escape in a privileged
      // page is a real vulnerability, so this is an error, not a warning.
      'no-unsanitized/property': ['error', { escape: { methods: ['esc'] } }],
      'no-unsanitized/method': ['error', { escape: { methods: ['esc'] } }],
      // The codebase leans on intentional `void promise` fire-and-forget.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Build scripts are plain untyped .mjs; the @ts-nocheck there silences the
    // editor's implicit checkJs, not real compilation (tsc skips .mjs anyway).
    files: ['scripts/**/*.mjs'],
    rules: { '@typescript-eslint/ban-ts-comment': 'off' },
  },
);
