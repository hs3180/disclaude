/**
 * CreditsService - Manages agent credits and billing for expert consultations.
 *
 * Tracks agent credit balances, daily limits, and handles billing when
 * agents consult human experts.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CreditsService');

/**
 * Agent credit account.
 */
export interface AgentAccount {
  /** Agent unique identifier */
  agentId: string;
  /** Agent display name */
  name?: string;
  /** Current credit balance */
  balance: number;
  /** Daily spending limit (0 = no limit) */
  dailyLimit: number;
  /** Amount spent today */
  spentToday: number;
  /** Last reset date for daily tracking (ISO date string) */
  lastResetDate: string;
  /** Account creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Credits registry storage format.
 */
interface CreditsRegistry {
  /** Version for future migrations */
  version: number;
  /** Agent accounts indexed by agentId */
  accounts: Record<string, AgentAccount>;
}

/**
 * CreditsService configuration.
 */
export interface CreditsServiceConfig {
  /** Storage file path (default: workspace/credits.json) */
  filePath?: string;
  /** Default daily limit for new accounts */
  defaultDailyLimit?: number;
  /** Default initial balance for new accounts */
  defaultInitialBalance?: number;
}

/**
 * Result of a credit deduction attempt.
 */
export interface DeductionResult {
  success: boolean;
  newBalance: number;
  remainingDaily: number;
  error?: string;
}

/**
 * Service for managing agent credits.
 *
 * Features:
 * - Create and manage agent accounts
 * - Track credit balances and daily limits
 * - Handle billing for expert consultations
 * - Admin functions for recharging and limits
 */
export class CreditsService {
  private filePath: string;
  private registry: CreditsRegistry;
  private defaultDailyLimit: number;
  private defaultInitialBalance: number;

  constructor(config: CreditsServiceConfig = {}) {
    this.filePath = config.filePath || path.join(process.cwd(), 'workspace', 'credits.json');
    this.defaultDailyLimit = config.defaultDailyLimit ?? 0; // 0 = no limit
    this.defaultInitialBalance = config.defaultInitialBalance ?? 0;
    this.registry = this.load();
  }

  /**
   * Load registry from file.
   */
  private load(): CreditsRegistry {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(content) as CreditsRegistry;
        logger.info({ accountCount: Object.keys(data.accounts || {}).length }, 'Credits registry loaded');
        return data;
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to load credits registry, starting fresh');
    }
    return { version: 1, accounts: {} };
  }

  /**
   * Save registry to file.
   */
  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.registry, null, 2));
      logger.debug({ accountCount: Object.keys(this.registry.accounts).length }, 'Credits registry saved');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save credits registry');
    }
  }

  /**
   * Get today's date as ISO string (YYYY-MM-DD).
   */
  private getTodayString(): string {
    const [date] = new Date().toISOString().split('T');
    return date;
  }

  /**
   * Reset daily spending if the date has changed.
   */
  private resetDailyIfNeeded(account: AgentAccount): void {
    const today = this.getTodayString();
    if (account.lastResetDate !== today) {
      account.spentToday = 0;
      account.lastResetDate = today;
      logger.info({ agentId: account.agentId }, 'Daily spending reset');
    }
  }

  /**
   * Create or get an agent account.
   *
   * @param agentId - Agent unique identifier
   * @param name - Optional display name
   * @returns The agent account
   */
  getOrCreateAccount(agentId: string, name?: string): AgentAccount {
    let account = this.registry.accounts[agentId];

    if (!account) {
      const now = Date.now();
      account = {
        agentId,
        name,
        balance: this.defaultInitialBalance,
        dailyLimit: this.defaultDailyLimit,
        spentToday: 0,
        lastResetDate: this.getTodayString(),
        createdAt: now,
        updatedAt: now,
      };
      this.registry.accounts[agentId] = account;
      this.save();
      logger.info({ agentId, name }, 'Agent account created');
    } else {
      this.resetDailyIfNeeded(account);
      if (name && account.name !== name) {
        account.name = name;
        account.updatedAt = Date.now();
        this.save();
      }
    }

    return account;
  }

  /**
   * Get an agent account.
   *
   * @param agentId - Agent ID
   * @returns Account or undefined
   */
  getAccount(agentId: string): AgentAccount | undefined {
    const account = this.registry.accounts[agentId];
    if (account) {
      this.resetDailyIfNeeded(account);
    }
    return account;
  }

  /**
   * Check if an agent can afford a consultation.
   *
   * @param agentId - Agent ID
   * @param amount - Required credits
   * @returns Whether the agent can afford it
   */
  canAfford(agentId: string, amount: number): boolean {
    const account = this.getAccount(agentId);
    if (!account) {
      return false;
    }

    // Check balance
    if (account.balance < amount) {
      return false;
    }

    // Check daily limit (0 = no limit)
    if (account.dailyLimit > 0 && account.spentToday + amount > account.dailyLimit) {
      return false;
    }

    return true;
  }

  /**
   * Deduct credits from an agent account.
   *
   * @param agentId - Agent ID
   * @param amount - Amount to deduct
   * @param description - Optional description for logging
   * @returns Deduction result
   */
  deductCredits(agentId: string, amount: number, description?: string): DeductionResult {
    const account = this.getAccount(agentId);

    if (!account) {
      return {
        success: false,
        newBalance: 0,
        remainingDaily: 0,
        error: 'Account not found',
      };
    }

    // Check balance
    if (account.balance < amount) {
      return {
        success: false,
        newBalance: account.balance,
        remainingDaily: account.dailyLimit > 0 ? account.dailyLimit - account.spentToday : Infinity,
        error: `Insufficient balance. Required: ${amount}, Available: ${account.balance}`,
      };
    }

    // Check daily limit
    if (account.dailyLimit > 0 && account.spentToday + amount > account.dailyLimit) {
      const remaining = account.dailyLimit - account.spentToday;
      return {
        success: false,
        newBalance: account.balance,
        remainingDaily: remaining,
        error: `Daily limit exceeded. Limit: ${account.dailyLimit}, Spent: ${account.spentToday}, Remaining: ${remaining}`,
      };
    }

    // Deduct
    account.balance -= amount;
    account.spentToday += amount;
    account.updatedAt = Date.now();
    this.save();

    logger.info({ agentId, amount, description, newBalance: account.balance }, 'Credits deducted');

    return {
      success: true,
      newBalance: account.balance,
      remainingDaily: account.dailyLimit > 0 ? account.dailyLimit - account.spentToday : Infinity,
    };
  }

  /**
   * Add credits to an agent account (recharge).
   *
   * @param agentId - Agent ID
   * @param amount - Amount to add
   * @returns New balance or undefined if account not found
   */
  recharge(agentId: string, amount: number): number | undefined {
    const account = this.registry.accounts[agentId];
    if (!account) {
      logger.warn({ agentId }, 'Cannot recharge: account not found');
      return undefined;
    }

    account.balance += amount;
    account.updatedAt = Date.now();
    this.save();

    logger.info({ agentId, amount, newBalance: account.balance }, 'Account recharged');
    return account.balance;
  }

  /**
   * Set daily limit for an agent.
   *
   * @param agentId - Agent ID
   * @param limit - New daily limit (0 = no limit)
   * @returns Updated account or undefined
   */
  setDailyLimit(agentId: string, limit: number): AgentAccount | undefined {
    const account = this.registry.accounts[agentId];
    if (!account) {
      logger.warn({ agentId }, 'Cannot set limit: account not found');
      return undefined;
    }

    account.dailyLimit = Math.max(0, limit);
    account.updatedAt = Date.now();
    this.save();

    logger.info({ agentId, limit: account.dailyLimit }, 'Daily limit set');
    return account;
  }

  /**
   * List all agent accounts.
   *
   * @returns Array of accounts
   */
  listAccounts(): AgentAccount[] {
    return Object.values(this.registry.accounts).map(account => {
      this.resetDailyIfNeeded(account);
      return account;
    });
  }

  /**
   * Get the storage file path.
   */
  getFilePath(): string {
    return this.filePath;
  }
}

// Singleton instance
let defaultInstance: CreditsService | undefined;

/**
 * Get the default CreditsService instance.
 */
export function getCreditsService(): CreditsService {
  if (!defaultInstance) {
    defaultInstance = new CreditsService();
  }
  return defaultInstance;
}
