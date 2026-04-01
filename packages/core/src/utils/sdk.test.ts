/**
 * Tests for SDK utility functions.
 *
 * Issue #1617 Phase 2/3: Tests for buildSdkEnv, extractText, and getNodeBinDir.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('SDK Utils', () => {
  describe('getNodeBinDir', () => {
    it('should return directory containing node executable', async () => {
      const { getNodeBinDir } = await import('./sdk.js');
      const result = getNodeBinDir();
      expect(result).toBe(process.execPath.substring(0, process.execPath.lastIndexOf('/')));
      expect(result).toContain('bin');
    });
  });

  describe('extractText', () => {
    it('should return string content directly', async () => {
      const { extractText } = await import('./sdk.js');
      const message = { content: 'Hello world', role: 'assistant' };
      expect(extractText(message)).toBe('Hello world');
    });

    it('should extract text from content blocks with text type', async () => {
      const { extractText } = await import('./sdk.js');
      const message = {
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
        role: 'assistant',
      };
      expect(extractText(message)).toBe('Hello world');
    });

    it('should filter out non-text content blocks', async () => {
      const { extractText } = await import('./sdk.js');
      const message = {
        content: [
          { type: 'tool_use', id: '123', name: 'Read', input: {} },
          { type: 'text', text: 'Result text' },
          { type: 'image', id: '456' },
        ],
        role: 'assistant',
      };
      expect(extractText(message)).toBe('Result text');
    });

    it('should return empty string for empty content array', async () => {
      const { extractText } = await import('./sdk.js');
      const message = { content: [], role: 'assistant' };
      expect(extractText(message)).toBe('');
    });

    it('should return empty string for non-text non-array content', async () => {
      const { extractText } = await import('./sdk.js');
      const message = { content: 42 as unknown as string, role: 'assistant' };
      expect(extractText(message)).toBe('');
    });

    it('should handle single text block', async () => {
      const { extractText } = await import('./sdk.js');
      const message = {
        content: [{ type: 'text', text: 'Only block' }],
        role: 'assistant',
      };
      expect(extractText(message)).toBe('Only block');
    });

    it('should handle content blocks with non-string text property', async () => {
      const { extractText } = await import('./sdk.js');
      const message = {
        content: [
          { type: 'text', text: undefined },
          { type: 'text', text: 'Valid text' },
        ],
        role: 'assistant',
      };
      expect(extractText(message)).toBe('Valid text');
    });
  });

  describe('buildSdkEnv', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let originalClaudecode: string | undefined;

    beforeEach(async () => {
      const { buildSdkEnv } = await import('./sdk.js');
      // Save original env
      originalEnv = { ...process.env };
      originalClaudecode = process.env.CLAUDECODE;
    });

    afterEach(() => {
      // Restore original env
      process.env = originalEnv;
      if (originalClaudecode !== undefined) {
        process.env.CLAUDECODE = originalClaudecode;
      } else {
        delete process.env.CLAUDECODE;
      }
    });

    it('should set ANTHROPIC_API_KEY', async () => {
      const { buildSdkEnv } = await import('./sdk.js');
      const env = buildSdkEnv('test-api-key');
      expect(env.ANTHROPIC_API_KEY).toBe('test-api-key');
    });

    it('should include PATH from process.env', async () => {
      const { buildSdkEnv } = await import('./sdk.js');
      process.env.PATH = '/usr/bin:/bin';
      const env = buildSdkEnv('key');
      expect(env.PATH).toBeDefined();
      expect(typeof env.PATH).toBe('string');
    });

    it('should prepend node bin dir to PATH', async () => {
      const { buildSdkEnv, getNodeBinDir } = await import('./sdk.js');
      const nodeBinDir = getNodeBinDir();
      process.env.PATH = '/usr/bin:/bin';

      // Set PATH to not include nodeBinDir
      process.env.PATH = '/usr/bin:/bin';
      const env = buildSdkEnv('key');
      expect(env.PATH).toContain(nodeBinDir);
      expect((env.PATH as string).startsWith(nodeBinDir + ':') || (env.PATH as string).includes(nodeBinDir)).toBe(true);
    });

    it('should set ANTHROPIC_BASE_URL when apiBaseUrl is provided', async () => {
      const { buildSdkEnv } = await import('./sdk.js');
      const env = buildSdkEnv('key', 'https://custom.api.com');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://custom.api.com');
    });

    it('should not set ANTHROPIC_BASE_URL when apiBaseUrl is not provided', async () => {
      const { buildSdkEnv } = await import('./sdk.js');
      // Save and remove any existing ANTHROPIC_BASE_URL from env
      const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_BASE_URL;
      try {
        const env = buildSdkEnv('key');
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      } finally {
        if (originalBaseUrl !== undefined) {
          process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
        }
      }
    });

    it('should remove CLAUDECODE from env', async () => {
      const { buildSdkEnv } = await import('./sdk.js');
      process.env.CLAUDECODE = '1';
      const env = buildSdkEnv('key');
      expect(env.CLAUDECODE).toBeUndefined();
    });

    it('should merge extraEnv variables', async () => {
      const { buildSdkEnv } = await import('./sdk.js');
      const env = buildSdkEnv('key', undefined, { MY_VAR: 'value', ANOTHER: 'test' });
      expect(env.MY_VAR).toBe('value');
      expect(env.ANOTHER).toBe('test');
    });

    it('should not let extraEnv override critical values', async () => {
      const { buildSdkEnv } = await import('./sdk.js');
      const env = buildSdkEnv('my-key', undefined, { ANTHROPIC_API_KEY: 'override-key' });
      expect(env.ANTHROPIC_API_KEY).toBe('my-key');
    });

    it('should set DEBUG_CLAUDE_AGENT_SDK by default', async () => {
      const { buildSdkEnv } = await import('./sdk.js');
      delete process.env.DEBUG_CLAUDE_AGENT_SDK;
      const env = buildSdkEnv('key');
      expect(env.DEBUG_CLAUDE_AGENT_SDK).toBe('1');
    });

    it('should disable debug logging when sdkDebug is false', async () => {
      const { buildSdkEnv } = await import('./sdk.js');
      const env = buildSdkEnv('key', undefined, undefined, false);
      expect(env.DEBUG_CLAUDE_AGENT_SDK).toBeUndefined();
    });

    it('should preserve existing DEBUG_CLAUDE_AGENT_SDK when sdkDebug is true', async () => {
      const { buildSdkEnv } = await import('./sdk.js');
      process.env.DEBUG_CLAUDE_AGENT_SDK = 'verbose';
      const env = buildSdkEnv('key', undefined, undefined, true);
      expect(env.DEBUG_CLAUDE_AGENT_SDK).toBe('verbose');
    });

    it('should include process.env variables', async () => {
      const { buildSdkEnv } = await import('./sdk.js');
      process.env.HOME = '/home/test';
      const env = buildSdkEnv('key');
      expect(env.HOME).toBe('/home/test');
    });
  });
});
