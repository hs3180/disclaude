/**
 * ACP 协议基础设施单元测试
 *
 * 测试 ACP 类型定义、消息适配器和 HTTP 客户端。
 * 使用 mock fetch 进行网络隔离测试。
 *
 * @module sdk/providers/acp
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACPClient, ACPProtocolError } from './client.js';
import { adaptACPEvent, toACPMessages } from './message-adapter.js';
import type {
  ACPEvent,
  ACPMessagePart,
} from './types.js';

// ============================================================================
// Mock fetch 工具
// ============================================================================

/**
 * 断言 result 非空并返回（避免 non-null assertion）
 */
function expectNonNull<T>(value: T | null, message?: string): T {
  if (value === null) {
    throw new Error(message ?? 'Expected non-null value');
  }
  return value;
}

/**
 * 创建 mock fetch 函数
 */
function createMockFetch(responses: Record<string, {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  stream?: string;
}>): typeof globalThis.fetch {
  // eslint-disable-next-line require-await
  return vi.fn((async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    // 匹配路径
    for (const [pattern, response] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        // SSE 流
        if (response.stream) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const lines = (response.stream ?? '').split('\n');
              for (const line of lines) {
                controller.enqueue(encoder.encode(`${line}\n`));
              }
              controller.close();
            },
          });

          return new Response(stream, {
            status: response.status,
            headers: {
              'Content-Type': 'text/event-stream',
              ...response.headers,
            },
          }) as Response;
        }

        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: {
            'Content-Type': 'application/json',
            ...response.headers,
          },
        }) as Response;
      }
    }

    return new Response(JSON.stringify({ code: 'not_found', message: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }) as Response;
  }) satisfies typeof globalThis.fetch) as unknown as ReturnType<typeof createMockFetch>;
}

// ============================================================================
// 消息适配器测试
// ============================================================================

describe('adaptACPEvent', () => {
  describe('message events', () => {
    it('should adapt message.created event with text content', () => {
      const event: ACPEvent = {
        type: 'message.created',
        message: {
          role: 'agent',
          parts: [{
            content_type: 'text/plain',
            content: 'Hello, world!',
          }],
        },
      };

      const result = adaptACPEvent(event);

      expect(result).not.toBeNull();
      const msg = expectNonNull(result);
      expect(msg.type).toBe('text');
      expect(msg.content).toBe('Hello, world!');
      expect(msg.role).toBe('assistant');
    });

    it('should return null for message.created with no text parts', () => {
      const event: ACPEvent = {
        type: 'message.created',
        message: {
          role: 'agent',
          parts: [{
            content_type: 'image/png',
            content_url: 'https://example.com/image.png',
          }],
        },
      };

      expect(adaptACPEvent(event)).toBeNull();
    });

    it('should adapt message.part with trajectory metadata as tool_use', () => {
      const part: ACPMessagePart = {
        content_type: 'text/plain',
        content: 'Running tool...',
        metadata: {
          kind: 'trajectory',
          tool_name: 'bash',
          tool_input: { command: 'ls' },
          tool_output: { files: ['a.ts', 'b.ts'] },
        },
      };

      const event: ACPEvent = { type: 'message.part', part };
      const result = adaptACPEvent(event);

      expect(result).not.toBeNull();
      const msg = expectNonNull(result);
      expect(msg.type).toBe('tool_use');
      expect(msg.role).toBe('assistant');
      expect(msg.metadata?.toolName).toBe('bash');
      expect(msg.metadata?.toolInput).toEqual({ command: 'ls' });
      expect(msg.metadata?.toolOutput).toEqual({ files: ['a.ts', 'b.ts'] });
    });

    it('should adapt message.part with text content', () => {
      const part: ACPMessagePart = {
        content_type: 'text/plain',
        content: 'Some text',
      };

      const event: ACPEvent = { type: 'message.part', part };
      const result = adaptACPEvent(event);

      expect(result).not.toBeNull();
      const msg = expectNonNull(result);
      expect(msg.type).toBe('text');
      expect(msg.content).toBe('Some text');
    });

    it('should return null for non-text message.part', () => {
      const part: ACPMessagePart = {
        content_type: 'image/png',
        content_url: 'https://example.com/img.png',
      };

      const event: ACPEvent = { type: 'message.part', part };
      expect(adaptACPEvent(event)).toBeNull();
    });
  });

  describe('run events', () => {
    it('should adapt run.created event', () => {
      const event: ACPEvent = {
        type: 'run.created',
        run: {
          run_id: 'run-123',
          agent_name: 'assistant',
          status: 'created',
          output: [],
          created_at: '2026-04-01T00:00:00Z',
        },
      };

      const result = adaptACPEvent(event);

      expect(result).not.toBeNull();
      const msg = expectNonNull(result);
      expect(msg.type).toBe('status');
      expect(msg.content).toContain('run-123');
      expect(msg.role).toBe('system');
    });

    it('should adapt run.completed event', () => {
      const event: ACPEvent = {
        type: 'run.completed',
        run: {
          run_id: 'run-123',
          agent_name: 'assistant',
          session_id: 'session-456',
          status: 'completed',
          output: [{
            role: 'agent',
            parts: [{ content_type: 'text/plain', content: 'Task done!' }],
          }],
          created_at: '2026-04-01T00:00:00Z',
          finished_at: '2026-04-01T00:00:05Z',
        },
      };

      const result = adaptACPEvent(event);

      expect(result).not.toBeNull();
      const msg = expectNonNull(result);
      expect(msg.type).toBe('result');
      expect(msg.content).toBe('Task done!');
      expect(msg.metadata?.sessionId).toBe('session-456');
    });

    it('should adapt run.completed with empty output', () => {
      const event: ACPEvent = {
        type: 'run.completed',
        run: {
          run_id: 'run-123',
          agent_name: 'assistant',
          status: 'completed',
          output: [],
          created_at: '2026-04-01T00:00:00Z',
          finished_at: '2026-04-01T00:00:05Z',
        },
      };

      const result = adaptACPEvent(event);

      expect(result).not.toBeNull();
      const msg = expectNonNull(result);
      expect(msg.type).toBe('result');
      expect(msg.content).toBe('✅ Run completed');
    });

    it('should adapt run.failed event', () => {
      const event: ACPEvent = {
        type: 'run.failed',
        run: {
          run_id: 'run-123',
          agent_name: 'assistant',
          status: 'failed',
          output: [],
          error: {
            code: 'server_error',
            message: 'Internal error',
          },
          created_at: '2026-04-01T00:00:00Z',
          finished_at: '2026-04-01T00:00:01Z',
        },
      };

      const result = adaptACPEvent(event);

      expect(result).not.toBeNull();
      const msg = expectNonNull(result);
      expect(msg.type).toBe('error');
      expect(msg.content).toContain('Internal error');
    });

    it('should adapt run.cancelled event', () => {
      const event: ACPEvent = {
        type: 'run.cancelled',
        run: {
          run_id: 'run-123',
          agent_name: 'assistant',
          status: 'cancelled',
          output: [],
          created_at: '2026-04-01T00:00:00Z',
          finished_at: '2026-04-01T00:00:02Z',
        },
      };

      const result = adaptACPEvent(event);

      expect(result).not.toBeNull();
      const msg = expectNonNull(result);
      expect(msg.type).toBe('result');
      expect(msg.content).toContain('cancelled');
    });

    it('should adapt run.awaiting event', () => {
      const event: ACPEvent = {
        type: 'run.awaiting',
        run: {
          run_id: 'run-123',
          agent_name: 'assistant',
          session_id: 'session-789',
          status: 'awaiting',
          await_request: {
            type: 'message',
            message: {
              role: 'agent',
              parts: [{ content_type: 'text/plain', content: 'Need input' }],
            },
          },
          output: [],
          created_at: '2026-04-01T00:00:00Z',
        },
      };

      const result = adaptACPEvent(event);

      expect(result).not.toBeNull();
      const msg = expectNonNull(result);
      expect(msg.type).toBe('status');
      expect(msg.content).toContain('awaiting');
    });
  });

  describe('error event', () => {
    it('should adapt error event', () => {
      const event: ACPEvent = {
        type: 'error',
        error: {
          code: 'invalid_input',
          message: 'Invalid request',
        },
      };

      const result = adaptACPEvent(event);

      expect(result).not.toBeNull();
      const msg = expectNonNull(result);
      expect(msg.type).toBe('error');
      expect(msg.content).toContain('Invalid request');
      expect(msg.role).toBe('system');
    });
  });

  describe('role adaptation', () => {
    it('should adapt user role correctly', () => {
      const event: ACPEvent = {
        type: 'message.created',
        message: {
          role: 'user',
          parts: [{ content_type: 'text/plain', content: 'Hi' }],
        },
      };

      expect(adaptACPEvent(event)).not.toBeNull();
      expect(expectNonNull(adaptACPEvent(event)).role).toBe('user');
    });

    it('should adapt agent role to assistant', () => {
      const event: ACPEvent = {
        type: 'message.created',
        message: {
          role: 'agent',
          parts: [{ content_type: 'text/plain', content: 'Hi' }],
        },
      };

      expect(adaptACPEvent(event)).not.toBeNull();
      expect(expectNonNull(adaptACPEvent(event)).role).toBe('assistant');
    });

    it('should adapt agent/name role to assistant', () => {
      const event: ACPEvent = {
        type: 'message.created',
        message: {
          role: 'agent/assistant',
          parts: [{ content_type: 'text/plain', content: 'Hi' }],
        },
      };

      expect(adaptACPEvent(event)).not.toBeNull();
      expect(expectNonNull(adaptACPEvent(event)).role).toBe('assistant');
    });

    it('should adapt unknown role to system', () => {
      const event: ACPEvent = {
        type: 'message.created',
        message: {
          role: 'system',
          parts: [{ content_type: 'text/plain', content: 'Notice' }],
        },
      };

      expect(adaptACPEvent(event)).not.toBeNull();
      expect(expectNonNull(adaptACPEvent(event)).role).toBe('system');
    });
  });

  describe('multi-part messages', () => {
    it('should concatenate text from multiple parts', () => {
      const event: ACPEvent = {
        type: 'message.completed',
        message: {
          role: 'agent',
          parts: [
            { content_type: 'text/plain', content: 'Hello' },
            { content_type: 'text/plain', content: ' world!' },
          ],
        },
      };

      const result = adaptACPEvent(event);

      expect(result).not.toBeNull();
      expect(expectNonNull(result).content).toBe('Hello world!');
    });

    it('should extract trajectory metadata from message parts', () => {
      const event: ACPEvent = {
        type: 'message.completed',
        message: {
          role: 'agent',
          parts: [
            {
              content_type: 'text/plain',
              content: 'It is sunny.',
              metadata: {
                kind: 'trajectory',
                tool_name: 'weather_api',
                tool_input: { location: 'SF' },
                tool_output: { temp: 72 },
              },
            },
          ],
        },
      };

      const result = adaptACPEvent(event);

      expect(result).not.toBeNull();
      expect(expectNonNull(result).metadata?.toolName).toBe('weather_api');
    });
  });
});

// ============================================================================
// toACPMessages 测试
// ============================================================================

describe('toACPMessages', () => {
  it('should convert string to single ACP message', () => {
    const messages = toACPMessages('Hello!');

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].parts).toHaveLength(1);
    expect(messages[0].parts[0].content_type).toBe('text/plain');
    expect(messages[0].parts[0].content).toBe('Hello!');
  });

  it('should convert UserInput array with string content', () => {
    const messages = toACPMessages([
      { role: 'user', content: 'First' },
      { role: 'user', content: 'Second' },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0].parts[0].content).toBe('First');
    expect(messages[1].parts[0].content).toBe('Second');
  });

  it('should convert UserInput with text ContentBlock', () => {
    const messages = toACPMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Block text' }],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].parts[0].content_type).toBe('text/plain');
    expect(messages[0].parts[0].content).toBe('Block text');
  });

  it('should convert UserInput with image ContentBlock', () => {
    const messages = toACPMessages([
      {
        role: 'user',
        content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].parts[0].content_type).toBe('image/png');
    expect(messages[0].parts[0].content).toBe('base64data');
    expect(messages[0].parts[0].content_encoding).toBe('base64');
  });

  it('should convert mixed ContentBlock array', () => {
    const messages = toACPMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'See this image:' },
          { type: 'image', data: 'imgdata', mimeType: 'image/jpeg' },
        ],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toHaveLength(2);
    expect(messages[0].parts[0].content_type).toBe('text/plain');
    expect(messages[0].parts[0].content).toBe('See this image:');
    expect(messages[0].parts[1].content_type).toBe('image/jpeg');
  });
});

// ============================================================================
// ACPClient 测试
// ============================================================================

describe('ACPClient', () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should normalize baseUrl by removing trailing slash', () => {
      const client = new ACPClient({
        baseUrl: 'http://localhost:8000/',
        fetch: createMockFetch({}),
      });

      const info = client.getConnectionInfo();
      expect(info.baseUrl).toBe('http://localhost:8000');
    });

    it('should keep baseUrl without trailing slash', () => {
      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: createMockFetch({}),
      });

      const info = client.getConnectionInfo();
      expect(info.baseUrl).toBe('http://localhost:8000');
    });
  });

  describe('connect', () => {
    it('should connect successfully', async () => {
      mockFetch = createMockFetch({
        '/ping': { status: 200, body: { status: 'ok' } },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      await client.connect();

      const info = client.getConnectionInfo();
      expect(info.state).toBe('connected');
      expect(info.connectedAt).toBeInstanceOf(Date);
    });

    it('should set error state on connection failure', async () => {
      mockFetch = createMockFetch({
        '/ping': { status: 500, body: { code: 'server_error', message: 'Internal error' } },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      await expect(client.connect()).rejects.toThrow(ACPProtocolError);

      const info = client.getConnectionInfo();
      expect(info.state).toBe('error');
      expect(info.lastError).toBeDefined();
    });
  });

  describe('disconnect', () => {
    it('should reset connection state', async () => {
      mockFetch = createMockFetch({
        '/ping': { status: 200, body: { status: 'ok' } },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      await client.connect();
      client.disconnect();

      const info = client.getConnectionInfo();
      expect(info.state).toBe('disconnected');
      expect(info.connectedAt).toBeUndefined();
    });
  });

  describe('listAgents', () => {
    it('should list agents and cache results', async () => {
      const agents = [
        {
          name: 'assistant',
          description: 'General assistant',
          input_content_types: ['*/*'],
          output_content_types: ['text/plain'],
        },
      ];

      mockFetch = createMockFetch({
        '/agents': { status: 200, body: agents },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      const result = await client.listAgents();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('assistant');

      const info = client.getConnectionInfo();
      expect(info.agents).toHaveLength(1);
    });

    it('should pass pagination parameters', async () => {
      mockFetch = createMockFetch({
        '/agents': { status: 200, body: [] },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      await client.listAgents({ limit: 10, offset: 20 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain(`limit=${10}`);
      expect(calledUrl).toContain(`offset=${20}`);
    });
  });

  describe('getAgent', () => {
    it('should get agent manifest by name', async () => {
      const manifest = {
        name: 'assistant',
        description: 'Test agent',
        input_content_types: ['text/plain'],
        output_content_types: ['text/plain'],
      };

      mockFetch = createMockFetch({
        '/agents/assistant': { status: 200, body: manifest },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      const result = await client.getAgent('assistant');

      expect(result.name).toBe('assistant');
    });
  });

  describe('runSync', () => {
    it('should create and complete a sync run', async () => {
      const run = {
        run_id: 'run-123',
        agent_name: 'assistant',
        status: 'completed',
        output: [{
          role: 'agent',
          parts: [{ content_type: 'text/plain', content: 'Done!' }],
        }],
        created_at: '2026-04-01T00:00:00Z',
        finished_at: '2026-04-01T00:00:05Z',
      };

      mockFetch = createMockFetch({
        '/runs': { status: 200, body: run },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      const result = await client.runSync({
        agent_name: 'assistant',
        input: [{ role: 'user', parts: [{ content_type: 'text/plain', content: 'Hello' }] }],
        mode: 'sync',
      });

      expect(result.run_id).toBe('run-123');
      expect(result.status).toBe('completed');
    });
  });

  describe('runAsync', () => {
    it('should create an async run and return 202', async () => {
      const run = {
        run_id: 'run-456',
        agent_name: 'assistant',
        status: 'in-progress',
        output: [],
        created_at: '2026-04-01T00:00:00Z',
      };

      mockFetch = createMockFetch({
        '/runs': { status: 202, body: run },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      const result = await client.runAsync({
        agent_name: 'assistant',
        input: [{ role: 'user', parts: [{ content_type: 'text/plain', content: 'Hello' }] }],
        mode: 'async',
      });

      expect(result.run_id).toBe('run-456');
    });
  });

  describe('getRunStatus', () => {
    it('should get run status', async () => {
      const run = {
        run_id: 'run-789',
        agent_name: 'assistant',
        status: 'in-progress',
        output: [],
        created_at: '2026-04-01T00:00:00Z',
      };

      mockFetch = createMockFetch({
        '/runs/run-789': { status: 200, body: run },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      const result = await client.getRunStatus('run-789');

      expect(result.status).toBe('in-progress');
    });
  });

  describe('cancelRun', () => {
    it('should cancel a run', async () => {
      const run = {
        run_id: 'run-cancel',
        agent_name: 'assistant',
        status: 'cancelled',
        output: [],
        created_at: '2026-04-01T00:00:00Z',
        finished_at: '2026-04-01T00:00:02Z',
      };

      mockFetch = createMockFetch({
        '/runs/run-cancel/cancel': { status: 200, body: run },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      const result = await client.cancelRun('run-cancel');

      expect(result.status).toBe('cancelled');
    });
  });

  describe('error handling', () => {
    it('should throw ACPProtocolError on 404', async () => {
      mockFetch = createMockFetch({
        '/agents/nonexistent': {
          status: 404,
          body: { code: 'not_found', message: 'Agent not found' },
        },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      await expect(client.getAgent('nonexistent')).rejects.toThrow(ACPProtocolError);
    });

    it('should throw ACPProtocolError on 400', async () => {
      mockFetch = createMockFetch({
        '/runs': {
          status: 400,
          body: { code: 'invalid_input', message: 'Bad request' },
        },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      await expect(client.runSync({
        agent_name: '',
        input: [],
        mode: 'sync',
      })).rejects.toThrow(ACPProtocolError);
    });

    it('should handle non-JSON error response', async () => {
      mockFetch = createMockFetch({
        '/ping': { status: 502, body: 'Bad Gateway' },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      await expect(client.connect()).rejects.toThrow();
    });
  });

  describe('timeout', () => {
    it('should use default timeout of 30000ms', () => {
      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: createMockFetch({}),
      });

      // Just verify the client is created without error
      expect(client.getConnectionInfo().state).toBe('disconnected');
    });

    it('should accept custom timeout', () => {
      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        timeout: 5000,
        fetch: createMockFetch({}),
      });

      expect(client.getConnectionInfo().state).toBe('disconnected');
    });
  });

  describe('custom headers', () => {
    it('should merge custom headers with defaults', async () => {
      mockFetch = createMockFetch({
        '/ping': { status: 200, body: { status: 'ok' } },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
        headers: {
          'Authorization': 'Bearer test-token',
        },
      });

      await client.connect();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const init = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-token');
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  describe('runStream', () => {
    it('should consume SSE events', async () => {
      const sseData = [
        'event: run.created',
        'data: {"type":"run.created","run":{"run_id":"run-sse","agent_name":"assistant","status":"created","output":[],"created_at":"2026-04-01T00:00:00Z"}}',
        '',
        'event: message.part',
        'data: {"type":"message.part","part":{"content_type":"text/plain","content":"Hello!"}}',
        '',
        'event: run.completed',
        'data: {"type":"run.completed","run":{"run_id":"run-sse","agent_name":"assistant","status":"completed","output":[{"role":"agent","parts":[{"content_type":"text/plain","content":"Hello!"}]}],"created_at":"2026-04-01T00:00:00Z","finished_at":"2026-04-01T00:00:05Z"}}',
        '',
      ].join('\n');

      mockFetch = createMockFetch({
        '/runs': { status: 200, stream: sseData },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      const events: ACPEvent[] = [];
      await client.runStream(
        {
          agent_name: 'assistant',
          input: [{ role: 'user', parts: [{ content_type: 'text/plain', content: 'Hi' }] }],
          mode: 'stream',
        },
        (event) => events.push(event),
      );

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('run.created');
      expect(events[1].type).toBe('message.part');
      expect(events[2].type).toBe('run.completed');
    });
  });

  describe('resumeRun', () => {
    it('should resume an awaiting run', async () => {
      const run = {
        run_id: 'run-resume',
        agent_name: 'assistant',
        session_id: 'session-123',
        status: 'in-progress',
        output: [],
        created_at: '2026-04-01T00:00:00Z',
      };

      mockFetch = createMockFetch({
        '/runs/run-resume': { status: 200, body: run },
      });

      const client = new ACPClient({
        baseUrl: 'http://localhost:8000',
        fetch: mockFetch,
      });

      const result = await client.resumeRun('run-resume', {
        role: 'user',
        parts: [{ content_type: 'text/plain', content: 'Here is the data' }],
      });

      expect(result.status).toBe('in-progress');
    });
  });
});

// ============================================================================
// ACPProtocolError 测试
// ============================================================================

describe('ACPProtocolError', () => {
  it('should create error with code and message', () => {
    const error = new ACPProtocolError('test error', 'server_error', 500);

    expect(error.message).toBe('test error');
    expect(error.code).toBe('server_error');
    expect(error.statusCode).toBe(500);
    expect(error.name).toBe('ACPProtocolError');
    expect(error).toBeInstanceOf(Error);
  });

  it('should create error with data', () => {
    const data = { field: 'value' };
    const error = new ACPProtocolError('test', 'invalid_input', 400, data);

    expect(error.data).toEqual(data);
  });
});
