/**
 * CreditService - Manages Agent credit accounts and transactions.
 *
 * Provides credit balance management for Agent accounts with:
 * - Balance tracking
 * - Daily spending limits
 * - Recharge functionality
 * - Transaction logging
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CreditService');

/**
 * Agent credit account.
 */
export interface AgentAccount {
  /** Agent identifier */
  agentId: string;
  /** Current balance in credits */
  balance: number;
  /** Daily spending limit (0 = unlimited) */
  dailyLimit: number;
  /** Amount spent today */
  usedToday: number;
  /** Last reset date for daily usage (YYYY-MM-DD) */
  lastResetDate: string;
  /** Account creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Credit transaction record.
 */
export interface CreditTransaction {
  /** Transaction ID */
  id: string;
  /** Agent ID */
  agentId: string;
  /** Transaction type */
  type: 'spend' | 'recharge' | 'refund' | 'adjust';
  /** Amount (positive for credit, negative for debit) */
  amount: number;
  /** Balance after transaction */
  balanceAfter: number;
  /** Description */
  description: string;
  /** Related expert ID (for consultation transactions) */
  expertId?: string;
  /** Transaction timestamp */
  timestamp: number;
}

/**
 * Credit registry storage format.
 */
interface CreditRegistry {
  /** Version for future migrations */
  version: number;
  /** Agent accounts indexed by agentId */
  accounts: Record<string, AgentAccount>;
  /** Transaction history */
  transactions: CreditTransaction[];
}

/**
 * CreditService configuration.
 */
export interface CreditServiceConfig {
  /** Storage file path (default: workspace/credits.json) */
  filePath?: string;
  /** Default daily limit for new accounts */
  defaultDailyLimit?: number;
  /** Initial balance for new accounts */
  initialBalance?: number;
  /** Maximum transactions to keep in history */
  maxTransactionHistory?: number;
}

/**
 * Result of a spend operation.
 */
export interface SpendResult {
  success: boolean;
  error?: 'insufficient_balance' | 'daily_limit_exceeded' | 'account_not_found';
  newBalance?: number;
  transaction?: CreditTransaction;
}

/**
 * Service for managing Agent credit accounts.
 *
 * Features:
 * - Create and manage agent accounts
 * - Spend credits with balance and limit checks
 * - Recharge credits
 * - Track transaction history
 */
export class CreditService {
  private filePath: string;
  private registry: CreditRegistry;
  private defaultDailyLimit: number;
  private initialBalance: number;
  private maxTransactionHistory: number;

  constructor(config: CreditServiceConfig = {}) {
    this.filePath = config.filePath || path.join(process.cwd(), 'workspace', 'credits.json');
    this.defaultDailyLimit = config.defaultDailyLimit ?? 0; // 0 = unlimited
    this.initialBalance = config.initialBalance ?? 0;
    this.maxTransactionHistory = config.maxTransactionHistory ?? 1000;
    this.registry = this.load();
  }

  /**
   * Load registry from file.
   */
  private load(): CreditRegistry {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(content) as CreditRegistry;
        logger.info({ accountCount: Object.keys(data.accounts || {}).length }, 'Credit registry loaded');
        return data;
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to load credit registry, starting fresh');
    }
    return { version: 1, accounts: {}, transactions: [] };
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
      logger.debug({ accountCount: Object.keys(this.registry.accounts).length }, 'Credit registry saved');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save credit registry');
    }
  }

  /**
   * Get today's date string for daily reset check.
   */
  private getTodayString(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Reset daily usage if needed.
   */
  private resetDailyUsageIfNeeded(account: AgentAccount): void {
    const today = this.getTodayString();
    if (account.lastResetDate !== today) {
      account.usedToday = 0;
      account.lastResetDate = today;
      logger.debug({ agentId: account.agentId }, 'Daily usage reset');
    }
  }

  /**
   * Generate a unique transaction ID.
   */
  private generateTransactionId(): string {
    return `txn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Add a transaction to history.
   */
  private addTransaction(transaction: CreditTransaction): void {
    this.registry.transactions.push(transaction);
    // Trim history if needed
    if (this.registry.transactions.length > this.maxTransactionHistory) {
      this.registry.transactions = this.registry.transactions.slice(-this.maxTransactionHistory);
    }
  }

  /**
   * Create or get an agent account.
   *
   * @param agentId - Agent identifier
   * @returns The agent account
   */
  getOrCreateAccount(agentId: string): AgentAccount {
    let account = this.registry.accounts[agentId];

    if (!account) {
      const now = Date.now();
      account = {
        agentId,
        balance: this.initialBalance,
        dailyLimit: this.defaultDailyLimit,
        usedToday: 0,
        lastResetDate: this.getTodayString(),
        createdAt: now,
        updatedAt: now,
      };
      this.registry.accounts[agentId] = account;
      this.save();
      logger.info({ agentId, initialBalance: this.initialBalance }, 'Account created');
    }

    this.resetDailyUsageIfNeeded(account);
    return account;
  }

  /**
   * Get an agent account.
   *
   * @param agentId - Agent identifier
   * @returns Account or undefined
   */
  getAccount(agentId: string): AgentAccount | undefined {
    const account = this.registry.accounts[agentId];
    if (account) {
      this.resetDailyUsageIfNeeded(account);
    }
    return account;
  }

  /**
   * Check if an agent can spend a certain amount.
   *
   * @param agentId - Agent identifier
   * @param amount - Amount to spend
   * @returns Whether the spend is allowed
   */
  canSpend(agentId: string, amount: number): boolean {
    const account = this.getAccount(agentId);
    if (!account) {
      return false;
    }

    // Check balance
    if (account.balance < amount) {
      return false;
    }

    // Check daily limit (0 = unlimited)
    if (account.dailyLimit > 0 && account.usedToday + amount > account.dailyLimit) {
      return false;
    }

    return true;
  }

  /**
   * Spend credits from an agent account.
   *
   * @param agentId - Agent identifier
   * @param amount - Amount to spend
   * @param description - Transaction description
   * @param expertId - Related expert ID (optional)
   * @returns Spend result
   */
  spend(agentId: string, amount: number, description: string, expertId?: string): SpendResult {
    const account = this.getAccount(agentId);

    if (!account) {
      return { success: false, error: 'account_not_found' };
    }

    // Check balance
    if (account.balance < amount) {
      logger.warn({ agentId, amount, balance: account.balance }, 'Insufficient balance');
      return { success: false, error: 'insufficient_balance' };
    }

    // Check daily limit
    if (account.dailyLimit > 0 && account.usedToday + amount > account.dailyLimit) {
      logger.warn(
        { agentId, amount, usedToday: account.usedToday, dailyLimit: account.dailyLimit },
        'Daily limit exceeded'
      );
      return { success: false, error: 'daily_limit_exceeded' };
    }

    // Perform spend
    account.balance -= amount;
    account.usedToday += amount;
    account.updatedAt = Date.now();

    const transaction: CreditTransaction = {
      id: this.generateTransactionId(),
      agentId,
      type: 'spend',
      amount: -amount,
      balanceAfter: account.balance,
      description,
      expertId,
      timestamp: Date.now(),
    };

    this.addTransaction(transaction);
    this.save();

    logger.info({ agentId, amount, newBalance: account.balance }, 'Credits spent');
    return { success: true, newBalance: account.balance, transaction };
  }

  /**
   * Recharge credits to an agent account.
   *
   * @param agentId - Agent identifier
   * @param amount - Amount to add
   * @param description - Transaction description
   * @returns Updated account or undefined
   */
  recharge(agentId: string, amount: number, description: string = '管理员充值'): AgentAccount | undefined {
    const account = this.getOrCreateAccount(agentId);

    if (amount <= 0) {
      logger.warn({ agentId, amount }, 'Invalid recharge amount');
      return undefined;
    }

    account.balance += amount;
    account.updatedAt = Date.now();

    const transaction: CreditTransaction = {
      id: this.generateTransactionId(),
      agentId,
      type: 'recharge',
      amount,
      balanceAfter: account.balance,
      description,
      timestamp: Date.now(),
    };

    this.addTransaction(transaction);
    this.save();

    logger.info({ agentId, amount, newBalance: account.balance }, 'Credits recharged');
    return account;
  }

  /**
   * Refund credits to an agent account.
   *
   * @param agentId - Agent identifier
   * @param amount - Amount to refund
   * @param description - Transaction description
   * @param expertId - Related expert ID (optional)
   * @returns Updated account or undefined
   */
  refund(agentId: string, amount: number, description: string, expertId?: string): AgentAccount | undefined {
    const account = this.getAccount(agentId);

    if (!account) {
      logger.warn({ agentId }, 'Cannot refund: account not found');
      return undefined;
    }

    if (amount <= 0) {
      logger.warn({ agentId, amount }, 'Invalid refund amount');
      return undefined;
    }

    account.balance += amount;
    // Reduce daily usage if refund is for today's spend
    const today = this.getTodayString();
    if (account.lastResetDate === today) {
      account.usedToday = Math.max(0, account.usedToday - amount);
    }
    account.updatedAt = Date.now();

    const transaction: CreditTransaction = {
      id: this.generateTransactionId(),
      agentId,
      type: 'refund',
      amount,
      balanceAfter: account.balance,
      description,
      expertId,
      timestamp: Date.now(),
    };

    this.addTransaction(transaction);
    this.save();

    logger.info({ agentId, amount, newBalance: account.balance }, 'Credits refunded');
    return account;
  }

  /**
   * Set daily limit for an agent.
   *
   * @param agentId - Agent identifier
   * @param limit - Daily limit (0 = unlimited)
   * @returns Updated account or undefined
   */
  setDailyLimit(agentId: string, limit: number): AgentAccount | undefined {
    const account = this.getOrCreateAccount(agentId);

    if (limit < 0) {
      logger.warn({ agentId, limit }, 'Invalid daily limit');
      return undefined;
    }

    account.dailyLimit = limit;
    account.updatedAt = Date.now();
    this.save();

    logger.info({ agentId, limit }, 'Daily limit set');
    return account;
  }

  /**
   * List all agent accounts.
   *
   * @returns Array of agent accounts
   */
  listAccounts(): AgentAccount[] {
    return Object.values(this.registry.accounts);
  }

  /**
   * Get transaction history for an agent.
   *
   * @param agentId - Agent identifier
   * @param limit - Maximum transactions to return
   * @returns Array of transactions
   */
  getTransactionHistory(agentId: string, limit: number = 50): CreditTransaction[] {
    return this.registry.transactions
      .filter(t => t.agentId === agentId)
      .slice(-limit);
  }

  /**
   * Get the storage file path.
   */
  getFilePath(): string {
    return this.filePath;
  }
}

// Singleton instance
let defaultInstance: CreditService | undefined;

/**
 * Get the default CreditService instance.
 */
export function getCreditService(): CreditService {
  if (!defaultInstance) {
    defaultInstance = new CreditService();
  }
  return defaultInstance;
}
