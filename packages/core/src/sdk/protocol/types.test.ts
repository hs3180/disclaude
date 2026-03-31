/**
 * Unit tests for ACP Protocol Types
 *
 * @module sdk/protocol/types.test
 */

import { describe, it, expect } from 'vitest';
import type {
  ACPMessage,
  ACPMessagePart,
  ACPRun,
  ACPEvent,
  ACPAgentManifest,
  ACPRunCreateRequest,
  ACPRunStatus,
  ACPClientConfig,
} from './types.js';

describe('ACP Protocol Types', () => {
  describe('ACPMessagePart', () => {
    it('should type-check a text message part', () => {
      const part: ACPMessagePart = {
        content_type: 'text/plain',
        content: 'Hello, world!',
      };

      expect(part.content_type).toBe('text/plain');
      expect(part.content).toBe('Hello, world!');
    });

    it('should type-check a message part with metadata', () => {
      const part: ACPMessagePart = {
        content_type: 'text/plain',
        content: 'See source',
        metadata: {
          kind: 'citation',
          url: 'https://example.com/doc',
          title: 'Reference Doc',
        },
      };

      expect(part.metadata?.kind).toBe('citation');
    });

    it('should type-check a trajectory metadata part', () => {
      const part: ACPMessagePart = {
        content_type: 'application/json',
        content: '{}',
        metadata: {
          kind: 'trajectory',
          message: 'Thinking about the answer...',
          tool_name: 'search',
          tool_input: { query: 'test' },
          tool_output: { results: [] },
        },
      };

      expect(part.metadata?.kind).toBe('trajectory');
      if (part.metadata && 'tool_name' in part.metadata) {
        expect(part.metadata.tool_name).toBe('search');
      }
    });

    it('should type-check a base64 encoded part', () => {
      const part: ACPMessagePart = {
        content_type: 'image/png',
        content: 'iVBORw0KGgo=',
        content_encoding: 'base64',
      };

      expect(part.content_encoding).toBe('base64');
    });

    it('should type-check a part with content_url', () => {
      const part: ACPMessagePart = {
        content_type: 'image/png',
        content_url: 'https://example.com/image.png',
      };

      expect(part.content_url).toBe('https://example.com/image.png');
      expect(part.content).toBeUndefined();
    });

    it('should type-check a named part (artifact)', () => {
      const part: ACPMessagePart = {
        name: 'report.pdf',
        content_type: 'application/pdf',
        content_url: 'https://example.com/report.pdf',
      };

      expect(part.name).toBe('report.pdf');
    });
  });

  describe('ACPMessage', () => {
    it('should type-check a user message', () => {
      const message: ACPMessage = {
        role: 'user',
        parts: [
          {
            content_type: 'text/plain',
            content: 'What is the weather today?',
          },
        ],
      };

      expect(message.role).toBe('user');
      expect(message.parts).toHaveLength(1);
    });

    it('should type-check an agent message', () => {
      const message: ACPMessage = {
        role: 'agent/echo',
        parts: [
          {
            content_type: 'text/plain',
            content: 'You said: What is the weather today?',
          },
        ],
      };

      expect(message.role).toBe('agent/echo');
    });

    it('should type-check a multi-part message', () => {
      const message: ACPMessage = {
        role: 'agent',
        parts: [
          { content_type: 'text/plain', content: 'Here is the analysis:' },
          { name: 'chart.png', content_type: 'image/png', content: 'base64data...' },
          { content_type: 'text/plain', content: 'Summary: positive trend.' },
        ],
      };

      expect(message.parts).toHaveLength(3);
    });
  });

  describe('ACPRun', () => {
    it('should type-check a completed run', () => {
      const run: ACPRun = {
        agent_name: 'echo',
        run_id: '44e480d6-9a3e-4e35-8a03-faa759e19588',
        session_id: 'b30b1946-6010-4974-bd35-89a2bb0ce844',
        status: 'completed',
        output: [
          {
            role: 'agent/echo',
            parts: [{ content_type: 'text/plain', content: 'Hello!' }],
          },
        ],
        created_at: '2026-04-01T00:00:00Z',
        finished_at: '2026-04-01T00:00:01Z',
      };

      expect(run.status).toBe('completed');
      expect(run.output).toHaveLength(1);
    });

    it('should type-check a failed run with error', () => {
      const run: ACPRun = {
        agent_name: 'agent',
        run_id: 'failed-run-id',
        status: 'failed',
        output: [],
        error: {
          code: 'server_error',
          message: 'Internal server error',
        },
        created_at: '2026-04-01T00:00:00Z',
      };

      expect(run.status).toBe('failed');
      expect(run.error?.code).toBe('server_error');
    });

    it('should accept all valid run statuses', () => {
      const statuses: ACPRunStatus[] = [
        'created',
        'in-progress',
        'awaiting',
        'cancelling',
        'cancelled',
        'completed',
        'failed',
      ];

      for (const status of statuses) {
        const run: ACPRun = {
          agent_name: 'test',
          run_id: 'test-id',
          status,
          output: [],
          created_at: '2026-04-01T00:00:00Z',
        };
        expect(run.status).toBe(status);
      }
    });
  });

  describe('ACPEvent', () => {
    it('should type-check run events', () => {
      const events: ACPEvent[] = [
        { type: 'run.created', run: { agent_name: 'test', run_id: '1', status: 'created', output: [], created_at: '' } },
        { type: 'run.in-progress', run: { agent_name: 'test', run_id: '1', status: 'in-progress', output: [], created_at: '' } },
        { type: 'run.completed', run: { agent_name: 'test', run_id: '1', status: 'completed', output: [], created_at: '' } },
        { type: 'run.failed', run: { agent_name: 'test', run_id: '1', status: 'failed', output: [], error: { code: 'server_error', message: 'err' }, created_at: '' } },
      ];

      expect(events).toHaveLength(4);
      expect(events[0].type).toBe('run.created');
      expect(events[3].type).toBe('run.failed');
    });

    it('should type-check message events', () => {
      const events: ACPEvent[] = [
        {
          type: 'message.created',
          message: {
            role: 'agent',
            parts: [{ content_type: 'text/plain', content: '' }],
          },
        },
        {
          type: 'message.part',
          part: { content_type: 'text/plain', content: 'Hello' },
        },
        {
          type: 'message.completed',
          message: {
            role: 'agent',
            parts: [{ content_type: 'text/plain', content: 'Hello world' }],
          },
        },
      ];

      expect(events).toHaveLength(3);
    });

    it('should type-check error event', () => {
      const event: ACPEvent = {
        type: 'error',
        error: {
          code: 'invalid_input',
          message: 'Missing required field: agent_name',
        },
      };

      expect(event.type).toBe('error');
      if (event.type === 'error') {
        expect(event.error.code).toBe('invalid_input');
      }
    });
  });

  describe('ACPAgentManifest', () => {
    it('should type-check a minimal agent manifest', () => {
      const manifest: ACPAgentManifest = {
        name: 'echo',
        description: 'Echoes everything',
        input_content_types: ['*/*'],
        output_content_types: ['text/plain'],
      };

      expect(manifest.name).toBe('echo');
      expect(manifest.input_content_types).toContain('*/*');
    });

    it('should type-check a full agent manifest with metadata', () => {
      const manifest: ACPAgentManifest = {
        name: 'research-agent',
        description: 'Research agent with search capabilities',
        input_content_types: ['text/plain', 'application/json'],
        output_content_types: ['text/plain', 'application/json'],
        metadata: {
          framework: 'custom',
          capabilities: [
            { name: 'Web Search', description: 'Search the web for information' },
            { name: 'Summarization', description: 'Summarize research findings' },
          ],
          tags: ['Research', 'RAG'],
          recommended_models: ['gpt-4o', 'claude-3-opus'],
        },
        status: {
          avg_run_time_seconds: 5.2,
          success_rate: 95.5,
        },
      };

      expect(manifest.metadata?.capabilities).toHaveLength(2);
      expect(manifest.status?.success_rate).toBe(95.5);
    });
  });

  describe('ACPRunCreateRequest', () => {
    it('should type-check a minimal create request', () => {
      const request: ACPRunCreateRequest = {
        agent_name: 'echo',
        input: [
          {
            role: 'user',
            parts: [{ content_type: 'text/plain', content: 'Hello!' }],
          },
        ],
      };

      expect(request.agent_name).toBe('echo');
      expect(request.input).toHaveLength(1);
    });

    it('should type-check a create request with session and mode', () => {
      const request: ACPRunCreateRequest = {
        agent_name: 'chat',
        session_id: 'session-123',
        input: [
          {
            role: 'user',
            parts: [{ content_type: 'text/plain', content: 'Continue' }],
          },
        ],
        mode: 'stream',
      };

      expect(request.mode).toBe('stream');
      expect(request.session_id).toBe('session-123');
    });
  });

  describe('ACPClientConfig', () => {
    it('should type-check a minimal config', () => {
      const config: ACPClientConfig = {
        baseUrl: 'http://localhost:8000',
      };

      expect(config.baseUrl).toBe('http://localhost:8000');
    });

    it('should type-check a full config', () => {
      const config: ACPClientConfig = {
        baseUrl: 'http://localhost:8000',
        timeout: 60000,
        headers: {
          'X-API-Key': 'secret',
        },
      };

      expect(config.timeout).toBe(60000);
      expect(config.headers?.['X-API-Key']).toBe('secret');
    });
  });
});
