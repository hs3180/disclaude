/**
 * CreditService - Manages Agent credit accounts and billing.
 *
 * Implements the credit system for expert consultations:
 * - Agent accounts with balance and daily limits
 * - Expert pricing
 * - Billing on consultation
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
  /** Agent ID (chat_id or channel_id) */
  agentId: string;
  /** Current balance */
  balance: number;
  /** Daily spending limit (0 = unlimited) */
  dailyLimit: number;
  /** Amount spent today */
  usedToday: number;
  /** Last reset date (YYYY-MM-DD) */
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
  /** Expert ID (if consultation) */
  expertId?: string;
  /** Transaction type */
  type: 'recharge' | 'consultation' | 'refund' | 'admin_adjust';
  /** Amount (positive = credit, negative = debit) */
  amount: number;
  /** Balance after transaction */
  balanceAfter: number;
  /** Description */
  description: string;
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
  /** Default balance for new accounts */
  defaultBalance?: number;
}

/**
 * Result of a billing attempt.
 */
export interface BillingResult {
  success: boolean;
  error?: 'insufficient_balance' | 'daily_limit_exceeded' | 'account_not_found';
  message?: string;
  newBalance?: number;
  transactionId?: string;
}

/**
 * Service for managing Agent credits and billing.
 *
 * Features:
 * - Create/manage Agent accounts
 * - Recharge credits
 * - Bill for consultations
 * - Track daily limits
 */
export class CreditService {
  private filePath: string;
  private registry: CreditRegistry;
  private defaultDailyLimit: number;
  private defaultBalance: number;

  constructor(config: CreditServiceConfig = {}) {
    this.filePath = config.filePath || path.join(process.cwd(), 'workspace', 'credits.json');
    this.defaultDailyLimit = config.defaultDailyLimit ?? 1000;
    this.defaultBalance = config.defaultBalance ?? 100;
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
   * Get today's date string (YYYY-MM-DD).
   */
  private getTodayString(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Generate a unique transaction ID.
   */
  private generateTransactionId(): string {
    return `txn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Reset daily usage if needed.
   */
  private resetDailyIfNeeded(account: AgentAccount): void {
    const today = this.getTodayString();
    if (account.lastResetDate !== today) {
      account.usedToday = 0;
      account.lastResetDate = today;
      account.updatedAt = Date.now();
      logger.info({ agentId: account.agentId }, 'Daily usage reset');
    }
  }

  /**
   * Get or create an Agent account.
   *
   * @param agentId - Agent ID (chat_id or channel_id)
   * @returns The Agent account
   */
  getOrCreateAccount(agentId: string): AgentAccount {
    let account = this.registry.accounts[agentId];

    if (!account) {
      const now = Date.now();
      account = {
        agentId,
        balance: this.defaultBalance,
        dailyLimit: this.defaultDailyLimit,
        usedToday: 0,
        lastResetDate: this.getTodayString(),
        createdAt: now,
        updatedAt: now,
      };
      this.registry.accounts[agentId] = account;
      this.save();
      logger.info({ agentId, balance: account.balance }, 'New Agent account created');
    } else {
      this.resetDailyIfNeeded(account);
    }

    return account;
  }

  /**
   * Get an Agent account.
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
   * Recharge an Agent account.
   *
   * @param agentId - Agent ID
   * @param amount - Amount to add
   * @param description - Optional description
   * @returns Updated account
   */
  recharge(agentId: string, amount: number, description: string = '管理员充值'): AgentAccount {
    const account = this.getOrCreateAccount(agentId);
    const previousBalance = account.balance;

    account.balance += amount;
    account.updatedAt = Date.now();

    // Record transaction
    const transaction: CreditTransaction = {
      id: this.generateTransactionId(),
      agentId,
      type: 'recharge',
      amount,
      balanceAfter: account.balance,
      description,
      timestamp: Date.now(),
    };
    this.registry.transactions.push(transaction);

    this.save();
    logger.info({ agentId, amount, newBalance: account.balance }, 'Account recharged');

    return account;
  }

  /**
   * Set daily limit for an Agent.
   *
   * @param agentId - Agent ID
   * @param limit - Daily limit (0 = unlimited)
   * @returns Updated account or undefined
   */
  setDailyLimit(agentId: string, limit: number): AgentAccount | undefined {
    const account = this.registry.accounts[agentId];
    if (!account) {
      logger.warn({ agentId }, 'Cannot set limit: account not found');
      return undefined;
    }

    this.resetDailyIfNeeded(account);
    account.dailyLimit = limit;
    account.updatedAt = Date.now();
    this.save();
    logger.info({ agentId, limit }, 'Daily limit set');

    return account;
  }

  /**
   * Bill an Agent for a consultation.
   *
   * @param agentId - Agent ID
   * @param expertId - Expert ID
   * @param amount - Amount to bill
   * @returns Billing result
   */
  bill(agentId: string, expertId: string, amount: number): BillingResult {
    const account = this.registry.accounts[agentId];

    if (!account) {
      return {
        success: false,
        error: 'account_not_found',
        message: 'Agent 账户不存在',
      };
    }

    this.resetDailyIfNeeded(account);

    // Check balance
    if (account.balance < amount) {
      return {
        success: false,
        error: 'insufficient_balance',
        message: `积分不足。当前余额: ${account.balance}, 需要: ${amount}`,
      };
    }

    // Check daily limit
    if (account.dailyLimit > 0 && account.usedToday + amount > account.dailyLimit) {
      const remaining = account.dailyLimit - account.usedToday;
      return {
        success: false,
        error: 'daily_limit_exceeded',
        message: `已超过每日限额。今日剩余可用: ${remaining}, 本次需要: ${amount}`,
      };
    }

    // Deduct balance
    account.balance -= amount;
    account.usedToday += amount;
    account.updatedAt = Date.now();

    // Record transaction
    const transaction: CreditTransaction = {
      id: this.generateTransactionId(),
      agentId,
      expertId,
      type: 'consultation',
      amount: -amount,
      balanceAfter: account.balance,
      description: `咨询专家 ${expertId}`,
      timestamp: Date.now(),
    };
    this.registry.transactions.push(transaction);

    this.save();
    logger.info({ agentId, expertId, amount, newBalance: account.balance }, 'Consultation billed');

    return {
      success: true,
      newBalance: account.balance,
      transactionId: transaction.id,
    };
  }

  /**
   * Refund a transaction.
   *
   * @param transactionId - Transaction ID to refund
   * @param reason - Refund reason
   * @returns Updated account or undefined
   */
  refund(transactionId: string, reason: string): AgentAccount | undefined {
    const transaction = this.registry.transactions.find(t => t.id === transactionId);
    if (!transaction || transaction.type !== 'consultation') {
      logger.warn({ transactionId }, 'Cannot refund: transaction not found or not refundable');
      return undefined;
    }

    const account = this.registry.accounts[transaction.agentId];
    if (!account) {
      return undefined;
    }

    // Refund the amount (transaction.amount is negative for consultations)
    const refundAmount = Math.abs(transaction.amount);
    account.balance += refundAmount;
    account.usedToday = Math.max(0, account.usedToday - refundAmount);
    account.updatedAt = Date.now();

    // Record refund transaction
    const refundTransaction: CreditTransaction = {
      id: this.generateTransactionId(),
      agentId: transaction.agentId,
      expertId: transaction.expertId,
      type: 'refund',
      amount: refundAmount,
      balanceAfter: account.balance,
      description: `退款: ${reason}`,
      timestamp: Date.now(),
    };
    this.registry.transactions.push(refundTransaction);

    this.save();
    logger.info({ transactionId, refundAmount, newBalance: account.balance }, 'Transaction refunded');

    return account;
  }

  /**
   * Get transaction history for an Agent.
   *
   * @param agentId - Agent ID
   * @param limit - Maximum number of transactions to return
   * @returns Array of transactions
   */
  getTransactionHistory(agentId: string, limit: number = 10): CreditTransaction[] {
    return this.registry.transactions
      .filter(t => t.agentId === agentId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Check if an Agent can afford a consultation.
   *
   * @param agentId - Agent ID
   * @param amount - Amount to check
   * @returns Whether the Agent can afford it
   */
  canAfford(agentId: string, amount: number): boolean {
    const account = this.getAccount(agentId);
    if (!account) {
      return false;
    }

    if (account.balance < amount) {
      return false;
    }

    if (account.dailyLimit > 0 && account.usedToday + amount > account.dailyLimit) {
      return false;
    }

    return true;
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
