/**
 * Tests for Scout agent (src/agent/scout.ts)
 *
 * Tests the following functionality:
 * - Agent initialization and skill loading
 * - Task context management
 * - Query streaming with SDK integration
 * - Error handling
 * - Cleanup operations
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scout } from './scout.js';
import type { ScoutConfig } from './scout.js';
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
  buildScoutPrompt: vi.fn((prompt, context, skill) => {
    return `[Context: ${context.taskPath}]\n${prompt}`;
  }),
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

describe('Scout', () => {
  let scout: Scout;
  let config: ScoutConfig;

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
        name: 'scout',
        content: 'You are a scout agent.',
        allowedTools: ['Write', 'WebSearch'],
      },
    });

    scout = new Scout(config);
  });

  describe('constructor', () => {
    it('should create scout instance with config', () => {
      expect(scout).toBeInstanceOf(Scout);
      expect(scout.apiKey).toBe('test-api-key');
      expect(scout.model).toBe('claude-3-5-sonnet-20241022');
      expect(scout.apiBaseUrl).toBe('https://api.anthropic.com');
    });

    it('should use workspace directory from config', () => {
      expect(scout.workingDirectory).toBe('/mock/workspace');
    });

    it('should create scout without apiBaseUrl', () => {
      const configWithoutUrl: ScoutConfig = {
        apiKey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
      };

      const scoutWithoutUrl = new Scout(configWithoutUrl);
      expect(scoutWithoutUrl.apiBaseUrl).toBeUndefined();
    });
  });

  describe('initialize', () => {
    it('should load skill on initialization', async () => {
      await scout.initialize();

      expect(mockedLoadSkill).toHaveBeenCalledWith('scout');
    });

    it('should set initialized flag after successful init', async () => {
      await scout.initialize();

      // Check if initialize can be called again without issues
      await scout.initialize();
    });

    it('should throw error if skill loading fails', async () => {
      mockedLoadSkill.mockResolvedValue({
        success: false,
        error: 'Skill file not found',
      });

      await expect(scout.initialize()).rejects.toThrow('Scout skill is required');
    });

    it('should throw error if skill is null', async () => {
      mockedLoadSkill.mockResolvedValue({
        success: true,
        skill: null,
      });

      await expect(scout.initialize()).rejects.toThrow();
    });
  });

  describe('setTaskContext', () => {
    it('should set task context', () => {
      const context = {
        chatId: 'oc_chat123',
        messageId: 'om_msg456',
        taskPath: '/path/to/task.md',
      };

      scout.setTaskContext(context);

      // Context should be set (verified by queryStream behavior)
      expect(mockedLoadSkill).not.toHaveBeenCalled();
    });
  });

  describe('queryStream', () => {
    it('should initialize automatically if not initialized', async () => {
      const mockGenerator = async function* () {
        yield { content: 'Test response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      const stream = scout.queryStream('Test prompt');

      for await (const _ of stream) {
        // Consume stream
      }

      expect(mockedLoadSkill).toHaveBeenCalled();
    });

    it('should stream messages from SDK', async () => {
      await scout.initialize();

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
      for await (const msg of scout.queryStream('Test prompt')) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Response 1');
      expect(messages[1].content).toBe('Response 2');
    });

    it('should skip messages without content', async () => {
      await scout.initialize();

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
      for await (const msg of scout.queryStream('Test prompt')) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Valid content');
    });

    it('should build prompt with context when available', async () => {
      await scout.initialize();

      const context = {
        chatId: 'oc_chat123',
        messageId: 'om_msg456',
        taskPath: '/path/to/task.md',
      };

      scout.setTaskContext(context);

      const mockGenerator = async function* () {
        yield { content: 'Test response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of scout.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('/path/to/task.md'),
        })
      );
    });

    it('should handle query errors gracefully', async () => {
      await scout.initialize();

      mockedQuery.mockImplementation(() => {
        throw new Error('SDK query failed');
      });

      const messages: AgentMessage[] = [];
      for await (const msg of scout.queryStream('Test prompt')) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain('Error');
      expect(messages[0].messageType).toBe('error');
    });

    it('should use skill-based tool configuration', async () => {
      await scout.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of scout.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            allowedTools: ['Write', 'WebSearch'],
          }),
        })
      );
    });
  });

  describe('cleanup', () => {
    it('should clear task context on cleanup', () => {
      const context = {
        chatId: 'oc_chat123',
        messageId: 'om_msg456',
        taskPath: '/path/to/task.md',
      };

      scout.setTaskContext(context);
      scout.cleanup();

      // Cleanup should not throw
      expect(() => scout.cleanup()).not.toThrow();
    });
  });

  describe('SDK integration', () => {
    it('should build SDK environment with API key', async () => {
      await scout.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of scout.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(buildSdkEnv).toHaveBeenCalledWith('test-api-key', 'https://api.anthropic.com');
    });

    it('should set model in SDK options', async () => {
      await scout.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of scout.queryStream('Test prompt')) {
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
      await scout.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of scout.queryStream('Test prompt')) {
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
  });
});
