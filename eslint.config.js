/**
 * ESLint configuration for Disclaude
 *
 * This configuration uses ESLint v9 flat config format with TypeScript support.
 *
 * Test Anti-Tampering Rules (Issue #914):
 * - Prohibits direct mocking of core SDK modules (@anthropic-ai/sdk, @larksuiteoapi/node-sdk)
 * - Forces tests to use VCR-style network interception (nock) instead of internal mocks
 * - This prevents AI from accidentally modifying test assertions and ensures test reliability
 */

import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

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
      'dedupe-records/**',
      'logs/**',
      'long-tasks/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
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

      // Test Anti-Tampering Rules (Issue #914)
      // Prohibit direct mocking of core SDK modules to enforce VCR-style testing
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='vi'][property.name='mock'] > Literal[value=/@anthropic-ai\\/sdk/]",
          message: 'Direct mocking of @anthropic-ai/sdk is prohibited. Use nock for network interception instead. See Issue #914.',
        },
        {
          selector: "CallExpression[callee.object.name='vi'][callee.property.name='mock'] > Literal:first-child[value=/@anthropic-ai\\/sdk/]",
          message: 'Direct mocking of @anthropic-ai/sdk is prohibited. Use nock for network interception instead. See Issue #914.',
        },
        {
          selector: "CallExpression[callee.object.name='vi'][callee.property.name='mock'] > Literal:first-child[value=/@larksuiteoapi\\/node-sdk/]",
          message: 'Direct mocking of @larksuiteoapi/node-sdk is prohibited. Use nock for network interception instead. See Issue #914.',
        },
      ],
    },
  },
  // Legacy test files that still use vi.mock for SDK modules
  // These are exempted from the no-restricted-syntax rule temporarily
  // TODO: Refactor these tests to use nock (tracked in Epic 2-6)
  {
    files: [
      'src/channels/feishu-channel-bot-mention.test.ts',
      'src/channels/feishu-channel-mention.test.ts',
      'src/channels/feishu-channel-passive-mode.test.ts',
      'src/mcp/feishu-context-mcp.test.ts',
      'src/mcp/feishu-mcp-server.test.ts',
      'src/mcp/tools/interactive-message.test.ts',
      'src/platforms/feishu/feishu-adapter.test.ts',
      'src/platforms/feishu/feishu-message-sender.test.ts',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
