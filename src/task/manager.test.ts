/**
 * Tests for Manager agent (src/agent/manager.ts)
 *
 * Tests the following functionality:
 * - Agent initialization and skill loading
 * - Query streaming with SDK integration
 * - Error handling
 * - Cleanup operations
 * - Permission mode handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Manager } from './manager.js';
import type { ManagerConfig } from './manager.js';
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

vi.mock('../mcp/feishu-context-mcp.js', () => ({
  feishuSdkMcpServer: {
    transport: {
      type: 'stdio',
    },
  },
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadSkill } from './skill-loader.js';
import { parseSDKMessage, buildSdkEnv } from '../utils/sdk.js';

const mockedQuery = vi.mocked(query);
const mockedLoadSkill = vi.mocked(loadSkill);
const mockedParseSDKMessage = vi.mocked(parseSDKMessage);

describe('Manager', () => {
  let manager: Manager;
  let config: ManagerConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    config = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      apiBaseUrl: 'https://api.anthropic.com',
      permissionMode: 'bypassPermissions',
    };

    // Mock successful skill loading
    mockedLoadSkill.mockResolvedValue({
      success: true,
      skill: {
        name: 'manager',
        content: 'You are a manager agent.',
        allowedTools: ['WebSearch', 'send_user_feedback', 'task_done'],
      },
    });

    manager = new Manager(config);
  });

  describe('constructor', () => {
    it('should create manager instance with config', () => {
      expect(manager).toBeInstanceOf(Manager);
      expect(manager.apiKey).toBe('test-api-key');
      expect(manager.model).toBe('claude-3-5-sonnet-20241022');
      expect(manager.apiBaseUrl).toBe('https://api.anthropic.com');
    });

    it('should default to bypassPermissions mode', () => {
      const configWithoutMode: ManagerConfig = {
        apiKey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
      };

      const managerWithDefault = new Manager(configWithoutMode);
      expect(managerWithDefault.permissionMode).toBe('bypassPermissions');
    });

    it('should respect custom permission mode', () => {
      const configWithMode: ManagerConfig = {
        apiKey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
        permissionMode: 'default',
      };

      const managerWithMode = new Manager(configWithMode);
      expect(managerWithMode.permissionMode).toBe('default');
    });
  });

  describe('initialize', () => {
    it('should load skill on initialization', async () => {
      await manager.initialize();

      expect(mockedLoadSkill).toHaveBeenCalledWith('manager');
    });

    it('should set initialized flag after successful init', async () => {
      await manager.initialize();

      // Should not throw on second call
      await manager.initialize();
    });

    it('should throw error if skill loading fails', async () => {
      mockedLoadSkill.mockResolvedValue({
        success: false,
        error: 'Manager skill file not found',
      });

      await expect(manager.initialize()).rejects.toThrow('Manager skill is required');
    });

    it('should throw error if skill is null', async () => {
      mockedLoadSkill.mockResolvedValue({
        success: true,
        skill: null,
      });

      await expect(manager.initialize()).rejects.toThrow();
    });
  });

  describe('queryStream', () => {
    it('should initialize automatically if not initialized', async () => {
      const mockGenerator = async function* () {
        yield { content: 'Test response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      const stream = manager.queryStream('Test prompt');

      for await (const _ of stream) {
        // Consume stream
      }

      expect(mockedLoadSkill).toHaveBeenCalled();
    });

    it('should stream messages from SDK', async () => {
      await manager.initialize();

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
      for await (const msg of manager.queryStream('Test prompt')) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Response 1');
      expect(messages[1].content).toBe('Response 2');
    });

    it('should skip messages without content', async () => {
      await manager.initialize();

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
      for await (const msg of manager.queryStream('Test prompt')) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Valid content');
    });

    it('should handle query errors gracefully', async () => {
      await manager.initialize();

      mockedQuery.mockImplementation(() => {
        throw new Error('SDK query failed');
      });

      const messages: AgentMessage[] = [];
      for await (const msg of manager.queryStream('Test prompt')) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain('Error');
      expect(messages[0].messageType).toBe('error');
    });

    it('should use skill-based tool configuration', async () => {
      await manager.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of manager.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            allowedTools: ['WebSearch', 'send_user_feedback', 'task_done'],
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

      for await (const _ of manager.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            allowedTools: expect.arrayContaining([
              'WebSearch',
              'send_user_feedback',
              'task_done',
            ]),
          }),
        })
      );
    });
  });

  describe('cleanup', () => {
    it('should cleanup without throwing', () => {
      expect(() => manager.cleanup()).not.toThrow();
    });
  });

  describe('SDK integration', () => {
    it('should build SDK environment with API key', async () => {
      await manager.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of manager.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(buildSdkEnv).toHaveBeenCalledWith('test-api-key', 'https://api.anthropic.com');
    });

    it('should set model in SDK options', async () => {
      await manager.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of manager.queryStream('Test prompt')) {
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

    it('should use configured permission mode', async () => {
      await manager.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of manager.queryStream('Test prompt')) {
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

    it('should register Feishu context MCP server', async () => {
      await manager.initialize();

      const mockGenerator = async function* () {
        yield { content: 'Response', type: 'text' };
      };

      mockedQuery.mockReturnValue(mockGenerator());

      for await (const _ of manager.queryStream('Test prompt')) {
        // Consume stream
      }

      expect(mockedQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            mcpServers: expect.objectContaining({
              'feishu-context': expect.any(Object),
            }),
          }),
        })
      );
    });
  });
});
