/**
 * OpenAI SDK Provider 单元测试
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAISDKProvider } from './provider.js';
import { adaptStreamEvent, adaptRunResult } from './message-adapter.js';
import { adaptInput, extractOpenAIConfig } from './options-adapter.js';

describe('OpenAISDKProvider', () => {
  let provider: OpenAISDKProvider;

  beforeEach(() => {
    provider = new OpenAISDKProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('getInfo', () => {
    it('should return provider info with name and version', () => {
      const info = provider.getInfo();
      assert.equal(info.name, 'openai');
      assert.equal(info.version, '0.7.2');
    });

    it('should indicate unavailable when OPENAI_API_KEY is not set', () => {
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const info = provider.getInfo();
      assert.equal(info.available, false);
      assert.ok(info.unavailableReason?.includes('OPENAI_API_KEY'));

      if (originalKey) {
        process.env.OPENAI_API_KEY = originalKey;
      }
    });
  });

  describe('validateConfig', () => {
    it('should return false when OPENAI_API_KEY is not set', () => {
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      assert.equal(provider.validateConfig(), false);

      if (originalKey) {
        process.env.OPENAI_API_KEY = originalKey;
      }
    });

    it('should return boolean for any env state', () => {
      const originalKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-key';

      const result = provider.validateConfig();
      assert.equal(typeof result, 'boolean');

      if (!originalKey) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalKey;
      }
    });
  });

  describe('dispose', () => {
    it('should mark provider as disposed', async () => {
      provider.dispose();
      // queryOnce is an async generator - it throws when first iterated
      try {
        const gen = provider.queryOnce('test', {
          cwd: '/tmp',
          settingSources: ['project'],
        });
        await gen.next();
        assert.fail('Expected error was not thrown');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('disposed'));
      }
    });
  });

  describe('name and version', () => {
    it('should have correct name', () => {
      assert.equal(provider.name, 'openai');
    });

    it('should have correct version', () => {
      assert.equal(provider.version, '0.7.2');
    });
  });
});

describe('OpenAI Message Adapter', () => {
  describe('adaptStreamEvent', () => {
    it('should return null for agent updated events', () => {
      const event = { type: 'agent_updated_stream_event', agent: {} };
      const result = adaptStreamEvent(event as any);
      assert.equal(result, null);
    });

    it('should handle message output items via run_item_stream_event', () => {
      const event = {
        type: 'run_item_stream_event',
        name: 'message_output_created',
        item: {
          type: 'message_output_item',
          rawItem: {
            content: [{ type: 'output_text', text: 'Hello world' }],
          },
        },
      };
      const result = adaptStreamEvent(event as any);
      assert.ok(result);
      assert.equal(result!.type, 'text');
      assert.equal(result!.content, 'Hello world');
      assert.equal(result!.role, 'assistant');
    });

    it('should handle tool call items', () => {
      const event = {
        type: 'run_item_stream_event',
        name: 'tool_called',
        item: {
          type: 'tool_call_item',
          rawItem: {
            name: 'read_file',
            arguments: '{"path": "/test.txt"}',
            callId: 'call_123',
          },
        },
      };
      const result = adaptStreamEvent(event as any);
      assert.ok(result);
      assert.equal(result!.type, 'tool_use');
      assert.equal(result!.metadata?.toolName, 'read_file');
    });

    it('should handle tool call output items', () => {
      const event = {
        type: 'run_item_stream_event',
        name: 'tool_output',
        item: {
          type: 'tool_call_output_item',
          rawItem: {
            callId: 'call_123',
            output: 'File contents here',
          },
        },
      };
      const result = adaptStreamEvent(event as any);
      assert.ok(result);
      assert.equal(result!.type, 'tool_result');
      assert.ok(result!.content.includes('File contents here'));
    });

    it('should return null for empty message output', () => {
      const event = {
        type: 'run_item_stream_event',
        name: 'message_output_created',
        item: {
          type: 'message_output_item',
          rawItem: {
            content: [],
          },
        },
      };
      const result = adaptStreamEvent(event as any);
      assert.equal(result, null);
    });

    it('should return null for unknown item types', () => {
      const event = {
        type: 'run_item_stream_event',
        name: 'unknown_event',
        item: {
          type: 'handoff_call_item',
          rawItem: {},
        },
      };
      const result = adaptStreamEvent(event as any);
      assert.equal(result, null);
    });
  });

  describe('adaptRunResult', () => {
    it('should create result message', () => {
      const result = {
        state: {},
        finalOutput: 'Task completed successfully',
      };
      const message = adaptRunResult(result as any);
      assert.equal(message.type, 'result');
      assert.ok(message.content.includes('✅ Complete'));
    });

    it('should handle result without state or finalOutput', () => {
      const result = {};
      const message = adaptRunResult(result as any);
      assert.equal(message.type, 'result');
      assert.ok(message.content.includes('✅ Complete'));
    });
  });
});

describe('OpenAI Options Adapter', () => {
  describe('adaptInput', () => {
    it('should pass through string input', () => {
      assert.equal(adaptInput('Hello world'), 'Hello world');
    });

    it('should convert UserInput array to string', () => {
      const input = [
        { role: 'user' as const, content: 'First message' },
        { role: 'user' as const, content: 'Second message' },
      ];
      const result = adaptInput(input);
      assert.ok(result.includes('First message'));
      assert.ok(result.includes('Second message'));
    });
  });

  describe('extractOpenAIConfig', () => {
    it('should extract API key from env', () => {
      const config = extractOpenAIConfig({
        cwd: '/tmp',
        env: { OPENAI_API_KEY: 'sk-test-123' },
        settingSources: ['project'],
      });
      assert.equal(config.apiKey, 'sk-test-123');
    });

    it('should extract base URL from env', () => {
      const config = extractOpenAIConfig({
        cwd: '/tmp',
        env: { OPENAI_BASE_URL: 'https://api.example.com/v1' },
        settingSources: ['project'],
      });
      assert.equal(config.baseUrl, 'https://api.example.com/v1');
    });

    it('should extract model from options', () => {
      const config = extractOpenAIConfig({
        cwd: '/tmp',
        model: 'gpt-4o-mini',
        settingSources: ['project'],
      });
      assert.equal(config.model, 'gpt-4o-mini');
    });

    it('should handle missing env', () => {
      const config = extractOpenAIConfig({
        cwd: '/tmp',
        settingSources: ['project'],
      });
      assert.equal(config.apiKey, undefined);
      assert.equal(config.baseUrl, undefined);
      assert.equal(config.model, undefined);
    });
  });
});
