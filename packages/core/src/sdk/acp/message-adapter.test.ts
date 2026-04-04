/**
 * ACP 消息适配器测试
 *
 * 验证 ACP 协议消息和统一 AgentMessage 类型之间的双向转换。
 *
 * Issue #1333: 支持OpenAI Agent - PR A (ACP 协议基础设施)
 */

import { describe, it, expect } from 'vitest';
import {
  userInputToAcpMessage,
  acpMessageToAgentMessages,
} from './message-adapter.js';
import type {
  AcpTaskMessage,
} from './types.js';

// ============================================================================
// userInputToAcpMessage
// ============================================================================

describe('userInputToAcpMessage', () => {
  it('should convert string content to ACP text message', () => {
    const result = userInputToAcpMessage({
      role: 'user',
      content: 'Hello world',
    });

    expect(result.role).toBe('user');
    expect(result.content).toEqual({ type: 'text', text: 'Hello world' });
  });

  it('should convert text content blocks to ACP content', () => {
    const result = userInputToAcpMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ],
    });

    expect(result.role).toBe('user');
    expect(result.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ]);
  });

  it('should convert image content blocks to ACP content', () => {
    const result = userInputToAcpMessage({
      role: 'user',
      content: [
        { type: 'image', data: 'base64data', mimeType: 'image/png' },
      ],
    });

    expect(result.content).toEqual([
      { type: 'image', data: 'base64data', mimeType: 'image/png' },
    ]);
  });

  it('should convert mixed content blocks', () => {
    const result = userInputToAcpMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this:' },
        { type: 'image', data: 'abc', mimeType: 'image/jpeg' },
      ],
    });

    expect(result.content).toEqual([
      { type: 'text', text: 'Look at this:' },
      { type: 'image', data: 'abc', mimeType: 'image/jpeg' },
    ]);
  });
});

// ============================================================================
// acpMessageToAgentMessages
// ============================================================================

describe('acpMessageToAgentMessages', () => {
  it('should convert single text block to AgentMessage', () => {
    const acpMessage: AcpTaskMessage = {
      role: 'assistant',
      content: { type: 'text', text: 'Hello from agent' },
    };

    const result = acpMessageToAgentMessages(acpMessage);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'text',
      content: 'Hello from agent',
      role: 'assistant',
    });
  });

  it('should merge multiple text blocks into one AgentMessage', () => {
    const acpMessage: AcpTaskMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'First paragraph.' },
        { type: 'text', text: 'Second paragraph.' },
        { type: 'text', text: 'Third paragraph.' },
      ],
    };

    const result = acpMessageToAgentMessages(acpMessage);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(
      'First paragraph.\nSecond paragraph.\nThird paragraph.',
    );
  });

  it('should convert tool_use block to AgentMessage with metadata', () => {
    const acpMessage: AcpTaskMessage = {
      role: 'assistant',
      content: {
        type: 'tool_use',
        id: 'tool-123',
        name: 'Bash',
        input: { command: 'ls -la' },
      },
    };

    const result = acpMessageToAgentMessages(acpMessage);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_use');
    expect(result[0].content).toContain('Bash');
    expect(result[0].metadata).toEqual({
      toolName: 'Bash',
      toolInput: { command: 'ls -la' },
      messageId: 'tool-123',
    });
  });

  it('should keep tool_use and text blocks separate', () => {
    const acpMessage: AcpTaskMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check the files.' },
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Read',
          input: { file_path: '/tmp/test.txt' },
        },
      ],
    };

    const result = acpMessageToAgentMessages(acpMessage);

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('text');
    expect(result[0].content).toBe('Let me check the files.');
    expect(result[1].type).toBe('tool_use');
    expect(result[1].metadata?.toolName).toBe('Read');
  });

  it('should convert tool_result block to AgentMessage', () => {
    const acpMessage: AcpTaskMessage = {
      role: 'assistant',
      content: {
        type: 'tool_result',
        toolUseId: 'tool-123',
        content: 'File contents here',
      },
    };

    const result = acpMessageToAgentMessages(acpMessage);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_result');
    expect(result[0].content).toContain('File contents here');
    expect(result[0].metadata?.toolOutput).toBe('File contents here');
    expect(result[0].metadata?.messageId).toBe('tool-123');
  });

  it('should handle error tool_result', () => {
    const acpMessage: AcpTaskMessage = {
      role: 'assistant',
      content: {
        type: 'tool_result',
        toolUseId: 'tool-456',
        content: 'Permission denied',
        isError: true,
      },
    };

    const result = acpMessageToAgentMessages(acpMessage);

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('Permission denied');
  });

  it('should convert image block to text AgentMessage', () => {
    const acpMessage: AcpTaskMessage = {
      role: 'assistant',
      content: {
        type: 'image',
        data: 'base64imagedata',
        mimeType: 'image/png',
      },
    };

    const result = acpMessageToAgentMessages(acpMessage);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
    expect(result[0].content).toContain('image/png');
  });

  it('should return empty content message for empty content array', () => {
    const acpMessage: AcpTaskMessage = {
      role: 'assistant',
      content: [],
    };

    const result = acpMessageToAgentMessages(acpMessage);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('');
  });

  it('should skip empty text blocks', () => {
    const acpMessage: AcpTaskMessage = {
      role: 'assistant',
      content: { type: 'text', text: '' },
    };

    const result = acpMessageToAgentMessages(acpMessage);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('');
  });

  it('should preserve role from ACP message', () => {
    const userMessage: AcpTaskMessage = {
      role: 'user',
      content: { type: 'text', text: 'User text' },
    };

    const systemMessage: AcpTaskMessage = {
      role: 'system',
      content: { type: 'text', text: 'System text' },
    };

    expect(acpMessageToAgentMessages(userMessage)[0].role).toBe('user');
    expect(acpMessageToAgentMessages(systemMessage)[0].role).toBe('system');
  });

  it('should handle mixed content with tool_use and tool_result', () => {
    const acpMessage: AcpTaskMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Running tool...' },
        { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'test' } },
        { type: 'tool_result', toolUseId: 't1', content: 'Found 3 matches' },
        { type: 'text', text: 'Done.' },
      ],
    };

    const result = acpMessageToAgentMessages(acpMessage);

    // tool_use present → no merging, but text blocks without tool are still separate
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.some((m) => m.type === 'tool_use')).toBe(true);
    expect(result.some((m) => m.type === 'tool_result')).toBe(true);
  });
});
