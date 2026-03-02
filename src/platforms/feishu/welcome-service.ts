/**
 * Welcome Service - Manages welcome message sending with frequency control.
 *
 * Features:
 * - Track welcome message sent status per chat
 * - 24-hour frequency control to avoid spam
 * - Persistent storage in workspace directory
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('WelcomeService');

/**
 * Welcome record for a single chat.
 */
interface WelcomeRecord {
  /** Chat ID */
  chatId: string;
  /** Last welcome sent timestamp (ms since epoch) */
  lastSentAt: number;
  /** Number of times welcome was sent */
  sentCount: number;
}

/**
 * Welcome service storage format.
 */
interface WelcomeStorage {
  /** Version for future migrations */
  version: 1;
  /** Welcome records indexed by chat ID */
  records: Record<string, WelcomeRecord>;
}

/**
 * WelcomeService configuration.
 */
export interface WelcomeServiceConfig {
  /** Directory to store the welcome data file (default: workspace) */
  workspaceDir?: string;
  /** Cooldown period in milliseconds (default: 24 hours) */
  cooldownMs?: number;
}

/**
 * Default cooldown period: 24 hours.
 */
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Welcome message content.
 */
export const WELCOME_MESSAGES = {
  /** Agent usage guide */
  usageGuide: `👋 你好！我是 Agent 助手

我可以帮你：
- 🔍 搜索和读取文件
- 💻 执行代码和命令
- 📝 创建和编辑文件
- 🌐 搜索网络获取信息

直接告诉我你想做什么即可！`,

  /** Control commands list */
  controlCommands: `📋 控制指令：

群管理：
- /set-broadcast - 设为广播群（Bot 只发不收）
- /unset-broadcast - 取消广播群
- /set-log-chat - 设为日志群
- /list-broadcast - 列出广播群

对话控制：
- /reset - 重置对话
- /status - 查看状态
- /help - 查看帮助`,

  /** Combined welcome message */
  get fullWelcome(): string {
    return `${WELCOME_MESSAGES.usageGuide}\n\n${WELCOME_MESSAGES.controlCommands}`;
  },
};

/**
 * Greeting patterns to detect.
 */
export const GREETING_PATTERNS = [
  /^你好$/i,
  /^您好$/i,
  /^hi$/i,
  /^hello$/i,
  /^hey$/i,
  /^嗨$/i,
  /^哈喽$/i,
  /^早上好$/i,
  /^下午好$/i,
  /^晚上好$/i,
];

/**
 * WelcomeService - Manages welcome message sending.
 *
 * This service tracks when welcome messages were sent to each chat
 * and provides frequency control to avoid spamming users.
 */
export class WelcomeService {
  private workspaceDir: string;
  private cooldownMs: number;
  private storagePath: string;
  private storage: WelcomeStorage;
  private initialized = false;

  constructor(config: WelcomeServiceConfig = {}) {
    this.workspaceDir = config.workspaceDir || path.join(process.cwd(), 'workspace');
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.storagePath = path.join(this.workspaceDir, 'welcome-sent.json');
    this.storage = this.loadStorage();
  }

  /**
   * Initialize the service (create directory if needed).
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Ensure workspace directory exists
    if (!fs.existsSync(this.workspaceDir)) {
      await fs.promises.mkdir(this.workspaceDir, { recursive: true });
    }

    this.initialized = true;
    logger.info({ workspaceDir: this.workspaceDir }, 'WelcomeService initialized');
  }

  /**
   * Check if a welcome message should be sent to this chat.
   *
   * @param chatId - The chat ID to check
   * @returns true if welcome should be sent (not sent in last 24h)
   */
  shouldSendWelcome(chatId: string): boolean {
    const record = this.storage.records[chatId];
    if (!record) {
      return true;
    }

    const now = Date.now();
    const timeSinceLastSent = now - record.lastSentAt;

    return timeSinceLastSent >= this.cooldownMs;
  }

  /**
   * Record that a welcome message was sent to this chat.
   *
   * @param chatId - The chat ID to record
   */
  recordWelcomeSent(chatId: string): void {
    const now = Date.now();
    const existing = this.storage.records[chatId];

    this.storage.records[chatId] = {
      chatId,
      lastSentAt: now,
      sentCount: (existing?.sentCount ?? 0) + 1,
    };

    this.saveStorage();
    logger.debug({ chatId }, 'Welcome sent recorded');
  }

  /**
   * Check if text is a greeting message.
   *
   * @param text - The text to check
   * @returns true if text matches a greeting pattern
   */
  isGreeting(text: string): boolean {
    const trimmed = text.trim().toLowerCase();
    return GREETING_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  /**
   * Force reset welcome status for a chat (for testing).
   *
   * @param chatId - The chat ID to reset
   */
  resetChat(chatId: string): void {
    delete this.storage.records[chatId];
    this.saveStorage();
  }

  /**
   * Clear all welcome records (for testing).
   */
  clearAll(): void {
    this.storage.records = {};
    this.saveStorage();
  }

  /**
   * Get statistics about welcome messages.
   */
  getStats(): { totalChats: number; totalSends: number } {
    const records = Object.values(this.storage.records);
    return {
      totalChats: records.length,
      totalSends: records.reduce((sum, r) => sum + r.sentCount, 0),
    };
  }

  /**
   * Load storage from file.
   */
  private loadStorage(): WelcomeStorage {
    try {
      if (fs.existsSync(this.storagePath)) {
        const content = fs.readFileSync(this.storagePath, 'utf-8');
        const data = JSON.parse(content) as WelcomeStorage;
        // Validate version
        if (data.version === 1 && data.records) {
          return data;
        }
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to load welcome storage, starting fresh');
    }

    // Return default empty storage
    return {
      version: 1,
      records: {},
    };
  }

  /**
   * Save storage to file.
   */
  private saveStorage(): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const content = JSON.stringify(this.storage, null, 2);
      fs.writeFileSync(this.storagePath, content, 'utf-8');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save welcome storage');
    }
  }
}
