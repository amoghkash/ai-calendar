import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'apps/web/dist/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
  {
    // Tests routinely handle untyped JSON from HTTP and model responses.
    files: ['**/*.test.ts', '**/testing.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Architectural boundary: the scheduling engine must stay pure.
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-*',
                'express',
                'pg',
                'googleapis',
                '@microsoft/*',
                'openai',
                '@anthropic-ai/*',
                '@calendar-agent/*',
              ],
              message:
                '@calendar-agent/core must not depend on UI, database, provider SDKs or other workspace packages.',
            },
          ],
        },
      ],
    },
  },
);
