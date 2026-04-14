/**
 * ACP Transport 层实现
 *
 * 提供 stdio 传输层和可注入的 IAcpTransport 接口。
 * AcpStdioTransport 通过 child_process spawn 与 claude-agent-acp 通信。
 */

import { spawn } from 'node:child_process';
import { createLogger } from '../../utils/logger.js';
import type {
  JsonRpcRequest,
  JsonRpcMessage,
  JsonRpcNotification,
} from './types.js';

const logger = createLogger('AcpStdioTransport');

// ============================================================================
// 错误类
// ============================================================================

/** ACP 传输和协议错误 */
export class AcpError extends Error {
  code: number;

  constructor(message: string, code: number = -1) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
  }
}

// ============================================================================
// Handler 类型
// ============================================================================

/** 接收 JSON-RPC 消息的回调 */
export type AcpMessageHandler = (message: JsonRpcMessage) => void;

/** 接收传输错误的回调 */
export type AcpErrorHandler = (error: Error) => void;

/** 接收连接关闭事件的回调 */
export type AcpCloseHandler = () => void;

// ============================================================================
// IAcpTransport 接口
// ============================================================================

/** 可注入的 ACP Transport 接口 */
export interface IAcpTransport {
  /** 连接到 Agent 进程 */
  connect(): Promise<void>;
  /** 发送 JSON-RPC 消息（序列化为 NDJSON） */
  send(message: JsonRpcRequest | JsonRpcNotification): void;
  /** 断开连接 */
  disconnect(): Promise<void>;
  /** 注册消息处理器 */
  onMessage(handler: AcpMessageHandler): void;
  /** 注册错误处理器 */
  onError(handler: AcpErrorHandler): void;
  /** 注册关闭处理器 */
  onClose(handler: AcpCloseHandler): void;
  /** 是否已连接 */
  get connected(): boolean;
}

// ============================================================================
// NDJSON Buffer 解析（纯函数，便于测试）
// ============================================================================

/**
 * 解析 NDJSON 数据流。
 * 将新数据追加到 buffer，按 \n 分割出完整行，保留未完成的部分。
 *
 * @param buffer - 当前缓冲区内容
 * @param data - 新接收的数据
 * @returns lines: 完整行数组, remaining: 剩余未完成的 buffer
 */
export function parseNdjsonBuffer(
  buffer: string,
  data: string,
): { lines: string[]; remaining: string } {
  const combined = buffer + data;
  const parts = combined.split('\n');

  // 最后一个元素是可能不完整的行
  const remaining = parts.pop() ?? '';

  // 过滤空行
  const lines = parts.filter((line) => line.trim().length > 0);

  return { lines, remaining };
}

// ============================================================================
// JSON-RPC 辅助函数
// ============================================================================

/** 创建 JSON-RPC 请求 */
export function createRequest(
  method: string,
  params: unknown,
  id: number,
): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

/** 创建 JSON-RPC 通知（无 id） */
export function createNotification(
  method: string,
  params: unknown,
): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

/** 类型守卫：是否为 JSON-RPC 响应（成功或错误） */
export function isResponse(
  msg: JsonRpcMessage,
): msg is JsonRpcRequest extends { id: infer I }
  ? { jsonrpc: '2.0'; id: I; result: unknown } | { jsonrpc: '2.0'; id: I; error: { code: number; message: string } }
  : never {
  return 'id' in msg && ('result' in msg || 'error' in msg);
}

/** 类型守卫：是否为 JSON-RPC 通知 */
export function isNotification(
  msg: JsonRpcMessage,
): msg is JsonRpcNotification {
  return !('id' in msg) && 'method' in msg;
}

// ============================================================================
// AcpStdioTransport 配置
// ============================================================================

/** AcpStdioTransport 配置 */
export interface AcpStdioTransportConfig {
  /** 要 spawn 的命令（如 'claude-agent-acp'） */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 子进程环境变量 */
  env?: Record<string, string | undefined>;
  /** 子进程工作目录 */
  cwd?: string;
}

// ============================================================================
// AcpStdioTransport 实现
// ============================================================================

/** 通过 stdio 与 ACP Agent 通信的 Transport */
export class AcpStdioTransport implements IAcpTransport {
  private config: AcpStdioTransportConfig;
  private _connected = false;
  private childProcess: ReturnType<typeof spawn> | null = null;
  private buffer = '';
  private messageHandlers: AcpMessageHandler[] = [];
  private errorHandlers: AcpErrorHandler[] = [];
  private closeHandlers: AcpCloseHandler[] = [];

  constructor(config: AcpStdioTransportConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    const env = { ...process.env, ...this.config.env };
    const childProc = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.config.cwd,
    });
    this.childProcess = childProc;

    childProc.stdout.on('data', (data: Buffer) => {
      this.handleStdoutData(data.toString());
    });

    childProc.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        // Issue #2349: Detect unknown option errors and log them prominently
        if (text.includes('unknown option') || text.includes('error:')) {
          logger.error({ stderr: text.slice(0, 500) }, 'Agent stderr (command error)');
        } else {
          logger.debug({ stderr: text.slice(0, 300) }, 'Agent stderr');
        }
      }
    });

    childProc.on('close', (code) => {
      logger.debug({ exitCode: code }, 'Agent process exited');
      this._connected = false;
      this.childProcess = null;
      for (const handler of this.closeHandlers) {
        handler();
      }
    });

    childProc.on('error', (err) => {
      logger.error({ error: err.message }, 'Agent process error');
      this._connected = false;
      for (const handler of this.errorHandlers) {
        handler(err);
      }
    });

    this._connected = true;
    // Yield to event loop so spawn errors can surface early
    await new Promise((resolve) => setImmediate(resolve));
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    if (!this._connected || !this.childProcess?.stdin) {
      throw new AcpError('Transport is not connected');
    }

    const line = `${JSON.stringify(message)}\n`;
    this.childProcess.stdin.write(line);
  }

  async disconnect(): Promise<void> {
    if (!this.childProcess) {
      return;
    }

    this.childProcess.kill();
    this.childProcess = null;
    this._connected = false;
    this.buffer = '';
    // Yield to event loop for clean shutdown
    await new Promise((resolve) => setImmediate(resolve));
  }

  onMessage(handler: AcpMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: AcpErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  onClose(handler: AcpCloseHandler): void {
    this.closeHandlers.push(handler);
  }

  private handleStdoutData(data: string): void {
    const { lines, remaining } = parseNdjsonBuffer(this.buffer, data);
    this.buffer = remaining;

    for (const line of lines) {
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        for (const handler of this.messageHandlers) {
          handler(message);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.debug({ line: line.slice(0, 200) }, 'Invalid JSON line');
        for (const handler of this.errorHandlers) {
          handler(error);
        }
      }
    }
  }
}
