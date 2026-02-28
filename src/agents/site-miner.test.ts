/**
 * Tests for SiteMiner Subagent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SiteMiner,
  runSiteMiner,
  createSiteMiner,
  isPlaywrightAvailable,
  type SiteMinerOptions,
  type SiteMinerResult,
} from './site-miner.js';
import { Config } from '../config/index.js';
import type { AgentMessage } from '../types/agent.js';
import { isSubagent, isSkillAgent } from './types.js';

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

// Mock the SDK provider
const mockQueryOnce = vi.fn();
vi.mock('../sdk/index.js', () => ({
  getProvider: vi.fn(() => ({
    queryOnce: mockQueryOnce,
  })),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock utils
vi.mock('../utils/sdk.js', () => ({
  buildSdkEnv: vi.fn(() => ({})),
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

  describe('runSiteMiner (legacy function)', () => {
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
      mockQueryOnce.mockImplementation(async function* () {
        yield {
          type: 'result',
          content: JSON.stringify({
            success: true,
            target_url: 'https://example.com',
            information_found: { title: 'Example Domain' },
            summary: 'Found the title',
            confidence: 0.95,
          }),
          role: 'assistant',
        } as AgentMessage;
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
      mockQueryOnce.mockImplementation(async function* () {
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
      mockQueryOnce.mockImplementation(async function* () {
        yield {
          type: 'result',
          content: 'This is not valid JSON',
          role: 'assistant',
        } as AgentMessage;
      });

      const result = await runSiteMiner({
        url: 'https://example.com',
        task: 'Extract title',
      });

      expect(result.success).toBe(false);
      expect(result.notes).toContain('Could not parse JSON');
    });

    it('should handle partial JSON response', async () => {
      mockQueryOnce.mockImplementation(async function* () {
        yield {
          type: 'result',
          content: 'Here is the result: {"success": true, "information_found": {"title": "Test"}, "confidence": 0.8} and some extra text',
          role: 'assistant',
        } as AgentMessage;
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

// ============================================================================
// Subagent Interface Tests (Issue #325)
// ============================================================================

describe('SiteMiner Subagent Interface', () => {
  let siteMiner: SiteMiner;

  beforeEach(() => {
    vi.clearAllMocks();
    siteMiner = new SiteMiner({
      apiKey: 'test-api-key',
      model: 'test-model',
    });
  });

  it('should implement Subagent interface', () => {
    expect(siteMiner.type).toBe('subagent');
    expect(siteMiner.name).toBe('SiteMiner');
    expect(typeof siteMiner.execute).toBe('function');
    expect(typeof siteMiner.dispose).toBe('function');
    expect(typeof siteMiner.asTool).toBe('function');
    expect(typeof siteMiner.getMcpServer).toBe('function');
  });

  it('should NOT pass isSkillAgent type guard (Subagent is distinct from SkillAgent)', () => {
    // Subagent has type 'subagent', not 'skill'
    expect(isSkillAgent(siteMiner)).toBe(false);
  });

  it('should pass isSubagent type guard', () => {
    expect(isSubagent(siteMiner)).toBe(true);
  });

  describe('execute', () => {
    it('should accept string input', async () => {
      mockQueryOnce.mockImplementation(async function* () {
        yield {
          type: 'result',
          content: JSON.stringify({
            success: true,
            target_url: 'https://example.com',
            information_found: { title: 'Test' },
            summary: 'Done',
            confidence: 0.9,
          }),
          role: 'assistant',
        } as AgentMessage;
      });

      const messages: AgentMessage[] = [];
      for await (const msg of siteMiner.execute('Extract data from https://example.com')) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });

    it('should accept UserInput array', async () => {
      mockQueryOnce.mockImplementation(async function* () {
        yield {
          type: 'result',
          content: JSON.stringify({
            success: true,
            target_url: 'https://example.com',
            information_found: {},
            summary: 'Done',
            confidence: 0.8,
          }),
          role: 'assistant',
        } as AgentMessage;
      });

      const messages: AgentMessage[] = [];
      for await (const msg of siteMiner.execute([
        { role: 'user', content: 'https://example.com' },
        { role: 'user', content: 'Extract data' },
      ])) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });

    it('should return failure when Playwright is not available', async () => {
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce(undefined);

      const messages: AgentMessage[] = [];
      for await (const msg of siteMiner.execute('https://example.com')) {
        messages.push(msg);
      }

      expect(messages.length).toBe(1);
      const [{ content }] = messages;
      expect(typeof content).toBe('string');
      const result = JSON.parse(content as string);
      expect(result.success).toBe(false);
      expect(result.summary).toContain('Playwright MCP not configured');
    });

    it('should parse JSON input correctly', async () => {
      mockQueryOnce.mockImplementation(async function* () {
        yield {
          type: 'result',
          content: JSON.stringify({
            success: true,
            target_url: 'https://test.com',
            information_found: { data: 'test' },
            summary: 'Done',
            confidence: 0.95,
          }),
          role: 'assistant',
        } as AgentMessage;
      });

      const messages: AgentMessage[] = [];
      for await (const msg of siteMiner.execute(JSON.stringify({
        url: 'https://test.com',
        task: 'Extract data',
      }))) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('asTool', () => {
    it('should return InlineToolDefinition', () => {
      const toolDef = siteMiner.asTool();

      expect(toolDef.name).toBe('site_miner');
      expect(toolDef.description).toContain('Extract information');
      expect(toolDef.parameters).toBeDefined();
      expect(typeof toolDef.handler).toBe('function');
    });

    it('should have correct parameter schema', () => {
      const toolDef = siteMiner.asTool();
      const schema = toolDef.parameters;

      // Verify schema structure by parsing a valid input
      const result = schema.safeParse({
        url: 'https://example.com',
        task: 'Extract data',
        timeout: 30000,
        takeScreenshot: true,
      });

      expect(result.success).toBe(true);
    });

    it('handler should return SiteMinerResult', async () => {
      mockQueryOnce.mockImplementation(async function* () {
        yield {
          type: 'result',
          content: JSON.stringify({
            success: true,
            target_url: 'https://example.com',
            information_found: { title: 'Test' },
            summary: 'Done',
            confidence: 0.9,
          }),
          role: 'assistant',
        } as AgentMessage;
      });

      const toolDef = siteMiner.asTool();
      const result = await toolDef.handler({
        url: 'https://example.com',
        task: 'Extract title',
      });

      expect(result.success).toBe(true);
      expect(result.target_url).toBe('https://example.com');
      expect(result.information_found).toEqual({ title: 'Test' });
    });
  });

  describe('getMcpServer', () => {
    it('should return McpServerConfig when Playwright is configured', () => {
      const mcpConfig = siteMiner.getMcpServer();

      expect(mcpConfig).toBeDefined();
      expect(mcpConfig?.type).toBe('stdio');
      expect(mcpConfig?.name).toBe('site-miner-playwright');
    });

    it('should return undefined when Playwright is not configured', () => {
      vi.mocked(Config.getMcpServersConfig).mockReturnValueOnce(undefined);

      const mcpConfig = siteMiner.getMcpServer();

      expect(mcpConfig).toBeUndefined();
    });
  });

  describe('cleanup', () => {
    it('should not throw when called', () => {
      expect(() => siteMiner.dispose()).not.toThrow();
    });
  });
});

describe('SiteMiner with custom config', () => {
  it('should accept custom timeout', () => {
    const siteMiner = new SiteMiner({
      apiKey: 'test-key',
      model: 'test-model',
      defaultTimeout: 120000,
    });

    expect(siteMiner).toBeDefined();
  });
});
