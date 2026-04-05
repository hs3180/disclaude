/**
 * Tests for ACP protocol types and utility functions.
 *
 * Verifies type construction, message creation, and content extraction.
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { describe, it, expect } from 'vitest';
import {
  createTextPart,
  createJsonPart,
  createUserMessage,
  extractTextContent,
  type AcpMessage,
  type AcpAgentManifest,
  type AcpRun,
  type AcpCreateRunRequest,
  type AcpSseEvent,
} from './types.js';

describe('createTextPart', () => {
  it('should create a text/plain part', () => {
    const part = createTextPart('Hello, world!');

    expect(part.content_type).toBe('text/plain');
    expect(part.content).toBe('Hello, world!');
  });

  it('should handle empty string', () => {
    const part = createTextPart('');
    expect(part.content).toBe('');
  });

  it('should handle multi-line text', () => {
    const part = createTextPart('line1\nline2\nline3');
    expect(part.content).toBe('line1\nline2\nline3');
  });
});

describe('createJsonPart', () => {
  it('should create an application/json part', () => {
    const part = createJsonPart({ key: 'value' });

    expect(part.content_type).toBe('application/json');
    expect(part.content).toBe('{"key":"value"}');
  });

  it('should serialize arrays', () => {
    const part = createJsonPart([1, 2, 3]);
    expect(part.content).toBe('[1,2,3]');
  });

  it('should serialize nested objects', () => {
    const part = createJsonPart({ nested: { a: 1, b: true } });
    expect(part.content).toBe('{"nested":{"a":1,"b":true}}');
  });
});

describe('createUserMessage', () => {
  it('should create a user message with text part', () => {
    const message = createUserMessage('Hello!');

    expect(message.role).toBe('user');
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0].content_type).toBe('text/plain');
    expect(message.parts[0].content).toBe('Hello!');
  });
});

describe('extractTextContent', () => {
  it('should extract text from text/plain parts', () => {
    const message: AcpMessage = {
      role: 'agent',
      parts: [
        { content_type: 'text/plain', content: 'First' },
        { content_type: 'text/plain', content: 'Second' },
      ],
    };

    expect(extractTextContent(message)).toBe('First\nSecond');
  });

  it('should skip non-text parts', () => {
    const message: AcpMessage = {
      role: 'agent',
      parts: [
        { content_type: 'text/plain', content: 'Text content' },
        { content_type: 'application/json', content: '{"ignored": true}' },
        { content_type: 'image/png', content_url: 'https://example.com/img.png' },
      ],
    };

    expect(extractTextContent(message)).toBe('Text content');
  });

  it('should handle empty parts', () => {
    const message: AcpMessage = {
      role: 'user',
      parts: [],
    };

    expect(extractTextContent(message)).toBe('');
  });

  it('should skip text parts without content', () => {
    const message: AcpMessage = {
      role: 'agent',
      parts: [
        { content_type: 'text/plain' },
        { content_type: 'text/plain', content: 'Has content' },
      ],
    };

    expect(extractTextContent(message)).toBe('Has content');
  });
});

describe('ACP type structures', () => {
  it('should represent a valid AgentManifest', () => {
    const manifest: AcpAgentManifest = {
      name: 'test-agent',
      description: 'A test agent',
      input_content_types: ['text/plain', '*/*'],
      output_content_types: ['text/plain', 'application/json'],
      metadata: {
        capabilities: [{ name: 'chat', description: 'Conversational AI' }],
        tags: ['test'],
      },
    };

    expect(manifest.name).toBe('test-agent');
    expect(manifest.input_content_types).toContain('text/plain');
    expect(manifest.metadata?.capabilities).toHaveLength(1);
  });

  it('should represent a valid Run', () => {
    const run: AcpRun = {
      run_id: 'run-123',
      agent_name: 'test-agent',
      session_id: 'session-456',
      status: 'completed',
      mode: 'sync',
      output: [
        {
          role: 'agent',
          parts: [{ content_type: 'text/plain', content: 'Response' }],
        },
      ],
      created_at: '2026-04-06T00:00:00Z',
      finished_at: '2026-04-06T00:00:05Z',
    };

    expect(run.run_id).toBe('run-123');
    expect(run.status).toBe('completed');
    expect(run.output).toHaveLength(1);
  });

  it('should represent a valid CreateRunRequest', () => {
    const request: AcpCreateRunRequest = {
      agent_name: 'test-agent',
      input: [createUserMessage('Hello')],
      mode: 'stream',
    };

    expect(request.agent_name).toBe('test-agent');
    expect(request.input).toHaveLength(1);
    expect(request.mode).toBe('stream');
  });

  it('should represent SSE events with different types', () => {
    const runEvent: AcpSseEvent = {
      type: 'run.created',
      data: {
        run: {
          run_id: 'run-1',
          agent_name: 'agent',
          status: 'created',
          mode: 'sync',
          created_at: '2026-04-06T00:00:00Z',
        },
      },
    };

    expect(runEvent.type).toBe('run.created');
    expect('run' in runEvent.data).toBe(true);

    const msgEvent: AcpSseEvent = {
      type: 'message.created',
      data: {
        message: createUserMessage('test'),
      },
    };

    expect(msgEvent.type).toBe('message.created');
    expect('message' in msgEvent.data).toBe(true);
  });
});
