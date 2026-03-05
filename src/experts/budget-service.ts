/**
 * BudgetService - Manages agent credit accounts and spending.
 *
 * Stores budget data in workspace/budgets.json.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type {
  AgentAccount,
  BudgetRegistry,
  RechargeOptions,
  SetDailyLimitOptions,
  DeductCreditsOptions,
  DeductResult,
} from './types.js';

const logger = createLogger('BudgetService');

/**
 * BudgetService configuration.
 */
export interface BudgetServiceConfig {
  /** Storage file path (default: workspace/budgets.json) */
  filePath?: string;
}

/**
 * Service for managing agent credit accounts.
 *
 * Features:
 * - Create and manage agent accounts
 * - Track balance and daily limits
 * - Deduct credits for consultations
 * - Recharge accounts
 */
export class BudgetService {
  private filePath: string;
  private registry: BudgetRegistry;

  constructor(config: BudgetServiceConfig = {}) {
    this.filePath = config.filePath || path.join(process.cwd(), 'workspace', 'budgets.json');
    this.registry = this.load();
  }

  /**
   * Get today's date string for daily reset tracking.
   */
  private getTodayString(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Reset daily usage if a new day has started.
   */
  private resetDailyIfNeeded(account: AgentAccount): void {
    const today = this.getTodayString();
    if (account.lastResetDate !== today) {
      account.usedToday = 0;
      account.lastResetDate = today;
      logger.debug({ agentId: account.agentId }, 'Daily usage reset');
    }
  }

  /**
   * Load registry from file.
   */
  private load(): BudgetRegistry {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(content) as BudgetRegistry;
        logger.info({ accountCount: Object.keys(data.accounts || {}).length }, 'Budget registry loaded');
        return data;
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to load budget registry, starting fresh');
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
      logger.debug({ accountCount: Object.keys(this.registry.accounts).length }, 'Budget registry saved');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save budget registry');
    }
  }

  /**
   * Get or create an account for an agent.
   *
   * @param agentId - Agent identifier
   * @param initialBalance - Initial balance for new accounts (default: 0)
   * @param dailyLimit - Daily limit for new accounts (default: 100)
   * @returns The agent account
   */
  getOrCreateAccount(agentId: string, initialBalance = 0, dailyLimit = 100): AgentAccount {
    let account = this.registry.accounts[agentId];

    if (!account) {
      const now = Date.now();
      account = {
        agentId,
        balance: initialBalance,
        dailyLimit,
        usedToday: 0,
        lastResetDate: this.getTodayString(),
        createdAt: now,
        updatedAt: now,
      };
      this.registry.accounts[agentId] = account;
      this.save();
      logger.info({ agentId, initialBalance, dailyLimit }, 'Account created');
    } else {
      this.resetDailyIfNeeded(account);
    }

    return account;
  }

  /**
   * Get an account without creating one.
   *
   * @param agentId - Agent identifier
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
   * Recharge an agent's account.
   *
   * @param options - Recharge options
   * @returns Updated account or undefined if account doesn't exist
   */
  recharge(options: RechargeOptions): AgentAccount | undefined {
    const { agentId, credits } = options;

    if (credits <= 0) {
      logger.warn({ agentId, credits }, 'Invalid recharge amount: must be positive');
      return undefined;
    }

    const account = this.getAccount(agentId);

    if (!account) {
      logger.warn({ agentId }, 'Cannot recharge: account not found');
      return undefined;
    }

    account.balance += credits;
    account.updatedAt = Date.now();
    this.save();

    logger.info({ agentId, credits, newBalance: account.balance }, 'Account recharged');
    return account;
  }

  /**
   * Set daily limit for an agent.
   *
   * @param options - Set daily limit options
   * @returns Updated account or undefined
   */
  setDailyLimit(options: SetDailyLimitOptions): AgentAccount | undefined {
    const { agentId, dailyLimit } = options;

    if (dailyLimit < 0) {
      logger.warn({ agentId, dailyLimit }, 'Invalid daily limit: must be non-negative');
      return undefined;
    }

    const account = this.getAccount(agentId);

    if (!account) {
      logger.warn({ agentId }, 'Cannot set daily limit: account not found');
      return undefined;
    }

    account.dailyLimit = dailyLimit;
    account.updatedAt = Date.now();
    this.save();

    logger.info({ agentId, dailyLimit }, 'Daily limit set');
    return account;
  }

  /**
   * Deduct credits from an agent's account.
   *
   * @param options - Deduct options
   * @returns Deduction result
   */
  deduct(options: DeductCreditsOptions): DeductResult {
    const { agentId, credits, description } = options;

    if (credits <= 0) {
      logger.warn({ agentId, credits }, 'Invalid deduction amount: must be positive');
      return { success: false, error: 'insufficient_balance' };
    }

    const account = this.getAccount(agentId);

    if (!account) {
      logger.warn({ agentId }, 'Cannot deduct: account not found');
      return { success: false, error: 'account_not_found' };
    }

    // Check balance
    if (account.balance < credits) {
      logger.info({ agentId, credits, balance: account.balance }, 'Insufficient balance');
      return { success: false, error: 'insufficient_balance' };
    }

    // Check daily limit
    if (account.usedToday + credits > account.dailyLimit) {
      logger.info(
        { agentId, credits, usedToday: account.usedToday, dailyLimit: account.dailyLimit },
        'Daily limit exceeded'
      );
      return { success: false, error: 'daily_limit_exceeded' };
    }

    // Deduct
    account.balance -= credits;
    account.usedToday += credits;
    account.updatedAt = Date.now();
    this.save();

    logger.info({ agentId, credits, newBalance: account.balance, description }, 'Credits deducted');
    return { success: true, newBalance: account.balance };
  }

  /**
   * Check if an agent can afford a certain amount.
   *
   * @param agentId - Agent identifier
   * @param credits - Amount to check
   * @returns Whether the agent can afford it
   */
  canAfford(agentId: string, credits: number): boolean {
    const account = this.getAccount(agentId);
    if (!account) {
      return false;
    }

    return account.balance >= credits && account.usedToday + credits <= account.dailyLimit;
  }

  /**
   * List all accounts.
   *
   * @returns Array of all accounts
   */
  listAccounts(): AgentAccount[] {
    // Reset daily usage for all accounts
    for (const account of Object.values(this.registry.accounts)) {
      this.resetDailyIfNeeded(account);
    }
    return Object.values(this.registry.accounts);
  }

  /**
   * Delete an account.
   *
   * @param agentId - Agent identifier
   * @returns Whether the account was deleted
   */
  deleteAccount(agentId: string): boolean {
    if (this.registry.accounts[agentId]) {
      delete this.registry.accounts[agentId];
      this.save();
      logger.info({ agentId }, 'Account deleted');
      return true;
    }
    return false;
  }

  /**
   * Get the storage file path.
   */
  getFilePath(): string {
    return this.filePath;
  }
}

// Singleton instance for convenience
let defaultInstance: BudgetService | undefined;

/**
 * Get the default BudgetService instance.
 */
export function getBudgetService(): BudgetService {
  if (!defaultInstance) {
    defaultInstance = new BudgetService();
  }
  return defaultInstance;
}
