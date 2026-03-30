/**
 * ACP (Agent Communication Protocol) 单元测试
 *
 * @module sdk/acp/test
 * @see Issue #1333
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AcpErrorCodes,
  AcpMethods,
  AcpNotifications,
  isJsonRpcResponse,
  type JsonRpcRequest,
  type JsonRpcErrorResponse,
  type JsonRpcSuccessResponse,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpTaskCreateParams,
  type AcpTaskSendParams,
  type AcpTransportConfig,
} from './types.js';
import {
  JsonRpcMessageParser,
  createRequest,
  createSuccessResponse,
  createErrorResponse,
  createAcpError,
  serializeMessage,
  validateJsonRpcMessage,
  isErrorResponse,
  extractError,
} from './json-rpc.js';
import {
  StdioTransport,
  createTransport,
  type TransportEvent,
} from './transport.js';

// ============================================================================
// 类型定义测试
// ============================================================================

describe('ACP Types', () => {
  describe('AcpErrorCodes', () => {
    it('should define standard JSON-RPC error codes', () => {
      expect(AcpErrorCodes.PARSE_ERROR).toBe(-32700);
      expect(AcpErrorCodes.INVALID_REQUEST).toBe(-32600);
      expect(AcpErrorCodes.METHOD_NOT_FOUND).toBe(-32601);
      expect(AcpErrorCodes.INVALID_PARAMS).toBe(-32602);
      expect(AcpErrorCodes.INTERNAL_ERROR).toBe(-32603);
    });

    it('should define ACP-specific error codes in reserved range', () => {
      expect(AcpErrorCodes.AGENT_NOT_READY).toBe(-32001);
      expect(AcpErrorCodes.TASK_NOT_FOUND).toBe(-32002);
      expect(AcpErrorCodes.TASK_CANCELLED).toBe(-32003);
      expect(AcpErrorCodes.CAPABILITY_NOT_SUPPORTED).toBe(-32004);
      expect(AcpErrorCodes.CONNECTION_TIMEOUT).toBe(-32005);
    });
  });

  describe('AcpMethods', () => {
    it('should define all ACP methods', () => {
      expect(AcpMethods.INITIALIZE).toBe('initialize');
      expect(AcpMethods.TASK_CREATE).toBe('tasks/create');
      expect(AcpMethods.TASK_SEND).toBe('tasks/send');
      expect(AcpMethods.TASK_CANCEL).toBe('tasks/cancel');
      expect(AcpMethods.TASK_STATUS).toBe('tasks/status');
    });
  });

  describe('AcpNotifications', () => {
    it('should define notification methods', () => {
      expect(AcpNotifications.TASK_STATUS_CHANGED).toBe('notifications/taskStatusChanged');
      expect(AcpNotifications.TASK_MESSAGE).toBe('notifications/taskMessage');
    });
  });

  describe('isJsonRpcResponse', () => {
    it('should identify response messages', () => {
      const response: JsonRpcSuccessResponse = {
        jsonrpc: '2.0',
        result: { status: 'ok' },
        id: 1,
      };
      expect(isJsonRpcResponse(response)).toBe(true);
    });

    it('should identify request messages as non-response', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
      };
      expect(isJsonRpcResponse(request)).toBe(false);
    });
  });

  describe('ACP type contracts', () => {
    it('should type-check initialize params', () => {
      const params: AcpInitializeParams = {
        capabilities: {
          protocolVersion: '2025-06-01',
          role: 'client',
          streaming: true,
        },
        clientInfo: {
          name: 'disclaude',
          version: '0.1.0',
        },
      };
      expect(params.capabilities.protocolVersion).toBe('2025-06-01');
      expect(params.capabilities.role).toBe('client');
      expect(params.clientInfo.name).toBe('disclaude');
    });

    it('should type-check initialize result', () => {
      const result: AcpInitializeResult = {
        capabilities: {
          protocolVersion: '2025-06-01',
          role: 'server',
          contentTypes: ['text/plain', 'application/json'],
          toolFormats: ['json-schema'],
          streaming: true,
        },
        serverInfo: {
          name: 'claude-acp-server',
          version: '1.0.0',
        },
        protocolVersion: '2025-06-01',
      };
      expect(result.capabilities.role).toBe('server');
      expect(result.capabilities.streaming).toBe(true);
      expect(result.serverInfo.name).toBe('claude-acp-server');
    });

    it('should type-check task create params', () => {
      const params: AcpTaskCreateParams = {
        metadata: { description: 'Test task' },
        config: { model: 'gpt-4o' },
      };
      expect(params.metadata?.description).toBe('Test task');
      expect(params.config?.model).toBe('gpt-4o');
    });

    it('should type-check task send params with content blocks', () => {
      const params: AcpTaskSendParams = {
        taskId: 'task-123',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'tu-1', name: 'bash', input: { command: 'ls' } },
          { type: 'tool_result', toolUseId: 'tu-1', content: 'file1.txt\nfile2.txt' },
        ],
        role: 'user',
      };
      expect(params.taskId).toBe('task-123');
      expect(params.content).toHaveLength(3);
      expect(params.content[0].type).toBe('text');
      expect(params.content[1].type).toBe('tool_use');
      expect(params.content[2].type).toBe('tool_result');
    });

    it('should type-check transport configs', () => {
      const stdioConfig: AcpTransportConfig = {
        type: 'stdio',
        command: 'claude',
        args: ['--acp'],
        env: { API_KEY: 'test' },
        cwd: '/workspace',
      };
      expect(stdioConfig.type).toBe('stdio');
      expect(stdioConfig.command).toBe('claude');

      const sseConfig: AcpTransportConfig = {
        type: 'sse',
        url: 'http://localhost:8080/acp',
        headers: { Authorization: 'Bearer token' },
      };
      expect(sseConfig.type).toBe('sse');
      expect(sseConfig.url).toBe('http://localhost:8080/acp');
    });
  });
});

// ============================================================================
// JSON-RPC 消息处理测试
// ============================================================================

describe('JsonRpcMessageParser', () => {
  it('should parse a single complete message', () => {
    const parser = new JsonRpcMessageParser();
    const messages = parser.feed('{"jsonrpc":"2.0","method":"initialize","id":1}\n');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
    });
  });

  it('should parse multiple messages from a single feed', () => {
    const parser = new JsonRpcMessageParser();
    const messages = parser.feed(
      '{"jsonrpc":"2.0","method":"initialize","id":1}\n' +
      '{"jsonrpc":"2.0","result":{},"id":1}\n'
    );

    expect(messages).toHaveLength(2);
  });

  it('should buffer incomplete messages across feeds', () => {
    const parser = new JsonRpcMessageParser();

    const batch1 = parser.feed('{"jsonrpc":"2.0","method":"initi');
    expect(batch1).toHaveLength(0);

    const batch2 = parser.feed('alize","id":1}\n');
    expect(batch2).toHaveLength(1);
    expect(batch2[0]).toMatchObject({ method: 'initialize', id: 1 });
  });

  it('should skip empty lines', () => {
    const parser = new JsonRpcMessageParser();
    const messages = parser.feed('\n\n{"jsonrpc":"2.0","method":"test","id":1}\n\n');

    expect(messages).toHaveLength(1);
  });

  it('should skip invalid JSON silently', () => {
    const parser = new JsonRpcMessageParser();
    const messages = parser.feed(
      'not json\n' +
      '{"jsonrpc":"2.0","method":"test","id":1}\n' +
      '{"broken\n'
    );

    expect(messages).toHaveLength(1);
  });

  it('should reset buffer', () => {
    const parser = new JsonRpcMessageParser();
    parser.feed('{"jsonrpc":"2.0","method":"incomplete"');
    parser.reset();

    const messages = parser.feed('{"jsonrpc":"2.0","method":"test","id":1}\n');
    expect(messages).toHaveLength(1);
  });
});

describe('JSON-RPC Message Creation', () => {
  it('should create a request with id', () => {
    const request = createRequest('tasks/create', { metadata: {} }, 1);
    expect(request).toEqual({
      jsonrpc: '2.0',
      method: 'tasks/create',
      params: { metadata: {} },
      id: 1,
    });
  });

  it('should create a notification (request without id)', () => {
    const notification = createRequest('notifications/taskMessage');
    expect(notification).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/taskMessage',
    });
    expect(notification.id).toBeUndefined();
  });

  it('should create a success response', () => {
    const response = createSuccessResponse(1, { taskId: 'task-1', status: 'created' });
    expect(response).toEqual({
      jsonrpc: '2.0',
      result: { taskId: 'task-1', status: 'created' },
      id: 1,
    });
  });

  it('should create an error response', () => {
    const response = createErrorResponse(null, -32700, 'Parse error');
    expect(response).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
  });

  it('should create an error response with data', () => {
    const response = createErrorResponse(1, -32602, 'Invalid params', { field: 'taskId' });
    expect(response).toEqual({
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Invalid params', data: { field: 'taskId' } },
      id: 1,
    });
  });

  it('should create an ACP error', () => {
    const response = createAcpError(1, AcpErrorCodes.TASK_NOT_FOUND, 'Task not found');
    expect(isErrorResponse(response)).toBe(true);
    expect(response.error.code).toBe(-32002);
    expect(response.error.message).toBe('Task not found');
  });
});

describe('JSON-RPC Serialization', () => {
  it('should serialize message with newline', () => {
    const request = createRequest('test', undefined, 1);
    const serialized = serializeMessage(request);
    expect(serialized).toBe('{"jsonrpc":"2.0","method":"test","id":1}\n');
  });
});

describe('JSON-RPC Validation', () => {
  it('should validate a valid request', () => {
    const msg = validateJsonRpcMessage({ jsonrpc: '2.0', method: 'test', id: 1 });
    expect(msg).not.toBeNull();
    expect(msg).toMatchObject({ jsonrpc: '2.0', method: 'test', id: 1 });
  });

  it('should validate a valid notification (no id)', () => {
    const msg = validateJsonRpcMessage({ jsonrpc: '2.0', method: 'notify' });
    expect(msg).not.toBeNull();
    if (msg && 'id' in msg) {
      expect(msg.id).toBeUndefined();
    }
  });

  it('should validate a success response', () => {
    const msg = validateJsonRpcMessage({ jsonrpc: '2.0', result: { ok: true }, id: 1 });
    expect(msg).not.toBeNull();
    if (msg) {
      expect(isJsonRpcResponse(msg)).toBe(true);
    }
  });

  it('should validate an error response', () => {
    const msg = validateJsonRpcMessage({
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Not found' },
      id: 1,
    });
    expect(msg).not.toBeNull();
    if (msg) {
      expect(isErrorResponse(msg)).toBe(true);
    }
  });

  it('should reject non-object input', () => {
    expect(validateJsonRpcMessage(null)).toBeNull();
    expect(validateJsonRpcMessage('string')).toBeNull();
    expect(validateJsonRpcMessage(42)).toBeNull();
    expect(validateJsonRpcMessage(undefined)).toBeNull();
  });

  it('should reject wrong jsonrpc version', () => {
    expect(validateJsonRpcMessage({ jsonrpc: '1.0', method: 'test' })).toBeNull();
  });

  it('should reject object without method or result/error', () => {
    expect(validateJsonRpcMessage({ jsonrpc: '2.0' })).toBeNull();
  });

  it('should reject error response with invalid error object', () => {
    expect(validateJsonRpcMessage({ jsonrpc: '2.0', error: 'bad' })).toBeNull();
  });
});

describe('JSON-RPC Response Helpers', () => {
  it('should identify error responses', () => {
    const errorResp: JsonRpcErrorResponse = {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Not ready' },
      id: 1,
    };
    expect(isErrorResponse(errorResp)).toBe(true);

    const successResp: JsonRpcSuccessResponse = {
      jsonrpc: '2.0',
      result: {},
      id: 1,
    };
    expect(isErrorResponse(successResp)).toBe(false);
  });

  it('should extract error from error response', () => {
    const errorResp: JsonRpcErrorResponse = {
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Bad params', data: { field: 'x' } },
      id: 1,
    };
    const extracted = extractError(errorResp);
    expect(extracted).toEqual({
      code: -32602,
      message: 'Bad params',
      data: { field: 'x' },
    });
  });
});

// ============================================================================
// 传输层测试
// ============================================================================

describe('StdioTransport', () => {
  let transport: StdioTransport;
  let events: TransportEvent[];

  beforeEach(() => {
    events = [];
    transport = new StdioTransport(
      { type: 'stdio', command: 'echo', args: ['{}'] },
      (event) => events.push(event)
    );
  });

  afterEach(() => {
    transport.close();
  });

  it('should start in non-closed state', () => {
    expect(transport.closed).toBe(false);
  });

  it('should report closed after close()', () => {
    transport.close();
    expect(transport.closed).toBe(true);
  });

  it('should be idempotent on close()', () => {
    transport.close();
    transport.close();
    expect(transport.closed).toBe(true);
  });

  it('should throw when sending on closed transport', () => {
    transport.close();
    expect(() => transport.send(createRequest('test', undefined, 1))).toThrow('Transport is closed');
  });

  it('should throw when starting twice', () => {
    transport.start();
    expect(() => transport.start()).toThrow('Transport already started');
  });
});

describe('createTransport', () => {
  it('should create stdio transport', () => {
    const transport = createTransport({ type: 'stdio', command: 'echo' });
    expect(transport).toBeInstanceOf(StdioTransport);
    transport.close();
  });

  it('should throw for SSE transport (not yet implemented)', () => {
    expect(() =>
      createTransport({ type: 'sse', url: 'http://localhost' })
    ).toThrow('SSE transport is not yet implemented');
  });
});

// ============================================================================
// 连接管理测试
// ============================================================================

describe('AcpConnection', () => {
  it('should be importable', async () => {
    const { AcpConnection } = await import('./connection.js');
    expect(AcpConnection).toBeDefined();
  });
});
