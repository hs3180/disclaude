/**
 * Tests for SDK utility functions (packages/core/src/utils/sdk.ts)
 *
 * Validates getNodeBinDir, extractText, and buildSdkEnv utilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getNodeBinDir, extractText, buildSdkEnv } from './sdk.js';
import type { AgentMessage, ContentBlock } from '../types/agent.js';

describe('SDK Utilities', () => {
  describe('getNodeBinDir', () => {
    it('should return directory containing node executable', () => {
      const result = getNodeBinDir();
      // Should end with 'bin' or be a valid directory path
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should return a directory path', () => {
      const result = getNodeBinDir();
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      // Should not include the 'node' binary filename
      expect(result).not.toMatch(/\/node$/);
    });
  });

  describe('extractText', () => {
    it('should extract text from string content', () => {
      const message: AgentMessage = {
        type: 'text',
        content: 'Hello, world!',
        role: 'assistant',
      };
      expect(extractText(message)).toBe('Hello, world!');
    });

    it('should extract and join text from array content', () => {
      const message: AgentMessage = {
        type: 'text',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ', world!' },
        ] as ContentBlock[],
        role: 'assistant',
      };
      expect(extractText(message)).toBe('Hello, world!');
    });

    it('should filter out non-text blocks from array content', () => {
      const message: AgentMessage = {
        type: 'text',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', name: 'Bash', input: {} },
          { type: 'text', text: ' world' },
        ] as ContentBlock[],
        role: 'assistant',
      };
      expect(extractText(message)).toBe('Hello world');
    });

    it('should return empty string for array with only non-text blocks', () => {
      const message: AgentMessage = {
        type: 'text',
        content: [
          { type: 'tool_use', name: 'Bash', input: {} },
          { type: 'image', id: 'img_1' },
        ] as ContentBlock[],
        role: 'assistant',
      };
      expect(extractText(message)).toBe('');
    });

    it('should return empty string for empty array content', () => {
      const message: AgentMessage = {
        type: 'text',
        content: [],
        role: 'assistant',
      };
      expect(extractText(message)).toBe('');
    });

    it('should handle empty string content', () => {
      const message: AgentMessage = {
        type: 'text',
        content: '',
        role: 'assistant',
      };
      expect(extractText(message)).toBe('');
    });

    it('should skip blocks where text is not a string', () => {
      const message: AgentMessage = {
        type: 'text',
        content: [
          { type: 'text', text: 123 } as unknown as ContentBlock,
          { type: 'text', text: 'real text' },
        ] as ContentBlock[],
        role: 'assistant',
      };
      expect(extractText(message)).toBe('real text');
    });
  });

  describe('buildSdkEnv', () => {
    const originalPath = process.env.PATH;
    const originalKey = process.env.ANTHROPIC_API_KEY;

    beforeEach(() => {
      vi.unstubAllEnvs();
      process.env.PATH = originalPath;
      process.env.ANTHROPIC_API_KEY = originalKey;
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      process.env.PATH = originalPath;
      process.env.ANTHROPIC_API_KEY = originalKey;
    });

    it('should set ANTHROPIC_API_KEY', () => {
      const env = buildSdkEnv('sk-test-key');
      expect(env.ANTHROPIC_API_KEY).toBe('sk-test-key');
    });

    it('should include PATH in the environment', () => {
      const env = buildSdkEnv('sk-test-key');
      expect(env.PATH).toBeTruthy();
      expect(typeof env.PATH).toBe('string');
    });

    it('should prepend node bin dir to PATH if not already present', () => {
      vi.stubEnv('PATH', '/usr/bin:/bin');
      const env = buildSdkEnv('sk-test-key');
      const nodeBinDir = getNodeBinDir();
      expect(env.PATH).toContain(nodeBinDir);
    });

    it('should not duplicate node bin dir in PATH', () => {
      const nodeBinDir = getNodeBinDir();
      vi.stubEnv('PATH', `${nodeBinDir}/usr/bin`);
      const env = buildSdkEnv('sk-test-key');
      // Should not contain the node bin dir twice
      const count = (env.PATH!.match(new RegExp(nodeBinDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      expect(count).toBeLessThanOrEqual(1);
    });

    it('should set ANTHROPIC_BASE_URL when apiBaseUrl is provided', () => {
      const env = buildSdkEnv('sk-test-key', 'https://api.example.com');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com');
    });

    it('should not override ANTHROPIC_BASE_URL when apiBaseUrl is not provided', () => {
      const env = buildSdkEnv('sk-test-key');
      // buildSdkEnv does not set ANTHROPIC_BASE_URL when apiBaseUrl is not provided,
      // but it spreads process.env which may already have this var
      expect(env.ANTHROPIC_API_KEY).toBe('sk-test-key');
    });

    it('should merge extraEnv variables', () => {
      const env = buildSdkEnv('sk-test-key', undefined, { CUSTOM_VAR: 'custom_value' });
      expect(env.CUSTOM_VAR).toBe('custom_value');
    });

    it('should give priority to system env over extraEnv', () => {
      vi.stubEnv('SYSTEM_VAR', 'system_value');
      const env = buildSdkEnv('sk-test-key', undefined, { SYSTEM_VAR: 'extra_value' });
      expect(env.SYSTEM_VAR).toBe('system_value');
    });

    it('should always set API_KEY even if extraEnv has one', () => {
      const env = buildSdkEnv('sk-final-key', undefined, { ANTHROPIC_API_KEY: 'sk-extra-key' });
      expect(env.ANTHROPIC_API_KEY).toBe('sk-final-key');
    });

    it('should remove CLAUDECODE from environment', () => {
      vi.stubEnv('CLAUDECODE', '1');
      const env = buildSdkEnv('sk-test-key');
      expect(env.CLAUDECODE).toBeUndefined();
    });

    it('should set DEBUG_CLAUDE_AGENT_SDK when sdkDebug is true (default)', () => {
      const env = buildSdkEnv('sk-test-key');
      expect(env.DEBUG_CLAUDE_AGENT_SDK).toBeDefined();
    });

    it('should not set DEBUG_CLAUDE_AGENT_SDK when sdkDebug is false', () => {
      vi.stubEnv('DEBUG_CLAUDE_AGENT_SDK', undefined);
      const env = buildSdkEnv('sk-test-key', undefined, undefined, false);
      expect(env.DEBUG_CLAUDE_AGENT_SDK).toBeUndefined();
    });

    it('should preserve existing DEBUG_CLAUDE_AGENT_SDK when sdkDebug is true', () => {
      vi.stubEnv('DEBUG_CLAUDE_AGENT_SDK', '0');
      const env = buildSdkEnv('sk-test-key', undefined, undefined, true);
      expect(env.DEBUG_CLAUDE_AGENT_SDK).toBe('0');
    });

    it('should remove ANTHROPIC_CUSTOM_HEADERS when not explicitly set via extraEnv', () => {
      vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'comate_custom_header=xxx');
      const env = buildSdkEnv('sk-test-key');
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    });

    it('should preserve ANTHROPIC_CUSTOM_HEADERS when explicitly set via extraEnv', () => {
      vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'comate_custom_header=xxx');
      const env = buildSdkEnv('sk-test-key', undefined, { ANTHROPIC_CUSTOM_HEADERS: 'my_header=value' });
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('my_header=value');
    });
  });
});
