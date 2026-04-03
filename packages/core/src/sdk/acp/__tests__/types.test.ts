/**
 * Unit tests for ACP types and constants
 */

import { describe, it, expect } from 'vitest';
import { JsonRpcErrorCode, AcpErrorCode } from '../types.js';

describe('ACP Types', () => {
  describe('JsonRpcErrorCode', () => {
    it('should have correct standard error codes', () => {
      expect(JsonRpcErrorCode.PARSE_ERROR).toBe(-32700);
      expect(JsonRpcErrorCode.INVALID_REQUEST).toBe(-32600);
      expect(JsonRpcErrorCode.METHOD_NOT_FOUND).toBe(-32601);
      expect(JsonRpcErrorCode.INVALID_PARAMS).toBe(-32602);
      expect(JsonRpcErrorCode.INTERNAL_ERROR).toBe(-32603);
    });
  });

  describe('AcpErrorCode', () => {
    it('should have correct ACP extension error codes', () => {
      expect(AcpErrorCode.AUTH_REQUIRED).toBe(-32000);
      expect(AcpErrorCode.RESOURCE_NOT_FOUND).toBe(-32002);
    });
  });

  describe('Content block types', () => {
    it('should allow creating text content blocks', () => {
      const block = { type: 'text' as const, text: 'Hello' };
      expect(block.type).toBe('text');
      expect(block.text).toBe('Hello');
    });

    it('should allow creating image content blocks', () => {
      const block = { type: 'image' as const, data: 'base64data', mimeType: 'image/png' };
      expect(block.type).toBe('image');
      expect(block.mimeType).toBe('image/png');
    });

    it('should allow creating resource link blocks', () => {
      const block = { type: 'resource_link' as const, uri: 'file:///path', name: 'file' };
      expect(block.type).toBe('resource_link');
      expect(block.uri).toBe('file:///path');
    });

    it('should allow creating audio content blocks', () => {
      const block = { type: 'audio' as const, data: 'base64audio', mimeType: 'audio/mp3' };
      expect(block.type).toBe('audio');
      expect(block.mimeType).toBe('audio/mp3');
    });
  });

  describe('Session update types', () => {
    it('should support agent_message_chunk update', () => {
      const update = {
        sessionUpdate: 'agent_message_chunk' as const,
        content: [{ type: 'text' as const, text: 'Hello' }],
      };
      expect(update.sessionUpdate).toBe('agent_message_chunk');
    });

    it('should support tool_call update', () => {
      const update = {
        sessionUpdate: 'tool_call' as const,
        toolCallId: 'call_001',
        title: 'Read file',
        kind: 'read' as const,
        status: 'pending' as const,
      };
      expect(update.sessionUpdate).toBe('tool_call');
      expect(update.kind).toBe('read');
      expect(update.status).toBe('pending');
    });

    it('should support tool_call_update with content', () => {
      const update = {
        sessionUpdate: 'tool_call_update' as const,
        toolCallId: 'call_001',
        status: 'completed' as const,
        content: [
          {
            type: 'content' as const,
            content: { type: 'text' as const, text: 'File content' },
          },
        ],
      };
      expect(update.sessionUpdate).toBe('tool_call_update');
      expect(update.status).toBe('completed');
      expect(update.content).toHaveLength(1);
    });

    it('should support usage_update', () => {
      const update = {
        sessionUpdate: 'usage_update' as const,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.001,
        },
      };
      expect(update.sessionUpdate).toBe('usage_update');
      expect(update.usage.inputTokens).toBe(100);
    });
  });

  describe('Connection config types', () => {
    it('should create minimal connection config', () => {
      const config = {
        agentCommand: '/usr/bin/node',
        clientInfo: { name: 'test-client', version: '1.0.0' },
      };
      expect(config.agentCommand).toBe('/usr/bin/node');
      expect(config.clientInfo.name).toBe('test-client');
    });

    it('should create full connection config', () => {
      const config = {
        agentCommand: '/usr/bin/node',
        agentArgs: ['agent.js'],
        agentEnv: { API_KEY: 'test' },
        clientInfo: { name: 'test', version: '1.0' },
        clientCapabilities: { fs: { readTextFile: true }, terminal: true },
        requestTimeout: 5000,
        initTimeout: 5000,
      };
      expect(config.clientCapabilities?.fs?.readTextFile).toBe(true);
      expect(config.requestTimeout).toBe(5000);
    });
  });
});
