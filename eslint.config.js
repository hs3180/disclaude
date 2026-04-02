/**
 * ESLint configuration for Disclaude
 *
 * This configuration uses ESLint v9 flat config format with TypeScript support.
 */

import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

// Legacy test files that still use vi.mock() for external SDKs
// These will be refactored to use nock or dependency injection instead
// TODO(#918): Refactor ws-connection-manager.test.ts to use dependency injection
const legacyMockTestFiles = [
  'packages/primary-node/src/channels/feishu/ws-connection-manager.test.ts',
];

export default [
  {
    // Ignore patterns
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'workspace/**',
      '*.config.js',
      '*.config.ts',
      '*.config.*.ts',
      'dedupe-records/**',
      'logs/**',
      'long-tasks/**',
    ],
  },
  {
    // Integration test files: non-project-aware parsing
    // These files import from dist/ packages and are not part of the main tsconfig project
    files: ['tests/integration/feishu/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      'semi': ['error', 'always'],
      'quotes': ['error', 'single', { avoidEscape: true }],
      'no-duplicate-imports': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-template': 'error',
      'no-throw-literal': 'error',
      'curly': ['error', 'all'],
      'eqeqeq': ['error', 'always'],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['tests/integration/feishu/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        project: [
          './tsconfig.json',
          './packages/core/tsconfig.json',
          './packages/primary-node/tsconfig.json',
          './packages/mcp-server/tsconfig.json',
          './packages/worker-node/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // TypeScript specific rules
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',

      // General best practices
      'no-console': 'off', // We use console for CLI output
      'prefer-const': 'error',
      'no-var': 'error',
      'eqeqeq': ['error', 'always'],
      'curly': ['error', 'all'],

      // Code style
      'semi': ['error', 'always'],
      'quotes': ['error', 'single', { avoidEscape: true }],
      'indent': 'off', // Let Prettier handle formatting

      // ES6+
      'no-duplicate-imports': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-template': 'error',

      // Error handling
      'no-throw-literal': 'error',

      // Async/await
      'require-await': 'error',
      'no-return-await': 'off',

      // Object and array rules
      'object-shorthand': ['error', 'always'],
      'prefer-destructuring': ['error', {
        array: true,
        object: true,
      }, {
        enforceForRenamedProperties: false,
      }],

      // Import rules
      'no-unreachable': 'error',
      'no-unused-labels': 'error',
    },
  },
  {
    // Test files: Prohibit direct mocking of external SDK modules
    // This forces tests to use nock for network interception instead of vi.mock()
    files: ['**/*.test.ts', '**/*.spec.ts'],
    ignores: legacyMockTestFiles,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='vi'][callee.property.name='mock'][arguments.0.value=/@anthropic-ai/]",
          message:
            '禁止对 @anthropic-ai/sdk 使用 vi.mock()。请使用 nock VCR 录制回放模式进行网络拦截。参见 Issue #918。',
        },
        {
          selector:
            "CallExpression[callee.object.name='vi'][callee.property.name='mock'][arguments.0.value=/@larksuiteoapi/]",
          message:
            '禁止对 @larksuiteoapi/node-sdk 使用 vi.mock()。请使用 nock VCR 录制回放模式进行网络拦截。参见 Issue #918。',
        },
      ],
    },
  },
];
