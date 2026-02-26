/**
 * Tests for SiteMiner Subagent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runSiteMiner,
  createSiteMiner,
  isPlaywrightAvailable,
  type SiteMinerOptions,
  type SiteMinerResult,
} from './site-miner.js';
import { Config } from '../config/index.js';

// Mock the Config module
vi.mock('../config/index.js', () => ({
  Config: {
    getAgentConfig: vi.fn(() => ({
      apiKey: 'test-api-key',
      model: 'test-model',
      apiBaseUrl: 'https://test.api',
      provider: 'glm',
    })),
    getMcpServersConfig: vi.fn(() => ({
      playwright: {
        command: 'npx',
        args: ['@playwright/mcp@latest'],
      },
    })),
    getWorkspaceDir: vi.fn(() => '/workspace'),
    getGlobalEnv: vi.fn(() => ({})),
    getLoggingConfig: vi.fn(() => ({
      level: 'debug',
      pretty: false,
      rotate: false,
      sdkDebug: false,
    })),
  },
}));

// Mock the SDK query function
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

describe('SiteMiner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isPlaywrightAvailable', () => {
    it('should return true when Playwright MCP is configured', () => {
      expect(isPlaywrightAvailable()).toBe(true);
    });

    it('should return false when Playwright MCP is not configured', () => {
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce(undefined);
      expect(isPlaywrightAvailable()).toBe(false);
    });
  });

  describe('runSiteMiner', () => {
    it('should return failure when Playwright is not available', async () => {
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce(undefined);

      const result = await runSiteMiner({
        url: 'https://example.com',
        task: 'Extract title',
      });

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Playwright MCP not configured');
      expect(result.confidence).toBe(0);
    });

    it('should handle successful mining operation', async () => {
      const mockQuery = vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query;
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          content: JSON.stringify({
            success: true,
            target_url: 'https://example.com',
            information_found: { title: 'Example Domain' },
            summary: 'Found the title',
            confidence: 0.95,
          }),
        };
      });

      const result = await runSiteMiner({
        url: 'https://example.com',
        task: 'Extract the page title',
      });

      expect(result.success).toBe(true);
      expect(result.information_found).toEqual({ title: 'Example Domain' });
      expect(result.confidence).toBe(0.95);
    });

    it('should handle query error', async () => {
      const mockQuery = vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query;
      mockQuery.mockImplementation(async function* () {
        throw new Error('Query failed');
      });

      const result = await runSiteMiner({
        url: 'https://example.com',
        task: 'Extract title',
      });

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Error');
    });

    it('should handle malformed JSON response', async () => {
      const mockQuery = vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query;
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          content: 'This is not valid JSON',
        };
      });

      const result = await runSiteMiner({
        url: 'https://example.com',
        task: 'Extract title',
      });

      expect(result.success).toBe(false);
      expect(result.notes).toContain('Could not parse JSON');
    });

    it('should handle partial JSON response', async () => {
      const mockQuery = vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query;
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          content: 'Here is the result: {"success": true, "information_found": {"title": "Test"}, "confidence": 0.8} and some extra text',
        };
      });

      const result = await runSiteMiner({
        url: 'https://example.com',
        task: 'Extract title',
      });

      expect(result.success).toBe(true);
      expect(result.information_found).toEqual({ title: 'Test' });
    });
  });

  describe('createSiteMiner', () => {
    it('should return the runSiteMiner function', () => {
      const miner = createSiteMiner();
      expect(miner).toBe(runSiteMiner);
    });
  });
});

describe('SiteMinerResult', () => {
  it('should have correct structure', () => {
    const result: SiteMinerResult = {
      success: true,
      target_url: 'https://example.com',
      information_found: { key: 'value' },
      summary: 'Test summary',
      confidence: 0.9,
    };

    expect(result.success).toBe(true);
    expect(result.target_url).toBe('https://example.com');
    expect(result.information_found).toEqual({ key: 'value' });
    expect(result.summary).toBe('Test summary');
    expect(result.confidence).toBe(0.9);
  });
});

describe('SiteMinerOptions', () => {
  it('should have correct structure', () => {
    const options: SiteMinerOptions = {
      url: 'https://example.com',
      task: 'Extract data',
      timeout: 30000,
      takeScreenshot: true,
    };

    expect(options.url).toBe('https://example.com');
    expect(options.task).toBe('Extract data');
    expect(options.timeout).toBe(30000);
    expect(options.takeScreenshot).toBe(true);
  });
});
