/**
 * Temporary Session Management - 临时会话管理工具
 *
 * 提供临时会话的创建、读取、更新和查询功能。
 * 会话以 YAML 文件形式存储在 temporary-sessions/ 目录中。
 *
 * @see Issue #1391 - 临时会话管理系统（简化版设计）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { createLogger } from './logger.js';

const logger = createLogger('TemporarySession');

// ============================================================================
// Types
// ============================================================================

/**
 * 会话状态
 */
export type SessionStatus = 'pending' | 'active' | 'expired';

/**
 * 交互选项
 */
export interface SessionOption {
  value: string;
  text: string;
}

/**
 * 群聊创建配置
 */
export interface CreateGroupConfig {
  name: string;
  members?: string[];
}

/**
 * 用户响应
 */
export interface SessionResponse {
  selectedValue: string;
  responder: string;
  respondedAt: string;
}

/**
 * 临时会话定义（创建时）
 */
export interface TemporarySessionConfig {
  /** 会话状态 */
  status: SessionStatus;
  /** 群聊 ID（创建后填充） */
  chatId: string | null;
  /** 消息 ID（发送后填充） */
  messageId: string | null;
  /** 过期时间 (ISO 8601) */
  expiresAt: string;

  /** 群聊创建配置 */
  createGroup: CreateGroupConfig;
  /** 消息内容（Markdown） */
  message: string;
  /** 交互选项 */
  options: SessionOption[];
  /** 上下文信息（调用方自定义） */
  context: Record<string, unknown>;

  /** 用户响应（用户操作后填充） */
  response?: SessionResponse | null;
}

/**
 * 临时会话（运行时）
 */
export interface TemporarySession extends TemporarySessionConfig {
  /** 会话 ID（文件名，不含扩展名） */
  id: string;
  /** 文件路径 */
  filePath: string;
}

/**
 * 创建会话的选项
 */
export interface CreateSessionOptions {
  /** 会话 ID（可选，自动生成） */
  id?: string;
  /** 群聊名称 */
  name: string;
  /** 群聊成员 */
  members?: string[];
  /** 消息内容 */
  message: string;
  /** 交互选项 */
  options: SessionOption[];
  /** 上下文信息 */
  context: Record<string, unknown>;
  /** 超时时间（分钟，默认 60） */
  timeoutMinutes?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** 默认会话目录 */
const DEFAULT_SESSIONS_DIR = 'temporary-sessions';

/** 默认超时时间（分钟） */
const DEFAULT_TIMEOUT_MINUTES = 60;

// ============================================================================
// Session Manager Class
// ============================================================================

/**
 * 临时会话管理器
 */
export class TemporarySessionManager {
  private sessionsDir: string;

  /**
   * @param baseDir - 基础目录（默认为当前工作目录）
   */
  constructor(baseDir?: string) {
    this.sessionsDir = path.join(baseDir || process.cwd(), DEFAULT_SESSIONS_DIR);
    this.ensureDirectory();
  }

  /**
   * 确保会话目录存在
   */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
      logger.info({ dir: this.sessionsDir }, 'Sessions directory created');
    }
  }

  /**
   * 生成会话 ID
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `session-${timestamp}-${random}`;
  }

  /**
   * 获取会话文件路径
   */
  private getFilePath(id: string): string {
    return path.join(this.sessionsDir, `${id}.yaml`);
  }

  /**
   * 创建新会话
   *
   * @param options - 会话创建选项
   * @returns 创建的会话
   */
  create(options: CreateSessionOptions): TemporarySession {
    const id = options.id || this.generateId();
    const filePath = this.getFilePath(id);

    // 检查是否已存在
    if (fs.existsSync(filePath)) {
      throw new Error(`Session already exists: ${id}`);
    }

    // 计算过期时间
    const timeoutMinutes = options.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES;
    const expiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();

    // 构建会话配置
    const config: TemporarySessionConfig = {
      status: 'pending',
      chatId: null,
      messageId: null,
      expiresAt,
      createGroup: {
        name: options.name,
        members: options.members,
      },
      message: options.message,
      options: options.options,
      context: options.context,
      response: null,
    };

    // 写入文件
    this.writeFile(filePath, config);

    logger.info({ id, name: options.name }, 'Session created');

    return {
      id,
      filePath,
      ...config,
    };
  }

  /**
   * 获取会话
   *
   * @param id - 会话 ID
   * @returns 会话或 undefined
   */
  get(id: string): TemporarySession | undefined {
    const filePath = this.getFilePath(id);

    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    const config = this.readFile(filePath);

    return {
      id,
      filePath,
      ...config,
    };
  }

  /**
   * 更新会话
   *
   * @param id - 会话 ID
   * @param updates - 更新内容
   * @returns 更新后的会话或 undefined
   */
  update(id: string, updates: Partial<TemporarySessionConfig>): TemporarySession | undefined {
    const filePath = this.getFilePath(id);

    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    const existing = this.readFile(filePath);
    const updated = { ...existing, ...updates };

    this.writeFile(filePath, updated);

    logger.info({ id, updates: Object.keys(updates) }, 'Session updated');

    return {
      id,
      filePath,
      ...updated,
    };
  }

  /**
   * 删除会话
   *
   * @param id - 会话 ID
   * @returns 是否删除成功
   */
  delete(id: string): boolean {
    const filePath = this.getFilePath(id);

    if (!fs.existsSync(filePath)) {
      return false;
    }

    fs.unlinkSync(filePath);
    logger.info({ id }, 'Session deleted');
    return true;
  }

  /**
   * 根据 messageId 查找会话
   *
   * @param messageId - 消息 ID
   * @returns 会话或 undefined
   */
  findByMessageId(messageId: string): TemporarySession | undefined {
    const files = this.listFiles();

    for (const file of files) {
      const config = this.readFile(file);
      if (config.messageId === messageId) {
        const id = path.basename(file, '.yaml');
        return {
          id,
          filePath: file,
          ...config,
        };
      }
    }

    return undefined;
  }

  /**
   * 根据 chatId 查找会话
   *
   * @param chatId - 群聊 ID
   * @returns 会话或 undefined
   */
  findByChatId(chatId: string): TemporarySession | undefined {
    const files = this.listFiles();

    for (const file of files) {
      const config = this.readFile(file);
      if (config.chatId === chatId) {
        const id = path.basename(file, '.yaml');
        return {
          id,
          filePath: file,
          ...config,
        };
      }
    }

    return undefined;
  }

  /**
   * 列出所有指定状态的会话
   *
   * @param status - 会话状态
   * @returns 会话列表
   */
  listByStatus(status: SessionStatus): TemporarySession[] {
    const files = this.listFiles();
    const sessions: TemporarySession[] = [];

    for (const file of files) {
      const config = this.readFile(file);
      if (config.status === status) {
        const id = path.basename(file, '.yaml');
        sessions.push({
          id,
          filePath: file,
          ...config,
        });
      }
    }

    return sessions;
  }

  /**
   * 检查并更新超时会话
   *
   * @returns 更新为 expired 的会话数量
   */
  checkExpired(): number {
    const files = this.listFiles();
    const now = Date.now();
    let expiredCount = 0;

    for (const file of files) {
      const config = this.readFile(file);

      // 只检查 active 状态的会话
      if (config.status !== 'active') {
        continue;
      }

      const expiresAt = new Date(config.expiresAt).getTime();
      if (now > expiresAt) {
        const id = path.basename(file, '.yaml');
        this.update(id, { status: 'expired' });
        expiredCount++;
        logger.info({ id }, 'Session expired');
      }
    }

    return expiredCount;
  }

  /**
   * 记录用户响应
   *
   * @param id - 会话 ID
   * @param response - 用户响应
   * @returns 更新后的会话或 undefined
   */
  recordResponse(id: string, response: SessionResponse): TemporarySession | undefined {
    return this.update(id, {
      status: 'expired',
      response,
    });
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  /**
   * 列出所有会话文件
   */
  private listFiles(): string[] {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    return fs
      .readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => path.join(this.sessionsDir, f));
  }

  /**
   * 读取会话文件
   */
  private readFile(filePath: string): TemporarySessionConfig {
    const content = fs.readFileSync(filePath, 'utf-8');
    return yaml.load(content) as TemporarySessionConfig;
  }

  /**
   * 写入会话文件
   */
  private writeFile(filePath: string, config: TemporarySessionConfig): void {
    const content = yaml.dump(config, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultManager: TemporarySessionManager | undefined;

/**
 * 获取默认会话管理器
 */
export function getSessionManager(): TemporarySessionManager {
  if (!defaultManager) {
    defaultManager = new TemporarySessionManager();
  }
  return defaultManager;
}

/**
 * 重置默认会话管理器（用于测试）
 */
export function resetSessionManager(): void {
  defaultManager = undefined;
}
