/**
 * Credit Manager - Manages agent credit accounts and expert pricing.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import type {
  AgentAccount,
  ExpertPricing,
  CreditTransaction,
  CreditSystemConfig,
  CreditOperationResult,
  ConsultationEligibility,
} from './types.js';

const logger = createLogger('CreditManager');

/**
 * Default credit system file name.
 */
const DEFAULT_CREDIT_FILE = 'credit-system.json';

/**
 * Default daily limit for new accounts.
 */
const DEFAULT_DAILY_LIMIT = 100;

/**
 * Generate a unique transaction ID.
 */
function generateTransactionId(): string {
  return `txn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Get today's date string (YYYY-MM-DD).
 */
function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Credit Manager - manages agent credit accounts and expert pricing.
 *
 * Features:
 * - Create and manage agent credit accounts
 * - Set expert pricing
 * - Process consultation charges
 * - Handle daily limit resets
 */
export class CreditManager {
  private config: CreditSystemConfig | null = null;
  private loaded = false;

  /**
   * Get the path to the credit system configuration file.
   */
  private getConfigPath(): string {
    const workspaceDir = Config.getWorkspaceDir();
    return path.join(workspaceDir, DEFAULT_CREDIT_FILE);
  }

  /**
   * Load the credit system configuration from file.
   */
  async load(): Promise<boolean> {
    try {
      const configPath = this.getConfigPath();

      try {
        await fs.access(configPath);
      } catch {
        logger.debug({ configPath }, 'Credit config file not found, using empty config');
        this.config = {
          accounts: [],
          expertPricing: [],
          transactions: [],
        };
        this.loaded = true;
        return true;
      }

      const content = await fs.readFile(configPath, 'utf-8');
      this.config = JSON.parse(content) as CreditSystemConfig;
      this.loaded = true;

      logger.info(
        { accountCount: this.config.accounts.length, pricingCount: this.config.expertPricing.length },
        'Credit config loaded'
      );
      return true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to load credit config');
      this.config = {
        accounts: [],
        expertPricing: [],
        transactions: [],
      };
      this.loaded = false;
      return false;
    }
  }

  /**
   * Save the current configuration to file.
   */
  private async save(): Promise<boolean> {
    if (!this.config) return false;

    try {
      const configPath = this.getConfigPath();
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      logger.debug({ configPath }, 'Credit config saved');
      return true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to save credit config');
      return false;
    }
  }

  /**
   * Ensure configuration is loaded.
   */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  /**
   * Reset daily usage if a new day has started.
   */
  private resetDailyIfNeeded(account: AgentAccount): void {
    const today = getTodayString();
    if (account.lastResetDate !== today) {
      account.usedToday = 0;
      account.lastResetDate = today;
      logger.debug({ agentId: account.agentId }, 'Daily usage reset');
    }
  }

  // ============================================================================
  // Agent Account Management
  // ============================================================================

  /**
   * Get or create an agent account.
   *
   * @param agentId - Agent identifier
   * @param name - Optional agent name
   * @returns Agent account
   */
  async getOrCreateAccount(agentId: string, name?: string): Promise<AgentAccount> {
    await this.ensureLoaded();

    let account = this.config!.accounts.find(a => a.agentId === agentId);

    if (!account) {
      account = {
        agentId,
        name,
        balance: 0,
        dailyLimit: DEFAULT_DAILY_LIMIT,
        usedToday: 0,
        lastResetDate: getTodayString(),
      };
      this.config!.accounts.push(account);
      await this.save();
      logger.info({ agentId }, 'New agent account created');
    } else {
      this.resetDailyIfNeeded(account);
      if (name && account.name !== name) {
        account.name = name;
        await this.save();
      }
    }

    return account;
  }

  /**
   * Get an agent account.
   *
   * @param agentId - Agent identifier
   * @returns Agent account or undefined
   */
  async getAccount(agentId: string): Promise<AgentAccount | undefined> {
    await this.ensureLoaded();
    const account = this.config!.accounts.find(a => a.agentId === agentId);
    if (account) {
      this.resetDailyIfNeeded(account);
    }
    return account;
  }

  /**
   * Recharge an agent account.
   *
   * @param agentId - Agent identifier
   * @param amount - Amount to add
   * @returns Operation result
   */
  async recharge(agentId: string, amount: number): Promise<CreditOperationResult> {
    await this.ensureLoaded();

    if (amount <= 0) {
      return { success: false, error: '充值金额必须大于 0' };
    }

    const account = await this.getOrCreateAccount(agentId);
    account.balance += amount;

    // Record transaction
    const transaction: CreditTransaction = {
      id: generateTransactionId(),
      timestamp: new Date().toISOString(),
      agentId,
      expertId: '',
      amount,
      type: 'recharge',
      description: `充值 ${amount} 积分`,
    };
    this.config!.transactions.push(transaction);
    this.trimTransactions();

    await this.save();
    logger.info({ agentId, amount, newBalance: account.balance }, 'Account recharged');

    return { success: true, newBalance: account.balance };
  }

  /**
   * Set daily limit for an agent.
   *
   * @param agentId - Agent identifier
   * @param limit - New daily limit
   * @returns Operation result
   */
  async setDailyLimit(agentId: string, limit: number): Promise<CreditOperationResult> {
    await this.ensureLoaded();

    if (limit < 0) {
      return { success: false, error: '每日上限不能为负数' };
    }

    const account = await this.getOrCreateAccount(agentId);
    account.dailyLimit = limit;
    await this.save();

    logger.info({ agentId, limit }, 'Daily limit set');
    return { success: true, newBalance: account.balance };
  }

  /**
   * Get all agent accounts.
   */
  async getAllAccounts(): Promise<AgentAccount[]> {
    await this.ensureLoaded();
    return [...this.config!.accounts];
  }

  // ============================================================================
  // Expert Pricing Management
  // ============================================================================

  /**
   * Set expert pricing.
   *
   * @param expertId - Expert's open_id
   * @param price - Price per consultation
   * @returns Operation result
   */
  async setExpertPrice(expertId: string, price: number): Promise<CreditOperationResult> {
    await this.ensureLoaded();

    if (price < 0) {
      return { success: false, error: '身价不能为负数' };
    }

    let pricing = this.config!.expertPricing.find(p => p.openId === expertId);

    if (!pricing) {
      pricing = {
        openId: expertId,
        pricePerConsultation: price,
        updatedAt: new Date().toISOString(),
      };
      this.config!.expertPricing.push(pricing);
    } else {
      pricing.pricePerConsultation = price;
      pricing.updatedAt = new Date().toISOString();
    }

    await this.save();
    logger.info({ expertId, price }, 'Expert price set');

    return { success: true };
  }

  /**
   * Get expert pricing.
   *
   * @param expertId - Expert's open_id
   * @returns Pricing or undefined
   */
  async getExpertPrice(expertId: string): Promise<number> {
    await this.ensureLoaded();
    const pricing = this.config!.expertPricing.find(p => p.openId === expertId);
    return pricing?.pricePerConsultation ?? 0; // Default free if not set
  }

  /**
   * Get all expert pricing.
   */
  async getAllPricing(): Promise<ExpertPricing[]> {
    await this.ensureLoaded();
    return [...this.config!.expertPricing];
  }

  // ============================================================================
  // Consultation Operations
  // ============================================================================

  /**
   * Check if an agent can afford a consultation.
   *
   * @param agentId - Agent identifier
   * @param expertId - Expert's open_id
   * @returns Eligibility result
   */
  async checkConsultationEligibility(
    agentId: string,
    expertId: string
  ): Promise<ConsultationEligibility> {
    await this.ensureLoaded();

    const account = await this.getAccount(agentId);
    if (!account) {
      return {
        allowed: false,
        reason: 'account_not_found',
      };
    }

    const expertPrice = await this.getExpertPrice(expertId);
    const dailyRemaining = account.dailyLimit - account.usedToday;

    // Check balance
    if (account.balance < expertPrice) {
      return {
        allowed: false,
        reason: 'insufficient_balance',
        balance: account.balance,
        expertPrice,
        dailyRemaining,
      };
    }

    // Check daily limit
    if (dailyRemaining < expertPrice) {
      return {
        allowed: false,
        reason: 'daily_limit_exceeded',
        balance: account.balance,
        expertPrice,
        dailyRemaining,
      };
    }

    return {
      allowed: true,
      balance: account.balance,
      expertPrice,
      dailyRemaining,
    };
  }

  /**
   * Charge for a consultation.
   *
   * @param agentId - Agent identifier
   * @param expertId - Expert's open_id
   * @param description - Optional description
   * @returns Operation result
   */
  async chargeConsultation(
    agentId: string,
    expertId: string,
    description?: string
  ): Promise<CreditOperationResult> {
    await this.ensureLoaded();

    // Check eligibility first
    const eligibility = await this.checkConsultationEligibility(agentId, expertId);
    if (!eligibility.allowed) {
      const errorMessages: Record<string, string> = {
        account_not_found: '账户不存在',
        insufficient_balance: `积分不足。当前余额: ${eligibility.balance}, 需要: ${eligibility.expertPrice}`,
        daily_limit_exceeded: `已达每日上限。今日剩余: ${eligibility.dailyRemaining}, 需要: ${eligibility.expertPrice}`,
      };
      return { success: false, error: errorMessages[eligibility.reason!] };
    }

    const account = (await this.getAccount(agentId))!;
    const price = eligibility.expertPrice!;

    // Deduct balance
    account.balance -= price;
    account.usedToday += price;

    // Record transaction
    const transaction: CreditTransaction = {
      id: generateTransactionId(),
      timestamp: new Date().toISOString(),
      agentId,
      expertId,
      amount: -price,
      type: 'consultation',
      description: description || `咨询专家`,
    };
    this.config!.transactions.push(transaction);
    this.trimTransactions();

    await this.save();
    logger.info({ agentId, expertId, price, newBalance: account.balance }, 'Consultation charged');

    return { success: true, newBalance: account.balance };
  }

  /**
   * Refund a consultation.
   *
   * @param agentId - Agent identifier
   * @param expertId - Expert's open_id
   * @param amount - Amount to refund
   * @param reason - Refund reason
   * @returns Operation result
   */
  async refund(
    agentId: string,
    expertId: string,
    amount: number,
    reason?: string
  ): Promise<CreditOperationResult> {
    await this.ensureLoaded();

    const account = await this.getAccount(agentId);
    if (!account) {
      return { success: false, error: '账户不存在' };
    }

    account.balance += amount;

    // Record transaction
    const transaction: CreditTransaction = {
      id: generateTransactionId(),
      timestamp: new Date().toISOString(),
      agentId,
      expertId,
      amount,
      type: 'refund',
      description: reason || '退款',
    };
    this.config!.transactions.push(transaction);
    this.trimTransactions();

    await this.save();
    logger.info({ agentId, expertId, amount, newBalance: account.balance }, 'Refund processed');

    return { success: true, newBalance: account.balance };
  }

  /**
   * Trim transaction history to keep only last 100 entries.
   */
  private trimTransactions(): void {
    if (this.config!.transactions.length > 100) {
      this.config!.transactions = this.config!.transactions.slice(-100);
    }
  }

  /**
   * Get transaction history for an agent.
   *
   * @param agentId - Agent identifier
   * @param limit - Maximum number of transactions to return
   * @returns Transaction list
   */
  async getTransactionHistory(agentId: string, limit = 20): Promise<CreditTransaction[]> {
    await this.ensureLoaded();
    return this.config!.transactions
      .filter(t => t.agentId === agentId)
      .slice(-limit)
      .reverse();
  }
}

/**
 * Singleton instance.
 */
let instance: CreditManager | null = null;

/**
 * Get the singleton CreditManager instance.
 */
export function getCreditManager(): CreditManager {
  if (!instance) {
    instance = new CreditManager();
  }
  return instance;
}
