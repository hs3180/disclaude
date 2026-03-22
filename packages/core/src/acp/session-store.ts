/**
 * ACP Session Store - 会话存储管理
 *
 * 管理所有 ACP 会话的创建、查询、更新和销毁。
 * 使用内存存储，可扩展为文件存储或数据库存储。
 *
 * @module acp/session-store
 */

import type {
  AcpSessionInfo,
  AcpSessionOptions,
  AcpSessionState,
  AcpListSessionsOptions,
  AcpListSessionsResult,
} from './types.js';
import { randomUUID } from 'crypto';

/**
 * 会话存储条目（包含完整会话上下文）
 */
interface SessionStoreEntry {
  info: AcpSessionInfo;
  options: AcpSessionOptions;
  /** 内部 SDK session ID（如果有） */
  sdkSessionId?: string;
}

/**
 * ACP 会话存储
 *
 * 提供线程安全的会话 CRUD 操作。
 * 当前实现为内存存储，会话在进程重启后丢失。
 */
export class AcpSessionStore {
  private sessions = new Map<string, SessionStoreEntry>();

  /**
   * 创建新会话
   */
  create(options: AcpSessionOptions = {}): AcpSessionInfo {
    const sessionId = randomUUID();
    const now = new Date().toISOString();

    const info: AcpSessionInfo = {
      sessionId,
      cwd: options.cwd,
      title: options.cwd ? `Session ${sessionId.slice(0, 8)}` : undefined,
      createdAt: now,
      updatedAt: now,
      state: 'idle',
      mode: options.mode,
    };

    this.sessions.set(sessionId, { info, options });
    return info;
  }

  /**
   * 获取会话信息
   *
   * @throws 如果会话不存在
   */
  get(sessionId: string): AcpSessionInfo {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return { ...entry.info };
  }

  /**
   * 检查会话是否存在
   */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * 更新会话状态
   */
  updateState(sessionId: string, state: AcpSessionState): AcpSessionInfo {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    entry.info.state = state;
    entry.info.updatedAt = new Date().toISOString();
    return { ...entry.info };
  }

  /**
   * 更新会话标题
   */
  updateTitle(sessionId: string, title: string): AcpSessionInfo {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    entry.info.title = title;
    entry.info.updatedAt = new Date().toISOString();
    return { ...entry.info };
  }

  /**
   * 更新会话模式
   */
  updateMode(sessionId: string, mode: string): AcpSessionInfo {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    entry.info.mode = mode;
    entry.info.updatedAt = new Date().toISOString();
    return { ...entry.info };
  }

  /**
   * 存储或更新 SDK session ID
   */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    entry.sdkSessionId = sdkSessionId;
  }

  /**
   * 获取 SDK session ID
   */
  getSdkSessionId(sessionId: string): string | undefined {
    const entry = this.sessions.get(sessionId);
    return entry?.sdkSessionId;
  }

  /**
   * 获取会话选项
   */
  getOptions(sessionId: string): AcpSessionOptions {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return { ...entry.options };
  }

  /**
   * 删除会话
   *
   * @returns 是否成功删除
   */
  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * 列出会话
   */
  list(options: AcpListSessionsOptions = {}): AcpListSessionsResult {
    let entries = [...this.sessions.values()];

    // 按工作目录过滤
    if (options.cwd) {
      entries = entries.filter(e => e.info.cwd === options.cwd);
    }

    // 按更新时间倒序排列
    entries.sort((a, b) =>
      new Date(b.info.updatedAt).getTime() - new Date(a.info.updatedAt).getTime()
    );

    // 分页
    const limit = options.limit ?? 50;
    entries = entries.slice(0, limit);

    return {
      sessions: entries.map(e => ({ ...e.info })),
      nextCursor: entries.length >= limit ? `offset:${limit}` : undefined,
    };
  }

  /**
   * 获取会话总数
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * 清空所有会话
   */
  clear(): void {
    this.sessions.clear();
  }
}
