/**
 * Tests for SDK utilities (src/utils/sdk.ts)
 *
 * Tests the following functionality:
 * - Message parsing from SDK format
 * - Text extraction from various message types
 * - SDK options creation with proper environment setup
 * - Edit tool formatting (ANSI, Markdown, Git diff)
 * - Environment variable building
 */

import { describe, it, expect } from 'vitest';
import {
  getNodeBinDir,
  createAgentSdkOptions,
  extractTextFromSDKMessage,
  parseSDKMessage,
  formatEditToolUseMarkdown,
  buildSdkEnv,
  extractText,
} from './sdk.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentMessage } from '../types/agent.js';

describe('getNodeBinDir', () => {
  it('should return directory containing node executable', () => {
    const result = getNodeBinDir();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('/');
  });

  it('should be a valid path', () => {
    const result = getNodeBinDir();
    // Just check it's a valid path format
    expect(result).toMatch(/^\/.+/);
  });
});

describe('createAgentSdkOptions', () => {
  const mockApiKey = 'test-api-key';
  const mockModel = 'claude-3-5-sonnet-20241022';

  it('should create basic SDK options', () => {
    const result = createAgentSdkOptions({
      apiKey: mockApiKey,
      model: mockModel,
    });

    expect(result).toHaveProperty('cwd');
    expect(result).toHaveProperty('permissionMode', 'bypassPermissions');
    expect(result).toHaveProperty('env');
    expect(result).toHaveProperty('allowedTools');
    expect(result).toHaveProperty('mcpServers');
  });

  it('should set environment variables correctly', () => {
    const result = createAgentSdkOptions({
      apiKey: mockApiKey,
      model: mockModel,
    });

    expect(result.env).toHaveProperty('ANTHROPIC_API_KEY', mockApiKey);
    expect(result.env).toHaveProperty('PATH');
    expect((result.env as any).PATH).toContain(getNodeBinDir());
  });

  it('should handle custom API base URL', () => {
    const customBaseUrl = 'https://custom.api.example.com';
    const result = createAgentSdkOptions({
      apiKey: mockApiKey,
      model: mockModel,
      apiBaseUrl: customBaseUrl,
    });

    expect(result.env).toHaveProperty('ANTHROPIC_BASE_URL', customBaseUrl);
  });

  it('should handle custom working directory', () => {
    const customCwd = '/custom/workspace';
    const result = createAgentSdkOptions({
      apiKey: mockApiKey,
      model: mockModel,
      cwd: customCwd,
    });

    expect(result.cwd).toBe(customCwd);
  });

  it('should handle default permission mode', () => {
    const result = createAgentSdkOptions({
      apiKey: mockApiKey,
      model: mockModel,
      permissionMode: 'default',
    });

    expect(result.permissionMode).toBe('default');
  });

  it('should include allowed tools', () => {
    const result = createAgentSdkOptions({
      apiKey: mockApiKey,
      model: mockModel,
    });

    expect(Array.isArray((result as Record<string, unknown>).allowedTools)).toBe(true);
    expect(((result as Record<string, unknown>).allowedTools as unknown[]).length).toBeGreaterThan(0);
  });

  it('should configure Playwright MCP server', () => {
    const result = createAgentSdkOptions({
      apiKey: mockApiKey,
      model: mockModel,
    });

    expect((result as Record<string, unknown>).mcpServers).toHaveProperty('playwright');
    expect(((result as Record<string, unknown>).mcpServers as Record<string, unknown>).playwright).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
    });
  });
});

describe('extractTextFromSDKMessage', () => {
  it('should extract text from assistant message with text content', () => {
    const message: SDKMessage = {
      type: 'assistant',
      message: {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        content: [
          {
            type: 'text',
            text: 'Hello, world!',
          },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000000' as const,
      session_id: null,
    } as unknown as SDKMessage;

    const result = extractTextFromSDKMessage(message);
    expect(result).toBe('Hello, world!');
  });

  it('should return empty string for message without text', () => {
    const message: SDKMessage = {
      type: 'assistant',
      message: {
        id: 'msg-2',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000000' as const,
      session_id: null,
    } as unknown as SDKMessage;

    const result = extractTextFromSDKMessage(message);
    expect(result).toBe('');
  });

  it('should handle tool_use messages', () => {
    const message: SDKMessage = {
      type: 'assistant',
      message: {
        id: 'msg-3',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            id: 'tool-123',
            input: {
              command: 'echo "test"',
            },
          },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000000' as const,
      session_id: null,
    } as unknown as SDKMessage;

    const result = extractTextFromSDKMessage(message);
    // The formatToolInput function formats this as "Running: command"
    expect(result).toContain('echo "test"');
  });
});

describe('parseSDKMessage', () => {
  it('should parse text message', () => {
    const message: SDKMessage = {
      type: 'assistant',
      message: {
        id: 'msg-4',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        content: [
          {
            type: 'text',
            text: 'Sample text',
          },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000000' as const,
      session_id: null,
    } as unknown as SDKMessage;

    const result = parseSDKMessage(message);
    expect(result.type).toBe('text');
    expect(result.content).toBe('Sample text');
  });

  it('should parse tool_use message', () => {
    const message: SDKMessage = {
      type: 'assistant',
      message: {
        id: 'msg-5',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            id: 'tool-1',
            input: {
              file_path: '/path/to/file.txt',
            },
          },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000000' as const,
      session_id: null,
    } as unknown as SDKMessage;

    const result = parseSDKMessage(message);
    expect(result.type).toBe('tool_use');
    expect(result.content).toContain('Read');
    expect(result.metadata).toHaveProperty('toolName', 'Read');
    expect(result.metadata).toHaveProperty('toolInputRaw');
  });

  it('should parse tool_progress message', () => {
    const message: SDKMessage = {
      type: 'tool_progress',
      tool_name: 'Bash',
      tool_use_id: 'tool-123',
      parent_tool_use_id: 'parent-123',
      elapsed_time_seconds: 2.5,
      uuid: '00000000-0000-0000-0000-000000000001' as const,
      session_id: 'session-1',
    } as SDKMessage;

    const result = parseSDKMessage(message);
    expect(result.type).toBe('tool_progress');
    expect(result.content).toContain('Bash');
    expect(result.content).toContain('2.5');
    expect(result.metadata).toHaveProperty('toolName', 'Bash');
    expect(result.metadata).toHaveProperty('elapsed', 2.5);
  });

  it('should parse tool_use_summary message', () => {
    const message: SDKMessage = {
      type: 'tool_use_summary',
      summary: 'Command completed successfully',
      preceding_tool_use_ids: ['tool-123'],
      uuid: '00000000-0000-0000-0000-000000000002' as const,
      session_id: 'session-2',
    } as SDKMessage;

    const result = parseSDKMessage(message);
    expect(result.type).toBe('tool_result');
    expect(result.content).toContain('Command completed successfully');
  });

  it('should parse result success message', () => {
    const message: SDKMessage = {
      type: 'result',
      subtype: 'success',
      duration_ms: 1000,
      duration_api_ms: 800,
      is_error: false,
      num_turns: 5,
      total_cost_usd: 0.001,
      result: 'success',
      uuid: '00000000-0000-0000-0000-000000000005' as const,
      session_id: 'session-result-1',
      usage: {
        input_tokens: 500,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
    } as SDKMessage;

    const result = parseSDKMessage(message);
    expect(result.type).toBe('result');
    expect(result.content).toContain('Complete');
  });

  it('should parse result error message', () => {
    const message: SDKMessage = {
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 1000,
      duration_api_ms: 800,
      is_error: true,
      num_turns: 5,
      total_cost_usd: 0.001,
      uuid: '00000000-0000-0000-0000-000000000006' as const,
      session_id: 'session-result-2',
      usage: {
        input_tokens: 500,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      errors: ['File not found', 'Permission denied'],
    } as SDKMessage;

    const result = parseSDKMessage(message);
    expect(result.type).toBe('error');
    expect(result.content).toContain('File not found');
    expect(result.content).toContain('Permission denied');
  });

  it('should parse system status compacting message', () => {
    const message: SDKMessage = {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      uuid: '00000000-0000-0000-0000-000000000003' as const,
      session_id: 'session-3',
    } as SDKMessage;

    const result = parseSDKMessage(message);
    expect(result.type).toBe('status');
    expect(result.content).toContain('Compacting');
  });

  it('should parse system hook_started message', () => {
    const message = {
      type: 'system',
      subtype: 'hook_started',
      hook: 'pre-check',
      event: 'message',
    } as unknown as SDKMessage; // Type assertion because SDK types may not include these properties

    const result = parseSDKMessage(message);
    expect(result.type).toBe('notification');
    expect(result.content).toContain('Hook');
    expect(result.metadata).toHaveProperty('status', 'pre-check');
  });

  it('should parse system task_notification message', () => {
    const message: SDKMessage = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-123',
      status: 'completed',
      output_file: '/output/file.txt',
      summary: 'Task completed',
      uuid: '00000000-0000-0000-0000-000000000004' as const,
      session_id: 'session-4',
    } as SDKMessage;

    const result = parseSDKMessage(message);
    expect(result.type).toBe('notification');
    expect(result.content).toContain('task-123');
    expect(result.content).toContain('completed');
  });

  it('should extract session_id when present', () => {
    const message: SDKMessage = {
      type: 'assistant',
      session_id: 'session-abc-123',
      message: {
        id: 'msg-6',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        content: [
          {
            type: 'text',
            text: 'Text',
          },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000000' as const,
    } as unknown as SDKMessage;

    const result = parseSDKMessage(message);
    expect(result.sessionId).toBe('session-abc-123');
  });

  it('should return empty text for ignored message types', () => {
    const userMessage: SDKMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Should be ignored',
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000000' as const,
      session_id: null,
    } as unknown as SDKMessage; // Type assertion for user message

    const result = parseSDKMessage(userMessage);
    expect(result.type).toBe('text');
    expect(result.content).toBe('');
  });
});

describe('formatEditToolUseMarkdown', () => {
  it('should format Edit tool with file path', () => {
    const input = {
      file_path: '/path/to/file.ts',
      old_string: 'old content',
      new_string: 'new content',
    };

    const result = formatEditToolUseMarkdown(input);
    expect(result).toContain('**📝 Editing:**');
    expect(result).toContain('/path/to/file.ts');
    expect(result).toContain('**Before:**');
    expect(result).toContain('**After:**');
    expect(result).toContain('```');
  });

  it('should handle snake_case parameters', () => {
    const input = {
      file_path: '/test/file.js',
      old_string: 'before',
      new_string: 'after',
    };

    const result = formatEditToolUseMarkdown(input);
    expect(result).toContain('/test/file.js');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('should handle camelCase parameters', () => {
    const input = {
      filePath: '/test/file.js',
      oldString: 'before',
      newString: 'after',
    };

    const result = formatEditToolUseMarkdown(input);
    expect(result).toContain('/test/file.js');
  });

  it('should handle missing file path', () => {
    const input = {
      old_string: 'before',
      new_string: 'after',
    };

    const result = formatEditToolUseMarkdown(input);
    expect(result).toContain('Editing:');
    expect(result).toContain('unknown');
  });

  it('should truncate long content', () => {
    const longContent = 'a'.repeat(200);
    const input = {
      file_path: '/test/file.js',
      old_string: longContent,
      new_string: longContent,
    };

    const result = formatEditToolUseMarkdown(input);
    expect(result).toContain('...');
  });
});

describe('buildSdkEnv', () => {
  it('should build environment with API key and PATH', () => {
    const result = buildSdkEnv('test-key');

    expect(result).toHaveProperty('ANTHROPIC_API_KEY');
    expect(result).toHaveProperty('PATH');
    expect(result.PATH).toContain(getNodeBinDir());
  });

  it('should include custom base URL', () => {
    const customUrl = 'https://api.example.com';
    const result = buildSdkEnv('test-key', customUrl);

    expect(result).toHaveProperty('ANTHROPIC_BASE_URL', customUrl);
  });

  it('should merge extra environment variables', () => {
    const result = buildSdkEnv('test-key', undefined, {
      CUSTOM_VAR: 'custom-value',
      ANOTHER_VAR: 'another-value',
    });

    expect(result).toHaveProperty('CUSTOM_VAR', 'custom-value');
    expect(result).toHaveProperty('ANOTHER_VAR', 'another-value');
  });

  it('should not override process.env variables', () => {
    const originalHome = process.env.HOME;
    const result = buildSdkEnv('test-key', undefined, {
      HOME: '/different/home',
    });

    // process.env should take precedence
    expect(result.HOME).toBe(originalHome);
  });
});

describe('extractText', () => {
  it('should extract text from string content', () => {
    const message: AgentMessage = {
      role: 'assistant',
      content: 'Plain text content',
    };

    const result = extractText(message);
    expect(result).toBe('Plain text content');
  });

  it('should extract text from array content with text blocks', () => {
    const message: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'First part' },
        { type: 'text', text: ' Second part' },
      ],
    };

    const result = extractText(message);
    expect(result).toBe('First part Second part');
  });

  it('should filter out non-text blocks', () => {
    const message: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Text content' },
        { type: 'image', source: {} },
        { type: 'text', text: ' More text' },
      ],
    };

    const result = extractText(message);
    expect(result).toBe('Text content More text');
  });

  it('should return empty string for empty array', () => {
    const message: AgentMessage = {
      role: 'assistant',
      content: [],
    };

    const result = extractText(message);
    expect(result).toBe('');
  });

  it('should return empty string for content without text blocks', () => {
    const message: AgentMessage = {
      role: 'assistant',
      content: [
        { type: 'image', source: {} },
        { type: 'tool_use', name: 'Bash' },
      ],
    };

    const result = extractText(message);
    expect(result).toBe('');
  });
});
