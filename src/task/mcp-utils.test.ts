/**
 * Tests for MCP utility functions.
 */

import { describe, it, expect } from 'vitest';
import { parseBaseToolName, isUserFeedbackTool } from './mcp-utils.js';
import type { AgentMessage } from '../types/agent.js';

describe('parseBaseToolName', () => {
  it('should extract base name from prefixed tool name', () => {
    expect(parseBaseToolName('context-mcp__send_message')).toBe('send_message');
  });

  it('should return original name when no prefix', () => {
    expect(parseBaseToolName('send_message')).toBe('send_message');
  });

  it('should handle empty string', () => {
    expect(parseBaseToolName('')).toBe('');
  });

  it('should handle multiple separators', () => {
    expect(parseBaseToolName('a__b__c__tool_name')).toBe('tool_name');
  });
});

describe('isUserFeedbackTool', () => {
  const createMessage = (toolName?: string): AgentMessage => ({
    content: '',
    role: 'assistant',
    messageType: 'tool_use',
    metadata: { toolName, toolInputRaw: {} },
  });

  it('should return true for send_message tool', () => {
    expect(isUserFeedbackTool(createMessage('send_message'))).toBe(true);
    expect(isUserFeedbackTool(createMessage('mcp__send_message'))).toBe(true);
  });

  it('should return false for other tools', () => {
    expect(isUserFeedbackTool(createMessage('Read'))).toBe(false);
  });

  it('should return false for non-tool_use messages', () => {
    expect(isUserFeedbackTool({
      content: 'text',
      role: 'assistant',
      messageType: 'text',
    })).toBe(false);
  });
});
