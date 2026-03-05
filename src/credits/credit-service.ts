/**
 * CreditService - Manages agent credits accounts.
 *
 * Stores credits accounts in workspace/credits.json.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type {
  AgentAccount,
  CreditsRegistry,
  CreateAccountOptions,
  DeductResult,
  RechargeOptions,
  SetDailyLimitOptions,
  DeductCreditsOptions,
  CreditServiceConfig,
} from './types.js';

const logger = createLogger('CreditService');

/**
 * Get the start of today (midnight) in milliseconds.
 */
function getTodayStart(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * Service for managing agent credits accounts.
 *
 * Features:
 * - Create/manage agent accounts
 * - Recharge credits
 * - Deduct credits with balance and daily limit checks
 * - Set daily spending limits
 */
export class CreditService {
  private filePath: string;
  private registry: CreditsRegistry;
  private defaultDailyLimit: number;
  private defaultInitialBalance: number;

  constructor(config: CreditServiceConfig = {}) {
    this.filePath = config.filePath || path.join(process.cwd(), 'workspace', 'credits.json');
    this.defaultDailyLimit = config.defaultDailyLimit ?? 100;
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
   * Reset daily usage if a new day has started.
   */
  private resetDailyIfNeeded(account: AgentAccount): void {
    const todayStart = getTodayStart();
    if (account.lastResetAt < todayStart) {
      account.usedToday = 0;
      account.lastResetAt = todayStart;
      logger.info({ agentId: account.agentId }, 'Daily usage reset');
    }
  }

  /**
   * Create a new agent account.
   *
   * @param options - Account creation options
   * @returns The created account
   */
  createAccount(options: CreateAccountOptions): AgentAccount {
    const { agentId, initialBalance, dailyLimit } = options;
    const now = Date.now();
    const todayStart = getTodayStart();

    // Check if account already exists
    if (this.registry.accounts[agentId]) {
      logger.info({ agentId }, 'Account already exists');
      return this.registry.accounts[agentId];
    }

    // Create new account
    const account: AgentAccount = {
      agentId,
      balance: initialBalance ?? this.defaultInitialBalance,
      dailyLimit: dailyLimit ?? this.defaultDailyLimit,
      usedToday: 0,
      lastResetAt: todayStart,
      createdAt: now,
      updatedAt: now,
    };

    this.registry.accounts[agentId] = account;
    this.save();

    logger.info({ agentId, balance: account.balance }, 'Account created');
    return account;
  }

  /**
   * Get an account by agent ID.
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
   * Check if an account exists.
   *
   * @param agentId - Agent identifier
   */
  hasAccount(agentId: string): boolean {
    return agentId in this.registry.accounts;
  }

  /**
   * Get or create an account.
   *
   * @param agentId - Agent identifier
   * @returns The account
   */
  getOrCreateAccount(agentId: string): AgentAccount {
    if (this.hasAccount(agentId)) {
      return this.getAccount(agentId)!;
    }
    return this.createAccount({ agentId });
  }

  /**
   * Recharge credits to an account.
   *
   * @param options - Recharge options
   * @returns Updated account or undefined if not found
   */
  recharge(options: RechargeOptions): AgentAccount | undefined {
    const { agentId, credits } = options;
    const account = this.registry.accounts[agentId];

    if (!account) {
      logger.warn({ agentId }, 'Cannot recharge: account not found');
      return undefined;
    }

    this.resetDailyIfNeeded(account);
    account.balance += credits;
    account.updatedAt = Date.now();
    this.save();

    logger.info({ agentId, credits, newBalance: account.balance }, 'Account recharged');
    return account;
  }

  /**
   * Set daily limit for an account.
   *
   * @param options - Set daily limit options
   * @returns Updated account or undefined if not found
   */
  setDailyLimit(options: SetDailyLimitOptions): AgentAccount | undefined {
    const { agentId, dailyLimit } = options;
    const account = this.registry.accounts[agentId];

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
   * Deduct credits from an account.
   *
   * Checks both balance and daily limit before deducting.
   *
   * @param options - Deduct options
   * @returns Deduction result
   */
  deduct(options: DeductCreditsOptions): DeductResult {
    const { agentId, credits } = options;
    const account = this.registry.accounts[agentId];

    if (!account) {
      logger.warn({ agentId }, 'Cannot deduct: account not found');
      return { success: false, remainingBalance: 0, error: 'account_not_found' };
    }

    this.resetDailyIfNeeded(account);

    // Check balance
    if (account.balance < credits) {
      logger.info({ agentId, credits, balance: account.balance }, 'Insufficient balance');
      return { success: false, remainingBalance: account.balance, error: 'insufficient_balance' };
    }

    // Check daily limit
    if (account.usedToday + credits > account.dailyLimit) {
      logger.info(
        { agentId, credits, usedToday: account.usedToday, dailyLimit: account.dailyLimit },
        'Daily limit exceeded'
      );
      return { success: false, remainingBalance: account.balance, error: 'daily_limit_exceeded' };
    }

    // Deduct
    account.balance -= credits;
    account.usedToday += credits;
    account.updatedAt = Date.now();
    this.save();

    logger.info({ agentId, credits, remainingBalance: account.balance }, 'Credits deducted');
    return { success: true, remainingBalance: account.balance };
  }

  /**
   * List all accounts.
   *
   * @returns Array of all accounts
   */
  listAccounts(): AgentAccount[] {
    return Object.values(this.registry.accounts).map((account) => {
      this.resetDailyIfNeeded(account);
      return account;
    });
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
}
