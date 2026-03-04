/**
 * Budget Manager - Manages agent credits and consumption.
 *
 * Provides functionality for:
 * - Managing agent accounts (balance, daily limit)
 * - Consuming credits when consulting experts
 * - Recharging credits
 * - Checking spending limits
 *
 * Issue #538: 积分系统 - 身价与消费
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import type { AgentAccount, BudgetRegistry, ConsumptionRecord } from './types.js';

const logger = createLogger('BudgetManager', {});

/**
 * Budget Manager for managing agent credits.
 */
export class BudgetManager {
  private readonly dataFile: string;
  private readonly consumptionLogFile: string;
  private registry: BudgetRegistry | null = null;

  constructor(baseDir?: string) {
    const workspaceDir = baseDir || Config.getWorkspaceDir();
    this.dataFile = path.join(workspaceDir, 'budgets.json');
    this.consumptionLogFile = path.join(workspaceDir, 'consumption-log.json');
  }

  /**
   * Ensure the data directory exists.
   */
  private async ensureDataDir(): Promise<void> {
    const dir = path.dirname(this.dataFile);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create data directory');
    }
  }

  /**
   * Get today's date string (YYYY-MM-DD).
   */
  private getTodayString(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Load registry from disk.
   */
  private async loadRegistry(): Promise<BudgetRegistry> {
    if (this.registry) {
      return this.registry;
    }

    try {
      const content = await fs.readFile(this.dataFile, 'utf-8');
      this.registry = JSON.parse(content);
    } catch {
      // File doesn't exist or is invalid, create empty registry
      this.registry = { accounts: [] };
    }

    return this.registry!;
  }

  /**
   * Save registry to disk.
   */
  private async saveRegistry(): Promise<void> {
    await this.ensureDataDir();

    if (this.registry) {
      await fs.writeFile(
        this.dataFile,
        JSON.stringify(this.registry, null, 2),
        'utf-8'
      );
    }
  }

  /**
   * Log consumption record.
   */
  private async logConsumption(record: ConsumptionRecord): Promise<void> {
    await this.ensureDataDir();

    let logs: ConsumptionRecord[] = [];
    try {
      const content = await fs.readFile(this.consumptionLogFile, 'utf-8');
      logs = JSON.parse(content);
    } catch {
      // File doesn't exist, start with empty array
    }

    logs.push(record);
    await fs.writeFile(
      this.consumptionLogFile,
      JSON.stringify(logs, null, 2),
      'utf-8'
    );
  }

  /**
   * Reset daily usage if a new day has started.
   */
  private resetDailyUsageIfNeeded(account: AgentAccount): void {
    const today = this.getTodayString();
    if (account.lastUsageDate !== today) {
      account.usedToday = 0;
      account.lastUsageDate = today;
    }
  }

  /**
   * Get or create an agent account.
   *
   * @param agentId - Agent identifier
   * @param defaultDailyLimit - Default daily limit (default: 100)
   * @returns The agent account
   */
  async getOrCreateAccount(
    agentId: string,
    defaultDailyLimit: number = 100
  ): Promise<AgentAccount> {
    const registry = await this.loadRegistry();

    let account = registry.accounts.find(a => a.agentId === agentId);

    if (!account) {
      const now = new Date().toISOString();
      const today = this.getTodayString();
      account = {
        agentId,
        balance: 0,
        dailyLimit: defaultDailyLimit,
        usedToday: 0,
        lastUsageDate: today,
        createdAt: now,
        updatedAt: now,
      };
      registry.accounts.push(account);
      await this.saveRegistry();
      logger.info({ agentId }, 'Agent account created');
    } else {
      this.resetDailyUsageIfNeeded(account);
    }

    return account;
  }

  /**
   * Get account by agent ID.
   *
   * @param agentId - Agent identifier
   * @returns Account or undefined if not found
   */
  async getAccount(agentId: string): Promise<AgentAccount | undefined> {
    const registry = await this.loadRegistry();
    const account = registry.accounts.find(a => a.agentId === agentId);
    if (account) {
      this.resetDailyUsageIfNeeded(account);
    }
    return account;
  }

  /**
   * Check if agent can spend the specified amount.
   *
   * @param agentId - Agent identifier
   * @param amount - Amount to spend
   * @returns Object with canSpend flag and reason if not
   */
  async canSpend(
    agentId: string,
    amount: number
  ): Promise<{ canSpend: boolean; reason?: string }> {
    const account = await this.getAccount(agentId);

    if (!account) {
      return { canSpend: false, reason: '账户不存在' };
    }

    if (account.balance < amount) {
      return {
        canSpend: false,
        reason: `余额不足: 当前 ${account.balance}，需要 ${amount}`,
      };
    }

    const remainingDaily = account.dailyLimit - account.usedToday;
    if (remainingDaily < amount) {
      return {
        canSpend: false,
        reason: `已达每日上限: 今日已用 ${account.usedToday}，上限 ${account.dailyLimit}，剩余 ${remainingDaily}`,
      };
    }

    return { canSpend: true };
  }

  /**
   * Consume credits from an agent account.
   *
   * @param agentId - Agent identifier
   * @param amount - Amount to consume
   * @param expertId - Expert being consulted
   * @param description - Optional description
   * @returns Updated account or error
   */
  async consumeCredits(
    agentId: string,
    amount: number,
    expertId: string,
    description?: string
  ): Promise<{ success: boolean; account?: AgentAccount; error?: string }> {
    const registry = await this.loadRegistry();
    const account = registry.accounts.find(a => a.agentId === agentId);

    if (!account) {
      return { success: false, error: '账户不存在' };
    }

    this.resetDailyUsageIfNeeded(account);

    // Check balance
    if (account.balance < amount) {
      return {
        success: false,
        error: `余额不足: 当前 ${account.balance}，需要 ${amount}`,
      };
    }

    // Check daily limit
    const remainingDaily = account.dailyLimit - account.usedToday;
    if (remainingDaily < amount) {
      return {
        success: false,
        error: `已达每日上限: 今日已用 ${account.usedToday}，上限 ${account.dailyLimit}`,
      };
    }

    // Deduct credits
    account.balance -= amount;
    account.usedToday += amount;
    account.updatedAt = new Date().toISOString();

    await this.saveRegistry();

    // Log consumption
    await this.logConsumption({
      agentId,
      expertId,
      amount,
      timestamp: new Date().toISOString(),
      description,
    });

    logger.info({ agentId, amount, expertId }, 'Credits consumed');

    return { success: true, account };
  }

  /**
   * Recharge an agent account.
   *
   * @param agentId - Agent identifier
   * @param amount - Amount to add
   * @returns Updated account
   */
  async recharge(agentId: string, amount: number): Promise<AgentAccount> {
    const registry = await this.loadRegistry();
    let account = registry.accounts.find(a => a.agentId === agentId);

    if (!account) {
      // Create account if it doesn't exist
      const now = new Date().toISOString();
      const today = this.getTodayString();
      account = {
        agentId,
        balance: amount,
        dailyLimit: 100,
        usedToday: 0,
        lastUsageDate: today,
        createdAt: now,
        updatedAt: now,
      };
      registry.accounts.push(account);
    } else {
      this.resetDailyUsageIfNeeded(account);
      account.balance += amount;
      account.updatedAt = new Date().toISOString();
    }

    await this.saveRegistry();
    logger.info({ agentId, amount, newBalance: account.balance }, 'Account recharged');

    return account;
  }

  /**
   * Set daily limit for an agent.
   *
   * @param agentId - Agent identifier
   * @param limit - New daily limit
   * @returns Updated account or undefined if not found
   */
  async setDailyLimit(agentId: string, limit: number): Promise<AgentAccount | undefined> {
    const registry = await this.loadRegistry();
    const account = registry.accounts.find(a => a.agentId === agentId);

    if (!account) {
      return undefined;
    }

    this.resetDailyUsageIfNeeded(account);
    account.dailyLimit = limit;
    account.updatedAt = new Date().toISOString();

    await this.saveRegistry();
    logger.info({ agentId, limit }, 'Daily limit set');

    return account;
  }

  /**
   * List all accounts.
   *
   * @returns Array of accounts
   */
  async listAccounts(): Promise<AgentAccount[]> {
    const registry = await this.loadRegistry();
    // Reset daily usage for all accounts
    for (const account of registry.accounts) {
      this.resetDailyUsageIfNeeded(account);
    }
    return registry.accounts;
  }

  /**
   * Get consumption log.
   *
   * @param agentId - Optional filter by agent
   * @param limit - Maximum number of records to return
   * @returns Array of consumption records
   */
  async getConsumptionLog(
    agentId?: string,
    limit: number = 100
  ): Promise<ConsumptionRecord[]> {
    try {
      const content = await fs.readFile(this.consumptionLogFile, 'utf-8');
      let logs: ConsumptionRecord[] = JSON.parse(content);

      if (agentId) {
        logs = logs.filter(l => l.agentId === agentId);
      }

      // Return most recent records first
      return logs.slice(-limit).reverse();
    } catch {
      return [];
    }
  }
}

// Singleton instance
let budgetManagerInstance: BudgetManager | undefined;

/**
 * Get the global BudgetManager instance.
 */
export function getBudgetManager(): BudgetManager {
  if (!budgetManagerInstance) {
    budgetManagerInstance = new BudgetManager();
  }
  return budgetManagerInstance;
}

/**
 * Reset the global BudgetManager (for testing).
 */
export function resetBudgetManager(): void {
  budgetManagerInstance = undefined;
}
