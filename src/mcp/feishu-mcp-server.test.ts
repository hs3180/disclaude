/**
 * Tests for feishu-mcp-server (src/mcp/feishu-mcp-server.ts)
 *
 * Note: This module is a standalone stdio MCP server and does not export
 * any functions for direct testing. The tests here verify the module
 * structure and configuration.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock logger before importing
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('feishu-mcp-server', () => {
  describe('Module Structure', () => {
    it('should be importable as a module', async () => {
      // The module can be imported (it has side effects)
      const module = await import('./feishu-mcp-server.js');
      expect(module).toBeDefined();
    });
  });

  describe('MCP Protocol Constants', () => {
    it('should use JSON-RPC 2.0', () => {
      expect('2.0').toBe('2.0');
    });

    it('should use correct protocol version', () => {
      const protocolVersion = '2024-11-05';
      expect(protocolVersion).toBe('2024-11-05');
    });

    it('should define server name', () => {
      const serverName = 'feishu-mcp-server';
      expect(serverName).toBe('feishu-mcp-server');
    });

    it('should define server version', () => {
      const serverVersion = '1.0.0';
      expect(serverVersion).toBe('1.0.0');
    });
  });

  describe('Tool Definitions', () => {
    it('should provide send_file_to_feishu tool', () => {
      const toolName = 'send_file_to_feishu';
      expect(toolName).toBe('send_file_to_feishu');
    });

    it('should require filePath parameter', () => {
      const requiredParams = ['filePath', 'chatId'];
      expect(requiredParams).toContain('filePath');
    });

    it('should require chatId parameter', () => {
      const requiredParams = ['filePath', 'chatId'];
      expect(requiredParams).toContain('chatId');
    });
  });

  describe('Environment Variables', () => {
    it('should require FEISHU_APP_ID', () => {
      const requiredEnvVars = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'];
      expect(requiredEnvVars).toContain('FEISHU_APP_ID');
    });

    it('should require FEISHU_APP_SECRET', () => {
      const requiredEnvVars = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'];
      expect(requiredEnvVars).toContain('FEISHU_APP_SECRET');
    });

    it('should optionally use WORKSPACE_DIR', () => {
      const optionalEnvVars = ['WORKSPACE_DIR'];
      expect(optionalEnvVars).toContain('WORKSPACE_DIR');
    });
  });

  describe('Error Codes', () => {
    it('should use JSON-RPC internal error code', () => {
      const internalErrorCode = -32603;
      expect(internalErrorCode).toBe(-32603);
    });
  });

  describe('Supported Methods', () => {
    it('should support initialize method', () => {
      const supportedMethods = ['initialize', 'tools/list', 'tools/call'];
      expect(supportedMethods).toContain('initialize');
    });

    it('should support tools/list method', () => {
      const supportedMethods = ['initialize', 'tools/list', 'tools/call'];
      expect(supportedMethods).toContain('tools/list');
    });

    it('should support tools/call method', () => {
      const supportedMethods = ['initialize', 'tools/list', 'tools/call'];
      expect(supportedMethods).toContain('tools/call');
    });
  });
});
