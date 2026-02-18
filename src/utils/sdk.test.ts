/**
 * Tests for SDK utilities (src/utils/sdk.ts)
 *
 * Tests the following functionality:
 * - Message parsing from SDK format
 * - Text extraction from various message types
 * - Edit tool formatting (ANSI, Markdown, Git diff)
 * - Environment variable building
 */

import { describe, it, expect } from 'vitest';
import {
  getNodeBinDir,
  parseSDKMessage,
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
