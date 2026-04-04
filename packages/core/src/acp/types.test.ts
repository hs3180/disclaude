/**
 * Tests for ACP Protocol Types
 *
 * Verifies type constants, message format correctness,
 * and JSON-RPC 2.0 compatibility.
 *
 * Issue #1333: ACP protocol infrastructure
 */

import { describe, it, expect } from 'vitest';
import {
  JsonRpcErrorCode,
  AcpMethod,
  AcpNotification,
} from './types.js';

// ============================================================================
// JSON-RPC Error Codes
// ============================================================================

describe('JsonRpcErrorCode', () => {
  it('should define standard JSON-RPC error codes', () => {
    expect(JsonRpcErrorCode.PARSE_ERROR).toBe(-32700);
    expect(JsonRpcErrorCode.INVALID_REQUEST).toBe(-32600);
    expect(JsonRpcErrorCode.METHOD_NOT_FOUND).toBe(-32601);
    expect(JsonRpcErrorCode.INVALID_PARAMS).toBe(-32602);
    expect(JsonRpcErrorCode.INTERNAL_ERROR).toBe(-32603);
  });
});

// ============================================================================
// ACP Method Constants
// ============================================================================

describe('AcpMethod', () => {
  it('should define initialize method', () => {
    expect(AcpMethod.INITIALIZE).toBe('initialize');
  });

  it('should define task lifecycle methods', () => {
    expect(AcpMethod.TASK_CREATE).toBe('tasks/create');
    expect(AcpMethod.TASK_SEND).toBe('tasks/send');
    expect(AcpMethod.TASK_CANCEL).toBe('tasks/cancel');
    expect(AcpMethod.TASK_GET).toBe('tasks/get');
    expect(AcpMethod.TASK_LIST).toBe('tasks/list');
    expect(AcpMethod.TASK_CLOSE).toBe('tasks/close');
    expect(AcpMethod.TASK_FORK).toBe('tasks/fork');
  });
});

// ============================================================================
// ACP Notification Constants
// ============================================================================

describe('AcpNotification', () => {
  it('should define notification types', () => {
    expect(AcpNotification.TASK_STATUS).toBe('notifications/task/status');
    expect(AcpNotification.TASK_MESSAGE).toBe('notifications/task/message');
    expect(AcpNotification.TASK_ARTEFACT).toBe('notifications/task/artefact');
  });
});

// ============================================================================
// JSON-RPC Message Format
// ============================================================================

describe('JSON-RPC message format', () => {
  it('should produce valid JSON-RPC request', () => {
    const request = {
      jsonrpc: '2.0' as const,
      method: AcpMethod.INITIALIZE,
      params: {
        clientName: 'test',
        clientVersion: '1.0.0',
        capabilities: {},
      },
      id: 1,
    };

    const json = JSON.stringify(request);
    const parsed = JSON.parse(json);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('initialize');
    expect(parsed.params.clientName).toBe('test');
    expect(parsed.id).toBe(1);
  });

  it('should produce valid JSON-RPC response', () => {
    const response = {
      jsonrpc: '2.0' as const,
      id: 1,
      result: {
        agentName: 'test-agent',
        agentVersion: '1.0.0',
        capabilities: { streaming: true },
        protocolVersion: '2025-01-01',
      },
    };

    const json = JSON.stringify(response);
    const parsed = JSON.parse(json);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result.agentName).toBe('test-agent');
  });

  it('should produce valid JSON-RPC error response', () => {
    const response = {
      jsonrpc: '2.0' as const,
      id: 1,
      error: {
        code: JsonRpcErrorCode.METHOD_NOT_FOUND,
        message: 'Method not found',
      },
    };

    const json = JSON.stringify(response);
    const parsed = JSON.parse(json);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.error.code).toBe(-32601);
    expect(parsed.error.message).toBe('Method not found');
  });

  it('should produce valid JSON-RPC notification (no id)', () => {
    const notification = {
      jsonrpc: '2.0' as const,
      method: AcpNotification.TASK_STATUS,
      params: {
        taskId: 'task-123',
        status: 'completed',
      },
    };

    const json = JSON.stringify(notification);
    const parsed = JSON.parse(json);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('notifications/task/status');
    expect(parsed.id).toBeUndefined();
  });
});
