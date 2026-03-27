/**
 * ACP 类型定义测试
 *
 * 验证 JSON-RPC 2.0 类型和 ACP 协议类型的正确性。
 * 使用编译时类型检查 + 运行时结构验证。
 *
 * @module sdk/providers/acp/types.test
 */

import { describe, it, expect } from 'vitest';
import {
  AcpMethod,
  JsonRpcErrorCode,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  type JsonRpcNotification,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpMessage,
  type AcpContentBlock,
  type AcpTransportConfig,
} from './types.js';

describe('ACP Types', () => {
  describe('JsonRpcErrorCode', () => {
    it('should define standard JSON-RPC error codes', () => {
      expect(JsonRpcErrorCode.PARSE_ERROR).toBe(-32700);
      expect(JsonRpcErrorCode.INVALID_REQUEST).toBe(-32600);
      expect(JsonRpcErrorCode.METHOD_NOT_FOUND).toBe(-32601);
      expect(JsonRpcErrorCode.INVALID_PARAMS).toBe(-32602);
      expect(JsonRpcErrorCode.INTERNAL_ERROR).toBe(-32603);
    });
  });

  describe('AcpMethod', () => {
    it('should define all ACP methods', () => {
      expect(AcpMethod.INITIALIZE).toBe('acp/initialize');
      expect(AcpMethod.TASK_SEND).toBe('acp/task/send');
      expect(AcpMethod.TASK_CANCEL).toBe('acp/task/cancel');
      expect(AcpMethod.TASK_STATUS).toBe('acp/task/status');
      expect(AcpMethod.NOTIFICATION_MESSAGE).toBe('acp/notification/message');
      expect(AcpMethod.NOTIFICATION_PROGRESS).toBe('acp/notification/progress');
      expect(AcpMethod.NOTIFICATION_COMPLETE).toBe('acp/notification/complete');
      expect(AcpMethod.NOTIFICATION_ERROR).toBe('acp/notification/error');
    });
  });

  describe('JsonRpcRequest', () => {
    it('should validate a valid request structure', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'acp/task/send',
        params: { taskId: 'test-123' },
      };

      expect(request.jsonrpc).toBe('2.0');
      expect(request.id).toBe(1);
      expect(request.method).toBe('acp/task/send');
      expect(request.params).toEqual({ taskId: 'test-123' });
    });

    it('should support string IDs', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 'uuid-123',
        method: 'acp/initialize',
      };

      expect(typeof request.id).toBe('string');
    });

    it('should allow optional params', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'acp/task/cancel',
      };

      expect(request.params).toBeUndefined();
    });
  });

  describe('JsonRpcSuccessResponse', () => {
    it('should validate a success response structure', () => {
      const response: JsonRpcSuccessResponse = {
        jsonrpc: '2.0',
        id: 1,
        result: { status: 'ok' },
      };

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toEqual({ status: 'ok' });
    });
  });

  describe('JsonRpcErrorResponse', () => {
    it('should validate an error response structure', () => {
      const response: JsonRpcErrorResponse = {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: JsonRpcErrorCode.METHOD_NOT_FOUND,
          message: 'Method not found',
          data: { method: 'unknown/method' },
        },
      };

      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toBe('Method not found');
      expect(response.error.data).toEqual({ method: 'unknown/method' });
    });
  });

  describe('JsonRpcNotification', () => {
    it('should validate a notification structure (no id)', () => {
      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'acp/notification/message',
        params: { taskId: 'task-1', message: { role: 'assistant', content: 'Hello' } },
      };

      expect('id' in notification).toBe(false);
      expect(notification.method).toBe('acp/notification/message');
    });
  });

  describe('AcpInitializeParams', () => {
    it('should validate initialize params structure', () => {
      const params: AcpInitializeParams = {
        clientName: 'disclaude',
        clientVersion: '0.1.0',
        capabilities: {
          inputFormats: ['text', 'content_blocks'],
          toolFormats: ['tool_use', 'tool_result'],
          streaming: true,
        },
      };

      expect(params.clientName).toBe('disclaude');
      expect(params.capabilities.streaming).toBe(true);
    });
  });

  describe('AcpInitializeResult', () => {
    it('should validate initialize result structure', () => {
      const result: AcpInitializeResult = {
        serverName: 'openai-acp',
        serverVersion: '1.0.0',
        protocolVersion: '2025-01-01',
        capabilities: {
          models: [
            { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxOutputTokens: 16384 },
          ],
          toolUse: true,
          streaming: true,
        },
      };

      expect(result.protocolVersion).toBe('2025-01-01');
      expect(result.capabilities.models).toHaveLength(1);
      expect(result.capabilities.models?.[0].id).toBe('gpt-4o');
    });
  });

  describe('AcpMessage', () => {
    it('should support text content', () => {
      const message: AcpMessage = {
        role: 'user',
        content: 'Hello, world!',
      };

      expect(message.role).toBe('user');
      expect(message.content).toBe('Hello, world!');
    });

    it('should support content blocks', () => {
      const message: AcpMessage = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me search for that.' },
          { type: 'tool_use', name: 'Bash', toolUseId: 'tool-1', input: { command: 'ls' } },
        ],
      };

      expect(Array.isArray(message.content)).toBe(true);
      const blocks = message.content as AcpContentBlock[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('text');
      expect(blocks[1].type).toBe('tool_use');
    });
  });

  describe('AcpContentBlock', () => {
    it('should support all content block types', () => {
      const textBlock: AcpContentBlock = { type: 'text', text: 'Hello' };
      const imageBlock: AcpContentBlock = { type: 'image', data: 'base64...', mimeType: 'image/png' };
      const toolUseBlock: AcpContentBlock = { type: 'tool_use', name: 'Read', toolUseId: 't1', input: { file_path: '/tmp/test' } };
      const toolResultBlock: AcpContentBlock = { type: 'tool_result', toolUseIdResult: 't1', output: 'file contents...', isError: false };

      expect(textBlock.type).toBe('text');
      expect(imageBlock.type).toBe('image');
      expect(toolUseBlock.type).toBe('tool_use');
      expect(toolResultBlock.type).toBe('tool_result');
    });
  });

  describe('AcpTransportConfig', () => {
    it('should discriminate between stdio and sse config types', () => {
      const stdioConfig: AcpTransportConfig = {
        type: 'stdio',
        command: 'npx',
        args: ['@openai/acp-server'],
        env: { OPENAI_API_KEY: 'test-key' },
      };

      const sseConfig: AcpTransportConfig = {
        type: 'sse',
        url: 'http://localhost:8080/acp',
        authToken: 'bearer-token',
      };

      expect(stdioConfig.type).toBe('stdio');
      expect(sseConfig.type).toBe('sse');

      // Type narrowing
      if (stdioConfig.type === 'stdio') {
        expect(stdioConfig.command).toBe('npx');
      }
      if (sseConfig.type === 'sse') {
        expect(sseConfig.url).toBe('http://localhost:8080/acp');
      }
    });
  });
});
