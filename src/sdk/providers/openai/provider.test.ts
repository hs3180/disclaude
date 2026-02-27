/**
 * OpenAI Provider 测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAISDKProvider } from './provider.js';
import { adaptUserInput, adaptStreamChunk, adaptResponse } from './message-adapter.js';
import { adaptOptions, adaptInput } from './options-adapter.js';
import type { UserInput, AgentQueryOptions } from '../../types.js';

describe('OpenAISDKProvider', () => {
  let provider: OpenAISDKProvider;

  beforeEach(() => {
    provider = new OpenAISDKProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('getInfo', () => {
    it('should return provider info with correct name and version', () => {
      const info = provider.getInfo();
      expect(info.name).toBe('openai');
      expect(info.version).toBe('1.0.0');
    });

    it('should report unavailable when OPENAI_API_KEY is not set', () => {
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const info = provider.getInfo();
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toBe('OPENAI_API_KEY not set');

      if (originalKey) {
        process.env.OPENAI_API_KEY = originalKey;
      }
    });

    it('should report available when OPENAI_API_KEY is set', () => {
      const originalKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      const info = provider.getInfo();
      expect(info.available).toBe(true);
      expect(info.unavailableReason).toBeUndefined();

      if (originalKey) {
        process.env.OPENAI_API_KEY = originalKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });
  });

  describe('validateConfig', () => {
    it('should return false when API key is not set', () => {
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      expect(provider.validateConfig()).toBe(false);

      if (originalKey) {
        process.env.OPENAI_API_KEY = originalKey;
      }
    });

    it('should return true when API key is set', () => {
      const originalKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      expect(provider.validateConfig()).toBe(true);

      if (originalKey) {
        process.env.OPENAI_API_KEY = originalKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });
  });

  describe('dispose', () => {
    it('should mark provider as disposed', () => {
      provider.dispose();

      expect(async () => {
        for await (const _ of provider.queryOnce('test', {})) {
          // Should throw
        }
      }).rejects.toThrow('Provider has been disposed');
    });
  });

  describe('createInlineTool', () => {
    it('should create tool definition', () => {
      const tool = provider.createInlineTool({
        name: 'test_tool',
        description: 'A test tool',
        parameters: {} as never,
        handler: async () => 'result',
      });

      expect(tool).toEqual({
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'A test tool',
          parameters: {},
        },
      });
    });
  });

  describe('createMcpServer', () => {
    it('should throw error for MCP server creation', () => {
      expect(() =>
        provider.createMcpServer({
          type: 'inline',
          name: 'test',
          version: '1.0',
        })
      ).toThrow('MCP servers are not supported by OpenAISDKProvider');
    });
  });
});

describe('message-adapter', () => {
  describe('adaptUserInput', () => {
    it('should adapt string content', () => {
      const input: UserInput = { role: 'user', content: 'Hello' };
      const result = adaptUserInput(input);

      expect(result).toEqual({
        role: 'user',
        content: 'Hello',
      });
    });

    it('should adapt multimodal content', () => {
      const input: UserInput = {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
        ],
      };
      const result = adaptUserInput(input);

      expect(result).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,base64data',
            },
          },
        ],
      });
    });
  });

  describe('adaptStreamChunk', () => {
    it('should adapt text content chunk', () => {
      const chunk = {
        id: 'test',
        object: 'chat.completion.chunk',
        created: 1234567890,
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            delta: { content: 'Hello' },
            finish_reason: null,
          },
        ],
      };

      const accumulator = new Map();
      const messages = adaptStreamChunk(chunk, accumulator);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'text',
        content: 'Hello',
        role: 'assistant',
      });
    });

    it('should adapt finish reason', () => {
      const chunk = {
        id: 'test',
        object: 'chat.completion.chunk',
        created: 1234567890,
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      };

      const accumulator = new Map();
      const messages = adaptStreamChunk(chunk, accumulator);

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('result');
      expect(messages[0].metadata?.stopReason).toBe('stop');
    });
  });

  describe('adaptResponse', () => {
    it('should adapt non-streaming response', () => {
      const response = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Hello world',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };

      const messages = adaptResponse(response);

      expect(messages).toHaveLength(3);
      expect(messages[0].type).toBe('text');
      expect(messages[0].content).toBe('Hello world');
      expect(messages[1].type).toBe('result');
      expect(messages[2].type).toBe('status');
      expect(messages[2].metadata?.inputTokens).toBe(10);
    });
  });
});

describe('options-adapter', () => {
  describe('adaptOptions', () => {
    it('should use default model when not specified', () => {
      const options: AgentQueryOptions = {};
      const result = adaptOptions(options);

      expect(result.model).toBe('gpt-4o');
      expect(result.stream).toBe(true);
    });

    it('should map model names correctly', () => {
      const options: AgentQueryOptions = { model: 'gpt-4' };
      const result = adaptOptions(options);

      expect(result.model).toBe('gpt-4-turbo');
    });
  });

  describe('adaptInput', () => {
    it('should adapt string input', () => {
      const result = adaptInput('Hello');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'user',
        content: 'Hello',
      });
    });

    it('should adapt UserInput array', () => {
      const input: UserInput[] = [
        { role: 'user', content: 'Hello' },
        { role: 'user', content: 'World' },
      ];
      const result = adaptInput(input);

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('user');
    });
  });
});
