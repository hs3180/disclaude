/**
 * Tests for Claude SDK Message Adapter (packages/core/src/sdk/providers/claude/message-adapter.ts)
 *
 * Validates SDK message adaptation, tool input formatting, and user input conversion.
 */

import { describe, it, expect } from 'vitest';
import { adaptSDKMessage, adaptUserInput, parseXmlToolUse } from './message-adapter.js';

// Test helper: SDK message types require fields (parent_tool_use_id, uuid, etc.)
// that are optional in practice. Cast test fixtures to bypass strict type checking.
const asMsg = (m: object) => m as any;

describe('adaptSDKMessage', () => {
  describe('assistant messages', () => {
    it('should handle text-only content', () => {
      const message = {
        type: 'assistant' as const,
        session_id: 'session-123',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello, world!' },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('Hello, world!');
      expect(result.role).toBe('assistant');
      expect(result.metadata?.sessionId).toBe('session-123');
    });

    it('should handle tool_use content', () => {
      const message = {
        type: 'assistant' as const,
        session_id: 'session-456',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
            { type: 'text', text: 'Listing files' },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('tool_use');
      expect(result.content).toContain('Running: ls -la');
      expect(result.content).toContain('Listing files');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.toolInput).toEqual({ command: 'ls -la' });
    });

    it('should handle Edit tool with file_path', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Editing: /src/app.ts');
      expect(result.metadata?.toolName).toBe('Edit');
    });

    it('should handle Read tool', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Reading: /src/app.ts');
    });

    it('should handle Write tool', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/src/new.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Writing: /src/new.ts');
    });

    it('should handle Grep tool with pattern', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Searching for "TODO"');
    });

    it('should handle Glob tool with pattern', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Finding files: **/*.ts');
    });

    it('should handle unknown tool with input', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'CustomTool', input: { key: 'value' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('CustomTool');
      expect(result.content).toContain('key');
    });

    it('should handle tool_use without input', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: undefined },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Bash');
    });

    it('should handle empty content array', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle null/invalid message content', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: 'not an array',
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should extract session_id when present', () => {
      const message = {
        type: 'assistant' as const,
        session_id: 'sess-abc',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.metadata?.sessionId).toBe('sess-abc');
    });
  });

  describe('tool_progress messages', () => {
    it('should format tool progress with elapsed time', () => {
      const message = {
        type: 'tool_progress' as const,
        tool_name: 'Bash',
        elapsed_time_seconds: 5.3,
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('tool_progress');
      expect(result.content).toContain('Running Bash');
      expect(result.content).toContain('5.3s');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.elapsedMs).toBe(5300);
    });

    it('should handle tool_progress without required fields', () => {
      const message = {
        type: 'tool_progress' as const,
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('tool_use_summary messages', () => {
    it('should format tool summary', () => {
      const message = {
        type: 'tool_use_summary' as const,
        summary: 'Files modified successfully',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('tool_result');
      expect(result.content).toContain('Files modified successfully');
    });

    it('should handle tool_use_summary without summary', () => {
      const message = {
        type: 'tool_use_summary' as const,
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('result messages', () => {
    it('should format success result with cost', () => {
      const message = {
        type: 'result' as const,
        subtype: 'success',
        usage: {
          total_cost: 0.0523,
          total_tokens: 15000,
          input_tokens: 10000,
          output_tokens: 5000,
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('result');
      expect(result.content).toContain('Complete');
      expect(result.content).toContain('$0.0523');
      expect(result.content).toContain('15.0k');
      expect(result.metadata?.costUsd).toBe(0.0523);
      expect(result.metadata?.inputTokens).toBe(10000);
      expect(result.metadata?.outputTokens).toBe(5000);
    });

    it('should format success result without usage', () => {
      const message = {
        type: 'result' as const,
        subtype: 'success',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('result');
      expect(result.content).toBe('✅ Complete');
    });

    it('should format error result', () => {
      const message = {
        type: 'result' as const,
        subtype: 'error_during_execution',
        errors: ['API rate limit exceeded', 'Timeout'],
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('error');
      expect(result.content).toContain('API rate limit exceeded');
      expect(result.content).toContain('Timeout');
    });

    it('should handle result with unknown subtype', () => {
      const message = {
        type: 'result' as const,
        subtype: 'unknown',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('system messages', () => {
    it('should format compacting status', () => {
      const message = {
        type: 'system' as const,
        subtype: 'status',
        status: 'compacting',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('status');
      expect(result.content).toContain('Compacting');
      expect(result.role).toBe('system');
    });

    it('should ignore non-status system messages', () => {
      const message = {
        type: 'system' as const,
        subtype: 'other',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('user and stream_event messages', () => {
    it('should return empty text for user messages', () => {
      const message = {
        type: 'user' as const,
        message: { role: 'user', content: 'hello' },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
      expect(result.role).toBe('user');
    });

    it('should return empty text for stream_event messages', () => {
      const message = {
        type: 'stream_event' as const,
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should return empty text for unknown message types', () => {
      const message = {
        type: 'unknown_type' as const,
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });
});

describe('adaptUserInput', () => {
  it('should convert UserInput to SDKUserMessage', () => {
    const input = {
      role: 'user' as const,
      content: 'Hello, Claude!',
    };

    const result = adaptUserInput(input);
    expect(result.type).toBe('user');
    expect(result.message.role).toBe('user');
    expect(result.message.content).toBe('Hello, Claude!');
    expect(result.parent_tool_use_id).toBeNull();
    expect(result.session_id).toBe('');
  });

  it('should handle content array', () => {
    const input = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'Hello' }],
    };

    const result = adaptUserInput(input);
    expect(result.type).toBe('user');
    expect(result.message.content).toBeDefined();
  });
});

// ============================================================================
// XML tool_use parsing tests — third-party endpoint compatibility (Issue #2943)
// ============================================================================

describe('parseXmlToolUse', () => {
  it('should return null for empty or non-XML text', () => {
    expect(parseXmlToolUse('')).toBeNull();
    expect(parseXmlToolUse('Hello, world!')).toBeNull();
    expect(parseXmlToolUse('No tools here')).toBeNull();
  });

  it('should return null for malformed XML without proper closing tag', () => {
    expect(parseXmlToolUse('<tool_use><name>Bash</name>')).toBeNull();
  });

  it('should return null for tool_use without name', () => {
    expect(parseXmlToolUse('<tool_use><input>{"a":1}</input></tool_use>')).toBeNull();
  });

  it('should parse <tool_name> format (SDK system prompt style)', () => {
    const xml = '<tool_use>\n  <tool_name>Bash</tool_name>\n  <tool_input>{"command": "ls -la"}</tool_input>\n</tool_use>';

    const result = parseXmlToolUse(xml);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Bash');
    expect(result!.input).toEqual({ command: 'ls -la' });
  });

  it('should parse <name> format (function calling style)', () => {
    const xml = '<tool_use>\n  <name>Read</name>\n  <input>{"file_path": "/src/app.ts"}</input>\n</tool_use>';

    const result = parseXmlToolUse(xml);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Read');
    expect(result!.input).toEqual({ file_path: '/src/app.ts' });
  });

  it('should parse <tool_use> with id attribute', () => {
    const xml = '<tool_use id="toolu_01ABC">\n  <name>Edit</name>\n  <input>{"file_path": "/src/app.ts", "old_string": "foo", "new_string": "bar"}</input>\n</tool_use>';

    const result = parseXmlToolUse(xml);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Edit');
    expect(result!.input).toEqual({ file_path: '/src/app.ts', old_string: 'foo', new_string: 'bar' });
  });

  it('should extract remaining text after the tool_use block', () => {
    const xml = '<tool_use>\n  <name>Bash</name>\n  <input>{"command": "npm test"}</input>\n</tool_use>\n\nRunning the test suite now.';

    const result = parseXmlToolUse(xml);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Bash');
    expect(result!.remainingText).toContain('Running the test suite now');
  });

  it('should handle non-JSON input with key=value fallback', () => {
    const xml = '<tool_use>\n  <name>Bash</name>\n  <input>command=ls -la</input>\n</tool_use>';

    const result = parseXmlToolUse(xml);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Bash');
    expect(result!.input).toEqual({ command: 'ls -la' });
  });

  it('should handle empty input', () => {
    const xml = '<tool_use>\n  <name>Bash</name>\n  <input></input>\n</tool_use>';

    const result = parseXmlToolUse(xml);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Bash');
    // Empty input → raw fallback with empty string
    expect(result!.input).toBeDefined();
  });

  it('should handle missing input tags', () => {
    const xml = '<tool_use>\n  <name>Bash</name>\n</tool_use>';

    const result = parseXmlToolUse(xml);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Bash');
    expect(result!.input).toEqual({});
  });
});

describe('adaptSDKMessage - XML tool_use fallback', () => {
  it('should detect XML tool_use in text content when no structured tool_use exists', () => {
    const message = {
      type: 'assistant' as const,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '<tool_use>\n  <name>Bash</name>\n  <input>{"command": "ls -la"}</input>\n</tool_use>' },
        ],
      },
    };

    const result = adaptSDKMessage(asMsg(message));
    expect(result.type).toBe('tool_use');
    expect(result.metadata?.toolName).toBe('Bash');
    expect(result.metadata?.toolInput).toEqual({ command: 'ls -la' });
    expect(result.content).toContain('Running: ls -la');
  });

  it('should prefer structured tool_use over XML fallback', () => {
    const message = {
      type: 'assistant' as const,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/real.ts' } },
          { type: 'text', text: '<tool_use><name>Bash</name><input>{"command":"fake"}</input></tool_use>' },
        ],
      },
    };

    const result = adaptSDKMessage(asMsg(message));
    expect(result.type).toBe('tool_use');
    // Structured tool_use takes priority
    expect(result.metadata?.toolName).toBe('Read');
    expect(result.metadata?.toolInput).toEqual({ file_path: '/real.ts' });
  });

  it('should return text type when content has no tool_use of any form', () => {
    const message = {
      type: 'assistant' as const,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I can help with that. Let me explain...' },
        ],
      },
    };

    const result = adaptSDKMessage(asMsg(message));
    expect(result.type).toBe('text');
    expect(result.metadata?.toolName).toBeUndefined();
  });

  it('should handle XML tool_use with remaining text', () => {
    const message = {
      type: 'assistant' as const,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '<tool_use>\n  <name>Grep</name>\n  <input>{"pattern": "TODO"}</input>\n</tool_use>\n\nSearching for TODO items in the codebase.' },
        ],
      },
    };

    const result = adaptSDKMessage(asMsg(message));
    expect(result.type).toBe('tool_use');
    expect(result.metadata?.toolName).toBe('Grep');
    expect(result.content).toContain('Searching for "TODO"');
    expect(result.content).toContain('Searching for TODO items');
  });
});
