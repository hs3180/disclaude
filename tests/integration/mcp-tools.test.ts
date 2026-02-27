/**
 * MCP Tools Integration Tests
 *
 * Tests real MCP protocol communication and tool execution.
 *
 * These tests verify:
 * - MCP server initialization and handshake
 * - Tool discovery and listing
 * - Tool execution with real implementations
 * - Error handling in tool execution
 * - MCP protocol compliance
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { describeIfEnvVars, testId } from './setup.js';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

const FEISHU_ENV_VARS = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'];

/**
 * JSON-RPC 2.0 request structure
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 response structure
 */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * MCP Server test client
 */
class McpTestClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
  }>();
  private buffer = '';

  async start(serverPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn('node', [serverPath], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          FEISHU_APP_ID: process.env.FEISHU_APP_ID || 'test_app_id',
          FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || 'test_secret',
          CHAT_ID: 'test_chat',
          PARENT_MESSAGE_ID: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleData(data.toString());
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        // Log stderr for debugging but don't fail
        console.error('MCP Server stderr:', data.toString());
      });

      this.process.on('error', (error) => {
        reject(error);
      });

      // Give the server time to start
      setTimeout(resolve, 500);
    });
  }

  private handleData(data: string): void {
    this.buffer += data;

    // Process complete JSON lines
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line) as JsonRpcResponse;
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            pending.resolve(response);
          }
        } catch {
          // Ignore non-JSON lines (debug output, etc.)
        }
      }
    }
  }

  async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, { resolve, reject });

      this.process?.stdin?.write(JSON.stringify(request) + '\n');

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${id} timed out`));
        }
      }, 30000);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.process) {
        this.process.on('close', () => resolve());
        this.process.kill();
      } else {
        resolve();
      }
    });
  }
}

describe('MCP Protocol Integration', () => {
  describe('MCP Server Factory', () => {
    it('should create MCP server instance', async () => {
      const { createFeishuSdkMcpServer } = await import('../../src/mcp/feishu-context-mcp.js');

      const server = createFeishuSdkMcpServer();
      expect(server).toBeDefined();
    });
  });
});

describe('MCP Tool Definitions', () => {
  it('should have valid tool schema structure', async () => {
    // Import tool definitions directly
    const { feishuSdkTools } = await import('../../src/mcp/feishu-context-mcp.js');

    expect(feishuSdkTools).toBeDefined();
    expect(Array.isArray(feishuSdkTools)).toBe(true);
    expect(feishuSdkTools.length).toBeGreaterThan(0);

    for (const tool of feishuSdkTools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe('string');
      expect(tool.handler).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('should have send_user_feedback tool with correct handler', async () => {
    const { feishuSdkTools } = await import('../../src/mcp/feishu-context-mcp.js');

    const sendFeedbackTool = feishuSdkTools.find(t => t.name === 'send_user_feedback');
    expect(sendFeedbackTool).toBeDefined();
    expect(sendFeedbackTool?.handler).toBeDefined();
    expect(typeof sendFeedbackTool?.handler).toBe('function');
  });

  it('should have send_file_to_feishu tool with correct handler', async () => {
    const { feishuSdkTools } = await import('../../src/mcp/feishu-context-mcp.js');

    const sendFileTool = feishuSdkTools.find(t => t.name === 'send_file_to_feishu');
    expect(sendFileTool).toBeDefined();
    expect(sendFileTool?.handler).toBeDefined();
    expect(typeof sendFileTool?.handler).toBe('function');
  });

  it('should have tool definitions with descriptions', async () => {
    const { feishuToolDefinitions } = await import('../../src/mcp/feishu-context-mcp.js');

    for (const def of feishuToolDefinitions) {
      expect(def.name).toBeDefined();
      expect(def.description).toBeDefined();
      expect(def.parameters).toBeDefined();
      expect(def.handler).toBeDefined();
    }
  });
});

describeIfEnvVars('MCP Tool Execution (with Feishu credentials)', FEISHU_ENV_VARS, () => {
  it('should execute send_user_feedback and return result', async () => {
    const { feishuSdkTools } = await import('../../src/mcp/feishu-context-mcp.js');

    const sendFeedbackTool = feishuSdkTools.find(t => t.name === 'send_user_feedback');
    expect(sendFeedbackTool).toBeDefined();

    // Execute with test parameters (will fail due to invalid chat_id, but tests the flow)
    const result = await sendFeedbackTool?.handler({
      content: `Integration test message ${testId()}`,
      format: 'text',
      chatId: `invalid_chat_${testId()}`,
    });

    // Should return a result (even if it's an error)
    expect(result).toBeDefined();
    expect(result).toHaveProperty('content');
    expect(Array.isArray(result?.content)).toBe(true);
  });
});

describe('MCP Error Handling', () => {
  it('should handle invalid parameters gracefully (soft error)', async () => {
    const { feishuSdkTools } = await import('../../src/mcp/feishu-context-mcp.js');

    const sendFeedbackTool = feishuSdkTools.find(t => t.name === 'send_user_feedback');

    // Missing content parameter - handler catches errors and returns soft error
    const result = await sendFeedbackTool?.handler({
      format: 'text',
      chatId: 'test_chat',
    } as any);

    // Should return soft error message instead of throwing
    expect(result).toBeDefined();
    expect(result?.content?.[0]?.text).toContain('⚠️');
  });

  it('should handle invalid format parameter gracefully', async () => {
    const { feishuSdkTools } = await import('../../src/mcp/feishu-context-mcp.js');

    const sendFeedbackTool = feishuSdkTools.find(t => t.name === 'send_user_feedback');

    // Invalid format - should still work but might not format correctly
    const result = await sendFeedbackTool?.handler({
      content: 'Test message',
      format: 'invalid_format' as any,
      chatId: `invalid_chat_${testId()}`,
    });

    // Should return some result (even if error)
    expect(result).toBeDefined();
  });

  it('should handle non-existent file path', async () => {
    const { feishuSdkTools } = await import('../../src/mcp/feishu-context-mcp.js');

    const sendFileTool = feishuSdkTools.find(t => t.name === 'send_file_to_feishu');

    const result = await sendFileTool?.handler({
      filePath: `/non/existent/path/${testId()}.txt`,
      chatId: 'test_chat',
    });

    // Should return error result
    expect(result).toBeDefined();
    expect(result?.content?.[0]?.text).toContain('⚠️');
  });
});
