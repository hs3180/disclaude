/**
 * OpenAI Provider 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Message Adapter Tests
// ============================================================================

describe('OpenAI Message Adapter', () => {
  describe('adaptStreamEvent', () => {
    it('should handle raw_model_stream_event with text delta', async () => {
      const { adaptStreamEvent } = await import('./message-adapter.js');

      const event = {
        type: 'raw_model_stream_event',
        data: {
          type: 'response.output_text.delta',
          delta: 'Hello, ',
        },
      };

      const result = adaptStreamEvent(event as any);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('text');
      expect(result!.content).toBe('Hello, ');
      expect(result!.role).toBe('assistant');
    });

    it('should ignore raw_model_stream_event with non-text types', async () => {
      const { adaptStreamEvent } = await import('./message-adapter.js');

      const event = {
        type: 'raw_model_stream_event',
        data: {
          type: 'response.function_call_arguments.delta',
          delta: '{}',
        },
      };

      const result = adaptStreamEvent(event as any);
      expect(result).toBeNull();
    });

    it('should ignore raw_model_stream_event without data', async () => {
      const { adaptStreamEvent } = await import('./message-adapter.js');

      const event = {
        type: 'raw_model_stream_event',
      };

      const result = adaptStreamEvent(event as any);
      expect(result).toBeNull();
    });

    it('should handle run_item_stream_event tool_called', async () => {
      const { adaptStreamEvent } = await import('./message-adapter.js');

      const event = {
        type: 'run_item_stream_event',
        name: 'tool_called',
        item: {
          type: 'tool_call',
          name: 'bash',
          arguments: '{"command": "ls -la"}',
        },
      };

      const result = adaptStreamEvent(event as any);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('tool_use');
      expect(result!.content).toContain('🔧 Running: ls -la');
      expect(result!.metadata?.toolName).toBe('bash');
      expect(result!.metadata?.toolInput).toEqual({ command: 'ls -la' });
    });

    it('should handle run_item_stream_event tool_output', async () => {
      const { adaptStreamEvent } = await import('./message-adapter.js');

      const event = {
        type: 'run_item_stream_event',
        name: 'tool_output',
        item: {
          type: 'function_call_output',
          output: 'result data',
        },
      };

      const result = adaptStreamEvent(event as any);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('tool_result');
      expect(result!.content).toContain('✓ Tool completed');
    });

    it('should ignore run_item_stream_event message_output_created', async () => {
      const { adaptStreamEvent } = await import('./message-adapter.js');

      const event = {
        type: 'run_item_stream_event',
        name: 'message_output_created',
        item: {
          type: 'message',
          content: [{ type: 'text', text: 'Full message' }],
        },
      };

      const result = adaptStreamEvent(event as any);
      expect(result).toBeNull();
    });

    it('should handle run_item_stream_event tool_approval_requested', async () => {
      const { adaptStreamEvent } = await import('./message-adapter.js');

      const event = {
        type: 'run_item_stream_event',
        name: 'tool_approval_requested',
        item: {
          type: 'tool_call',
          name: 'dangerous_tool',
        },
      };

      const result = adaptStreamEvent(event as any);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('tool_progress');
      expect(result!.content).toContain('Approval required');
      expect(result!.metadata?.toolName).toBe('dangerous_tool');
    });

    it('should ignore run_item_stream_event reasoning_item_created', async () => {
      const { adaptStreamEvent } = await import('./message-adapter.js');

      const event = {
        type: 'run_item_stream_event',
        name: 'reasoning_item_created',
        item: { type: 'reasoning' },
      };

      const result = adaptStreamEvent(event as any);
      expect(result).toBeNull();
    });

    it('should ignore run_item_stream_event without name or item', async () => {
      const { adaptStreamEvent } = await import('./message-adapter.js');

      expect(adaptStreamEvent({ type: 'run_item_stream_event' } as any)).toBeNull();
      expect(adaptStreamEvent({ type: 'run_item_stream_event', name: 'tool_called' } as any)).toBeNull();
      expect(adaptStreamEvent({ type: 'run_item_stream_event', item: {} } as any)).toBeNull();
    });

    it('should ignore unknown event types', async () => {
      const { adaptStreamEvent } = await import('./message-adapter.js');

      expect(adaptStreamEvent({ type: 'unknown_event' } as any)).toBeNull();
    });

    it('should ignore agent_updated_stream_event', async () => {
      const { adaptStreamEvent } = await import('./message-adapter.js');

      const event = {
        type: 'agent_updated_stream_event',
        agent: {},
      };

      const result = adaptStreamEvent(event as any);
      expect(result).toBeNull();
    });

    it('should format tool events for known tool names', async () => {
      const { adaptStreamEvent } = await import('./message-adapter.js');

      // Edit tool
      const editEvent = {
        type: 'run_item_stream_event',
        name: 'tool_called',
        item: { name: 'edit_file', arguments: '{"path": "/tmp/test.ts"}' },
      };
      expect(adaptStreamEvent(editEvent as any)!.content).toContain('🔧 Editing: /tmp/test.ts');

      // Read tool
      const readEvent = {
        type: 'run_item_stream_event',
        name: 'tool_called',
        item: { name: 'read_file', arguments: '{"path": "/tmp/test.ts"}' },
      };
      expect(adaptStreamEvent(readEvent as any)!.content).toContain('🔧 Reading: /tmp/test.ts');

      // Grep tool
      const grepEvent = {
        type: 'run_item_stream_event',
        name: 'tool_called',
        item: { name: 'grep', arguments: '{"pattern": "TODO"}' },
      };
      expect(adaptStreamEvent(grepEvent as any)!.content).toContain('🔧 Searching for "TODO"');

      // Glob tool
      const globEvent = {
        type: 'run_item_stream_event',
        name: 'tool_called',
        item: { name: 'glob', arguments: '{"pattern": "**/*.ts"}' },
      };
      expect(adaptStreamEvent(globEvent as any)!.content).toContain('🔧 Finding files: **/*.ts');

      // Unknown tool
      const unknownEvent = {
        type: 'run_item_stream_event',
        name: 'tool_called',
        item: { name: 'custom_tool', arguments: '{"key": "value"}' },
      };
      const unknownResult = adaptStreamEvent(unknownEvent as any)!;
      expect(unknownResult.content).toContain('🔧 custom_tool:');
    });
  });

  describe('adaptStreamResult', () => {
    it('should extract usage from rawResponses', async () => {
      const { adaptStreamResult } = await import('./message-adapter.js');

      const mockStreamResult = {
        rawResponses: [{
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
          },
        }],
        finalOutput: undefined,
      };

      const result = adaptStreamResult(mockStreamResult as any);
      expect(result.type).toBe('result');
      expect(result.content).toContain('✅ Complete');
      expect(result.content).toContain('Tokens: 0.1k'); // 150/1000 = 0.15 → toFixed(1) = "0.1" (floating point)
      expect(result.metadata?.inputTokens).toBe(100);
      expect(result.metadata?.outputTokens).toBe(50);
    });

    it('should handle stream result without usage', async () => {
      const { adaptStreamResult } = await import('./message-adapter.js');

      const mockStreamResult = {
        rawResponses: [{}],
        finalOutput: undefined,
      };

      const result = adaptStreamResult(mockStreamResult as any);
      expect(result.type).toBe('result');
      expect(result.content).toBe('✅ Complete');
    });

    it('should handle stream result with finalOutput', async () => {
      const { adaptStreamResult } = await import('./message-adapter.js');

      const mockStreamResult = {
        rawResponses: [],
        finalOutput: 'This is the final answer from the agent.',
      };

      const result = adaptStreamResult(mockStreamResult as any);
      expect(result.type).toBe('result');
      expect(result.content).toContain('This is the final answer from the agent.');
    });

    it('should truncate long finalOutput', async () => {
      const { adaptStreamResult } = await import('./message-adapter.js');

      const longOutput = 'A'.repeat(200);
      const mockStreamResult = {
        rawResponses: [],
        finalOutput: longOutput,
      };

      const result = adaptStreamResult(mockStreamResult as any);
      expect(result.content).toContain('...');
      expect(result.content.length).toBeLessThan(longOutput.length + 50);
    });

    it('should handle empty rawResponses', async () => {
      const { adaptStreamResult } = await import('./message-adapter.js');

      const mockStreamResult = {
        rawResponses: [],
        finalOutput: undefined,
      };

      const result = adaptStreamResult(mockStreamResult as any);
      expect(result.type).toBe('result');
      expect(result.content).toBe('✅ Complete');
    });
  });
});

// ============================================================================
// Options Adapter Tests
// ============================================================================

describe('OpenAI Options Adapter', () => {
  describe('adaptOptions', () => {
    it('should adapt model option', async () => {
      const { adaptOptions } = await import('./options-adapter.js');

      const result = adaptOptions({ settingSources: ['test'] });
      expect(result.model).toBeUndefined();

      const resultWithModel = adaptOptions({ model: 'gpt-4o', settingSources: ['test'] });
      expect(resultWithModel.model).toBe('gpt-4o');
    });

    it('should adapt permissionMode to maxTurns', async () => {
      const { adaptOptions } = await import('./options-adapter.js');

      const defaultResult = adaptOptions({ settingSources: ['test'] });
      expect(defaultResult.maxTurns).toBeUndefined();

      const bypassResult = adaptOptions({
        permissionMode: 'bypassPermissions',
        settingSources: ['test'],
      });
      expect(bypassResult.maxTurns).toBe(100);
    });
  });

  describe('adaptInput', () => {
    it('should pass through string input', async () => {
      const { adaptInput } = await import('./options-adapter.js');

      const result = adaptInput('Hello, world!');
      expect(result).toBe('Hello, world!');
    });

    it('should adapt UserInput array to string', async () => {
      const { adaptInput } = await import('./options-adapter.js');

      const result = adaptInput([
        { role: 'user', content: 'First message' },
        { role: 'user', content: 'Second message' },
      ]);
      expect(result).toBe('First message\nSecond message');
    });

    it('should adapt UserInput with content blocks to string', async () => {
      const { adaptInput } = await import('./options-adapter.js');

      const result = adaptInput([
        {
          role: 'user',
          content: [{ type: 'text', text: 'Block content' }],
        },
      ]);
      expect(result).toContain('Block content');
    });
  });
});

// ============================================================================
// Provider Tests
// ============================================================================

describe('OpenAIProvider', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.OPENAI_API_KEY = originalApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  describe('validateConfig', () => {
    it('should return true when OPENAI_API_KEY is set', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      const { OpenAIProvider } = await import('./provider.js');
      const provider = new OpenAIProvider();
      expect(provider.validateConfig()).toBe(true);
    });

    it('should return false when OPENAI_API_KEY is not set', async () => {
      delete process.env.OPENAI_API_KEY;
      const { OpenAIProvider } = await import('./provider.js');
      const provider = new OpenAIProvider();
      expect(provider.validateConfig()).toBe(false);
    });
  });

  describe('getInfo', () => {
    it('should return provider info with available=true when configured', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      const { OpenAIProvider } = await import('./provider.js');
      const provider = new OpenAIProvider();
      const info = provider.getInfo();
      expect(info.name).toBe('openai');
      expect(info.version).toBe('0.1.0');
      expect(info.available).toBe(true);
      expect(info.unavailableReason).toBeUndefined();
    });

    it('should return provider info with available=false when not configured', async () => {
      delete process.env.OPENAI_API_KEY;
      const { OpenAIProvider } = await import('./provider.js');
      const provider = new OpenAIProvider();
      const info = provider.getInfo();
      expect(info.name).toBe('openai');
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toBe('OPENAI_API_KEY not set');
    });
  });

  describe('dispose', () => {
    it('should set disposed flag', async () => {
      const { OpenAIProvider } = await import('./provider.js');
      const provider = new OpenAIProvider();
      provider.dispose();

      // queryOnce returns an AsyncGenerator, need to consume it to trigger the error
      try {
        const gen = provider.queryOnce('test', { settingSources: ['test'] });
        await gen.next();
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain('Provider has been disposed');
      }
    });
  });

  describe('createMcpServer', () => {
    it('should create MCPServerStdio with command and args', async () => {
      const { OpenAIProvider } = await import('./provider.js');
      const provider = new OpenAIProvider();
      const server = provider.createMcpServer({
        type: 'stdio',
        name: 'test-server',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      });
      expect(server).toBeDefined();
      expect(server.constructor.name).toBe('MCPServerStdio');
    });

    it('should create MCPServerStdio with command only', async () => {
      const { OpenAIProvider } = await import('./provider.js');
      const provider = new OpenAIProvider();
      const server = provider.createMcpServer({
        type: 'stdio',
        name: 'test-server',
        command: 'npx -y @modelcontextprotocol/server-filesystem /tmp',
      });
      expect(server).toBeDefined();
      expect(server.constructor.name).toBe('MCPServerStdio');
    });

    it('should throw for inline MCP server config', async () => {
      const { OpenAIProvider } = await import('./provider.js');
      const provider = new OpenAIProvider();
      expect(() => provider.createMcpServer({
        type: 'inline',
        name: 'test-server',
        version: '1.0.0',
        tools: [],
      })).toThrow('Inline MCP servers are not supported');
    });

    it('should pass env to MCPServerStdio', async () => {
      const { OpenAIProvider } = await import('./provider.js');
      const provider = new OpenAIProvider();
      const server = provider.createMcpServer({
        type: 'stdio',
        name: 'test-server',
        command: 'npx',
        args: ['test'],
        env: { TEST_VAR: 'test_value' },
      });
      expect(server).toBeDefined();
    });
  });

  describe('createInlineTool', () => {
    it('should create a tool from definition', async () => {
      const { OpenAIProvider } = await import('./provider.js');
      const { z } = await import('zod');

      const provider = new OpenAIProvider();
      const toolDef = {
        name: 'test_tool',
        description: 'A test tool',
        parameters: z.object({ input: z.string() }),
        handler: async (params: { input: string }) => params.input,
      };

      const result = provider.createInlineTool(toolDef);
      expect(result).toBeDefined();
    });
  });
});
