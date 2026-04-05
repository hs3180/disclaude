/**
 * Tests for ACP protocol type definitions.
 *
 * Issue #1333: ACP protocol infrastructure — PR A.
 */

import { describe, it, expect } from 'vitest';
import {
  AcpMethod,
  isAcpInitializeRequest,
  isAcpSessionUpdateNotification,
} from '../types.js';
import type { JsonRpcRequest, JsonRpcNotification } from '../json-rpc.js';

describe('AcpMethod', () => {
  it('should have all required method names', () => {
    expect(AcpMethod.Initialize).toBe('initialize');
    expect(AcpMethod.NewSession).toBe('newSession');
    expect(AcpMethod.ListSessions).toBe('listSessions');
    expect(AcpMethod.LoadSession).toBe('loadSession');
    expect(AcpMethod.CloseSession).toBe('closeSession');
    expect(AcpMethod.Prompt).toBe('prompt');
    expect(AcpMethod.SessionUpdate).toBe('sessionUpdate');
  });
});

describe('isAcpInitializeRequest', () => {
  it('should identify initialize requests', () => {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'disclaude', version: '1.0.0' },
        capabilities: { streaming: true },
      },
    };

    expect(isAcpInitializeRequest(req)).toBe(true);
  });

  it('should reject non-initialize requests', () => {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'prompt',
      params: {},
    };

    expect(isAcpInitializeRequest(req)).toBe(false);
  });
});

describe('isAcpSessionUpdateNotification', () => {
  it('should identify sessionUpdate notifications', () => {
    const notif: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'sessionUpdate',
      params: {
        sessionId: 'abc-123',
        update: { type: 'text', text: 'Hello' },
      },
    };

    expect(isAcpSessionUpdateNotification(notif)).toBe(true);
  });

  it('should reject non-sessionUpdate notifications', () => {
    const notif: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'otherNotification',
      params: {},
    };

    expect(isAcpSessionUpdateNotification(notif)).toBe(false);
  });
});

describe('ACP Type compatibility', () => {
  it('should support AcpUserMessage with string content', () => {
    const message = {
      role: 'user' as const,
      content: 'Hello, world!',
    };

    expect(message.role).toBe('user');
    expect(typeof message.content).toBe('string');
  });

  it('should support AcpUserMessage with content blocks', () => {
    const message = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'Hello' },
        { type: 'image' as const, data: 'base64data', mimeType: 'image/png' },
      ],
    };

    expect(message.role).toBe('user');
    expect(Array.isArray(message.content)).toBe(true);
    expect(message.content).toHaveLength(2);
  });

  it('should support AcpPromptParams', () => {
    const params = {
      sessionId: 'session-123',
      message: { role: 'user' as const, content: 'Hello' },
      stream: false,
    };

    expect(params.sessionId).toBe('session-123');
    expect(params.stream).toBe(false);
  });

  it('should support AcpPromptResult', () => {
    const result = {
      stopReason: 'end_turn' as const,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalCost: 0.005,
      },
    };

    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(100);
  });
});
