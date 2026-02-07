/**
 * Tests for Worker agent (src/agent/worker.ts)
 *
 * Tests the following functionality:
 * - Agent initialization and skill loading
 * - Query streaming with SDK integration
 * - Error handling
 * - Cleanup operations
 * - MCP server configuration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Worker } from './worker.js';
import type { WorkerConfig } from './worker.js';
import type { AgentMessage } from '../types/agent.js';

// Mock dependencies
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/mock/workspace',
  },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('./skill-loader.js', () => ({
  loadSkill: vi.fn(),
  getSkillMcpServers: vi.fn(() => ({
    playwright: {
      type: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
    },
  })),
}));

vi.mock('../utils/sdk.js', () => ({
  parseSDKMessage: vi.fn((message) => ({
    content: message.content,
    type: message.type,
    metadata: message.metadata,
  })),
  buildSdkEnv: vi.fn(() => ({
    ANTHROPIC_API_KEY: 'test-key',
  })),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadSkill } from './skill-loader.js';
import { parseSDKMessage, buildSdkEnv } from '../utils/sdk.js';

const mockedQuery = vi.mocked(query);
const mockedLoadSkill = vi.mocked(loadSkill);
const mockedParseSDKMessage = vi.mocked(parseSDKMessage);

describe('Worker', () => {
  let worker: Worker;
  let config: WorkerConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    config = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      apiBaseUrl: 'https://api.anthropic.com',
    };

    // Mock successful skill loading
    mockedLoadSkill.mockResolvedValue({
      success: true,
      skill: {
        name: 'worker',
        content: 'You are a worker agent.',
        allowedTools: ['Read', 'Write', 'Bash', 'WebSearch'],
      },
    });

    worker = new Worker(config);
  });

  describe('constructor', () => {
    it('should create worker instance with config', () => {
      expect(worker).toBeInstanceOf(Worker);
      expect(worker.apiKey).toBe('test-api-key');
      expect(worker.model).toBe('claude-3-5-sonnet-20241022');
      expect(worker.apiBaseUrl).toBe('https://api.anthropic.com');
    });

    it('should use workspace directory from config', () => {
      expect(worker.workingDirectory).toBe('/mock/workspace');
    });

    it('should create worker without apiBaseUrl', () => {
      const configWithoutUrl: WorkerConfig = {
        apiKey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
      };

      const workerWithoutUrl = new Worker(configWithoutUrl);
      expect(workerWithoutUrl.apiBaseUrl).toBeUndefined();
    });
  });

  describe('initialize', () => {
    it('should load skill on initialization', async () => {
      await worker.initialize();

      expect(mockedLoadSkill).toHaveBeenCalledWith('worker');
    });

    it('should set initialized flag after successful init', async () => {
      await worker.initialize();

      // Should not throw on second call
      await worker.initialize();
    });

    it('should throw error if skill loading fails', async () => {
      mockedLoadSkill.mockResolvedValue({
        success: false,
        error: 'Worker skill file not found',
      });

      await expect(worker.initialize()).rejects.toThrow('Worker skill is required');
    });

    it('should throw error if skill is null', async () => {
      mockedLoadSkill.mockResolvedValue({
        success: true,
        skill: null,
      });

      await expect(worker.initialize()).rejects.toThrow();
    });
  });

  describe('queryStream', () => {
    it('should initialize automatically if not initialized', async () => {
      const mockGenerator = async function* () {
        yield { content: 'Test response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      const stream = worker.queryStream('Test prompt');

      for await (const _ of stream) {
        // Consume stream
      }

      expect(mockedLoadSkill).toHaveBeenCalled();
    });

    it('should stream messages from SDK', async () => {
      await worker.initialize();

      const mockMessages = [
        { content: 'Response 1', type: 'text' },
        { content: 'Response 2', type: 'text' },
      ];

      const mockGenerator = async function* () {
        for (const msg of mockMessages) {
          yield msg;
        }
      };

      mockedQuery.mockReturnValue(mockGenerator());
      mockedParseSDKMessage.mockImplementation((msg) => ({
        content: msg.content,
        type: msg.type,
        metadata: undefined,
      }));

      const messages: AgentMessage[] = [];
      for await (const msg of worker.queryStream('Test prompt')) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Response 1');
      expect(messages[1].content).toBe('Response 2');
    });

    it('should skip messages without content', async () => {
      await worker.initialize();

      const mockGenerator = async function* () {
        yield { content: '', type: 'text' };
        yield { content: 'Valid content', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());
      mockedParseSDKMessage.mockImplementation((msg) => ({
        content: msg.content || undefined,
        type: msg.type,
        metadata: undefined,
      }));

      const messages: AgentMessage[] = [];
      for await (const msg of worker.queryStream('Test prompt')) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Valid content');
    });

    it('should handle query errors gracefully', async () => {
      await worker.initialize();

      mockedQuery.mockImplementation(() => {
        throw new Error('SDK query failed');
      });

      const messages: AgentMessage[] = [];
      for await (const msg of worker.queryStream('Test prompt')) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain('Error');
      expect(messages[0].messageType).toBe('error');
    });

    it('should use skill-based tool configuration', async () => {
      await worker.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of worker.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            allowedTools: ['Read', 'Write', 'Bash', 'WebSearch'],
          }),
        })
      );
    });

    it('should use default tools if skill not loaded', async () => {
      // Skip initialization to test default tools
      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of worker.queryStream('Test prompt')) {
        // Consume stream
      }

      const callArgs = mockedQuery.mock.calls[0][0];
      const allowedTools = callArgs.options.allowedTools as string[];

      // Should contain tools from skill mock
      expect(allowedTools).toContain('Read');
      expect(allowedTools).toContain('Write');
      expect(allowedTools).toContain('Bash');
      expect(allowedTools).toContain('WebSearch');
    });
  });

  describe('cleanup', () => {
    it('should cleanup without throwing', () => {
      expect(() => worker.cleanup()).not.toThrow();
    });
  });

  describe('SDK integration', () => {
    it('should build SDK environment with API key', async () => {
      await worker.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of worker.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(buildSdkEnv).toHaveBeenCalledWith('test-api-key', 'https://api.anthropic.com');
    });

    it('should set model in SDK options', async () => {
      await worker.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of worker.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: 'claude-3-5-sonnet-20241022',
          }),
        })
      );
    });

    it('should use bypassPermissions mode', async () => {
      await worker.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of worker.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            permissionMode: 'bypassPermissions',
          }),
        })
      );
    });

    it('should include MCP servers in configuration', async () => {
      await worker.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of worker.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            mcpServers: expect.objectContaining({
              playwright: expect.any(Object),
            }),
          }),
        })
      );
    });

    it('should use workspace directory as cwd', async () => {
      await worker.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of worker.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            cwd: '/mock/workspace',
          }),
        })
      );
    });
  });
});
