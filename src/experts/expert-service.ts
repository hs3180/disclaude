/**
 * ExpertService - Manages human expert registry and skill declarations.
 *
 * Tracks experts registered through the bot and their skill profiles.
 * Stores expert metadata in workspace/experts.json.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ExpertService');

/**
 * Skill level (1-5 self-assessment).
 */
export type SkillLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Skill declaration by an expert.
 */
export interface SkillDeclaration {
  /** Skill name */
  name: string;
  /** Self-assessed level (1-5) */
  level: SkillLevel;
  /** Tags for categorization */
  tags?: string[];
  /** Optional description */
  description?: string;
}

/**
 * Expert profile.
 */
export interface ExpertProfile {
  /** Expert unique identifier (same as userId) */
  id: string;
  /** User ID (Feishu open_id) */
  userId: string;
  /** Display name */
  name: string;
  /** Declared skills */
  skills: SkillDeclaration[];
  /** Available hours (e.g., "weekdays 10:00-18:00") */
  availability?: string;
  /** Price per consultation (credits) - @see Issue #538 */
  price?: number;
  /** Registration timestamp */
  registeredAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Agent account for credit management.
 * @see Issue #538 - 积分系统
 */
export interface AgentAccount {
  /** Agent unique identifier */
  agentId: string;
  /** Display name */
  name?: string;
  /** Current balance */
  balance: number;
  /** Daily spending limit */
  dailyLimit: number;
  /** Amount used today */
  usedToday: number;
  /** Last reset date (YYYY-MM-DD format) */
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
  /** Expert ID (if applicable) */
  expertId?: string;
  /** Transaction type */
  type: 'deduct' | 'recharge' | 'refund';
  /** Amount (positive for credit, negative for debit) */
  amount: number;
  /** Balance after transaction */
  balanceAfter: number;
  /** Description */
  description: string;
  /** Transaction timestamp */
  timestamp: number;
}

/**
 * Expert registry storage format.
 */
interface ExpertRegistry {
  /** Version for future migrations */
  version: number;
  /** Experts indexed by userId */
  experts: Record<string, ExpertProfile>;
  /** Agent accounts indexed by agentId - @see Issue #538 */
  accounts: Record<string, AgentAccount>;
  /** Credit transaction history - @see Issue #538 */
  transactions: CreditTransaction[];
}

/**
 * ExpertService configuration.
 */
export interface ExpertServiceConfig {
  /** Storage file path (default: workspace/experts.json) */
  filePath?: string;
}

/**
 * Service for managing human experts.
 *
 * Features:
 * - Register/unregister experts
 * - Manage skill declarations
 * - Persist expert profiles
 * - Search experts by skill
 */
export class ExpertService {
  private filePath: string;
  private registry: ExpertRegistry;

  constructor(config: ExpertServiceConfig = {}) {
    this.filePath = config.filePath || path.join(process.cwd(), 'workspace', 'experts.json');
    this.registry = this.load();
  }

  /**
   * Load registry from file.
   */
  private load(): ExpertRegistry {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(content) as ExpertRegistry;
        logger.info({ expertCount: Object.keys(data.experts || {}).length }, 'Expert registry loaded');
        return {
          version: data.version || 1,
          experts: data.experts || {},
          accounts: data.accounts || {},
          transactions: data.transactions || [],
        };
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to load expert registry, starting fresh');
    }
    return { version: 1, experts: {}, accounts: {}, transactions: [] };
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
      logger.debug({ expertCount: Object.keys(this.registry.experts).length }, 'Expert registry saved');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save expert registry');
    }
  }

  /**
   * Register a new expert.
   *
   * @param userId - User ID (Feishu open_id)
   * @param name - Display name
   * @returns The created or updated expert profile
   */
  registerExpert(userId: string, name: string): ExpertProfile {
    const now = Date.now();
    const existing = this.registry.experts[userId];

    if (existing) {
      // Update existing expert
      existing.name = name;
      existing.updatedAt = now;
      this.save();
      logger.info({ userId, name }, 'Expert profile updated');
      return existing;
    }

    // Create new expert
    const profile: ExpertProfile = {
      id: userId,
      userId,
      name,
      skills: [],
      registeredAt: now,
      updatedAt: now,
    };

    this.registry.experts[userId] = profile;
    this.save();
    logger.info({ userId, name }, 'Expert registered');
    return profile;
  }

  /**
   * Unregister an expert.
   *
   * @param userId - User ID
   * @returns Whether the expert was removed
   */
  unregisterExpert(userId: string): boolean {
    if (this.registry.experts[userId]) {
      delete this.registry.experts[userId];
      this.save();
      logger.info({ userId }, 'Expert unregistered');
      return true;
    }
    return false;
  }

  /**
   * Get expert profile.
   *
   * @param userId - User ID
   * @returns Expert profile or undefined
   */
  getExpert(userId: string): ExpertProfile | undefined {
    return this.registry.experts[userId];
  }

  /**
   * Check if a user is a registered expert.
   *
   * @param userId - User ID
   */
  isExpert(userId: string): boolean {
    return userId in this.registry.experts;
  }

  /**
   * List all registered experts.
   *
   * @returns Array of expert profiles
   */
  listExperts(): ExpertProfile[] {
    return Object.values(this.registry.experts);
  }

  /**
   * Add a skill to an expert's profile.
   *
   * @param userId - User ID
   * @param skill - Skill declaration
   * @returns Updated profile or undefined if expert not found
   */
  addSkill(userId: string, skill: SkillDeclaration): ExpertProfile | undefined {
    const profile = this.registry.experts[userId];
    if (!profile) {
      logger.warn({ userId }, 'Cannot add skill: expert not found');
      return undefined;
    }

    // Check if skill already exists
    const existingIndex = profile.skills.findIndex(s => s.name.toLowerCase() === skill.name.toLowerCase());

    if (existingIndex >= 0) {
      // Update existing skill
      profile.skills[existingIndex] = skill;
    } else {
      // Add new skill
      profile.skills.push(skill);
    }

    profile.updatedAt = Date.now();
    this.save();
    logger.info({ userId, skillName: skill.name }, 'Skill added/updated');
    return profile;
  }

  /**
   * Remove a skill from an expert's profile.
   *
   * @param userId - User ID
   * @param skillName - Skill name to remove
   * @returns Updated profile or undefined if expert/skill not found
   */
  removeSkill(userId: string, skillName: string): ExpertProfile | undefined {
    const profile = this.registry.experts[userId];
    if (!profile) {
      logger.warn({ userId }, 'Cannot remove skill: expert not found');
      return undefined;
    }

    const initialLength = profile.skills.length;
    profile.skills = profile.skills.filter(s => s.name.toLowerCase() !== skillName.toLowerCase());

    if (profile.skills.length === initialLength) {
      logger.warn({ userId, skillName }, 'Skill not found');
      return undefined;
    }

    profile.updatedAt = Date.now();
    this.save();
    logger.info({ userId, skillName }, 'Skill removed');
    return profile;
  }

  /**
   * Set expert availability.
   *
   * @param userId - User ID
   * @param availability - Availability string
   * @returns Updated profile or undefined if expert not found
   */
  setAvailability(userId: string, availability: string): ExpertProfile | undefined {
    const profile = this.registry.experts[userId];
    if (!profile) {
      logger.warn({ userId }, 'Cannot set availability: expert not found');
      return undefined;
    }

    profile.availability = availability;
    profile.updatedAt = Date.now();
    this.save();
    logger.info({ userId, availability }, 'Availability set');
    return profile;
  }

  /**
   * Search experts by skill name or tag.
   *
   * @param query - Skill name or tag to search for
   * @param minLevel - Minimum skill level filter (optional)
   * @returns Array of matching expert profiles
   */
  searchBySkill(query: string, minLevel?: SkillLevel): ExpertProfile[] {
    const queryLower = query.toLowerCase();
    return Object.values(this.registry.experts).filter(expert => {
      return expert.skills.some(skill => {
        const nameMatch = skill.name.toLowerCase().includes(queryLower);
        const tagMatch = skill.tags?.some(t => t.toLowerCase().includes(queryLower)) ?? false;
        const levelMatch = minLevel === undefined || skill.level >= minLevel;
        return (nameMatch || tagMatch) && levelMatch;
      });
    });
  }

  /**
   * Get the storage file path.
   */
  getFilePath(): string {
    return this.filePath;
  }

  // ========================================
  // Credit System Methods (Issue #538)
  // ========================================

  /**
   * Set expert's price per consultation.
   *
   * @param userId - Expert's user ID
   * @param price - Price in credits (must be >= 0)
   * @returns Updated profile or undefined if expert not found
   */
  setPrice(userId: string, price: number): ExpertProfile | undefined {
    const profile = this.registry.experts[userId];
    if (!profile) {
      logger.warn({ userId }, 'Cannot set price: expert not found');
      return undefined;
    }

    if (price < 0) {
      logger.warn({ userId, price }, 'Cannot set price: must be >= 0');
      return undefined;
    }

    profile.price = price;
    profile.updatedAt = Date.now();
    this.save();
    logger.info({ userId, price }, 'Expert price set');
    return profile;
  }

  /**
   * Get or create an agent account.
   *
   * @param agentId - Agent identifier
   * @param name - Optional display name
   * @returns Agent account
   */
  getOrCreateAccount(agentId: string, name?: string): AgentAccount {
    let account = this.registry.accounts[agentId];

    if (!account) {
      const now = Date.now();
      const [today] = new Date().toISOString().split('T');
      account = {
        agentId,
        name,
        balance: 0,
        dailyLimit: 1000, // Default daily limit
        usedToday: 0,
        lastResetDate: today,
        createdAt: now,
        updatedAt: now,
      };
      this.registry.accounts[agentId] = account;
      this.save();
      logger.info({ agentId, name }, 'Agent account created');
    } else {
      // Update name if provided
      if (name && account.name !== name) {
        account.name = name;
        account.updatedAt = Date.now();
        this.save();
      }
    }

    // Reset daily usage if date changed
    this.resetDailyUsageIfNeeded(account);

    return account;
  }

  /**
   * Get agent account.
   *
   * @param agentId - Agent identifier
   * @returns Agent account or undefined
   */
  getAccount(agentId: string): AgentAccount | undefined {
    const account = this.registry.accounts[agentId];
    if (account) {
      this.resetDailyUsageIfNeeded(account);
    }
    return account;
  }

  /**
   * Set agent's daily limit.
   *
   * @param agentId - Agent identifier
   * @param dailyLimit - New daily limit
   * @returns Updated account or undefined if not found
   */
  setDailyLimit(agentId: string, dailyLimit: number): AgentAccount | undefined {
    const account = this.registry.accounts[agentId];
    if (!account) {
      logger.warn({ agentId }, 'Cannot set daily limit: account not found');
      return undefined;
    }

    if (dailyLimit < 0) {
      logger.warn({ agentId, dailyLimit }, 'Cannot set daily limit: must be >= 0');
      return undefined;
    }

    account.dailyLimit = dailyLimit;
    account.updatedAt = Date.now();
    this.save();
    logger.info({ agentId, dailyLimit }, 'Daily limit set');
    return account;
  }

  /**
   * Recharge agent's balance.
   *
   * @param agentId - Agent identifier
   * @param amount - Amount to add (must be > 0)
   * @param description - Transaction description
   * @returns Updated account or undefined if not found
   */
  recharge(agentId: string, amount: number, description = '管理员充值'): AgentAccount | undefined {
    const account = this.registry.accounts[agentId];
    if (!account) {
      logger.warn({ agentId }, 'Cannot recharge: account not found');
      return undefined;
    }

    if (amount <= 0) {
      logger.warn({ agentId, amount }, 'Cannot recharge: amount must be > 0');
      return undefined;
    }

    this.resetDailyUsageIfNeeded(account);

    account.balance += amount;
    account.updatedAt = Date.now();

    // Record transaction
    this.recordTransaction({
      id: this.generateTransactionId(),
      agentId,
      type: 'recharge',
      amount,
      balanceAfter: account.balance,
      description,
      timestamp: Date.now(),
    });

    this.save();
    logger.info({ agentId, amount, balance: account.balance }, 'Account recharged');
    return account;
  }

  /**
   * Check if agent can afford a consultation.
   *
   * @param agentId - Agent identifier
   * @param amount - Required amount
   * @returns true if agent has sufficient balance and daily limit
   */
  canAfford(agentId: string, amount: number): boolean {
    const account = this.getAccount(agentId);
    if (!account) {
      return false;
    }

    this.resetDailyUsageIfNeeded(account);

    return account.balance >= amount && (account.dailyLimit === 0 || account.usedToday + amount <= account.dailyLimit);
  }

  /**
   * Deduct credits from agent account.
   *
   * @param agentId - Agent identifier
   * @param amount - Amount to deduct
   * @param expertId - Expert being consulted
   * @param description - Transaction description
   * @returns Updated account, or undefined if insufficient balance or not found
   */
  deductCredits(
    agentId: string,
    amount: number,
    expertId: string,
    description = '专家咨询'
  ): { account: AgentAccount; transaction: CreditTransaction } | undefined {
    const account = this.registry.accounts[agentId];
    if (!account) {
      logger.warn({ agentId }, 'Cannot deduct: account not found');
      return undefined;
    }

    this.resetDailyUsageIfNeeded(account);

    // Check balance
    if (account.balance < amount) {
      logger.warn({ agentId, amount, balance: account.balance }, 'Insufficient balance');
      return undefined;
    }

    // Check daily limit (0 means no limit)
    if (account.dailyLimit > 0 && account.usedToday + amount > account.dailyLimit) {
      logger.warn(
        { agentId, amount, usedToday: account.usedToday, dailyLimit: account.dailyLimit },
        'Daily limit exceeded'
      );
      return undefined;
    }

    // Deduct
    account.balance -= amount;
    account.usedToday += amount;
    account.updatedAt = Date.now();

    // Record transaction
    const transaction: CreditTransaction = {
      id: this.generateTransactionId(),
      agentId,
      expertId,
      type: 'deduct',
      amount: -amount,
      balanceAfter: account.balance,
      description,
      timestamp: Date.now(),
    };

    this.recordTransaction(transaction);
    this.save();

    logger.info({ agentId, amount, expertId, balance: account.balance }, 'Credits deducted');
    return { account, transaction };
  }

  /**
   * Refund credits to agent account.
   *
   * @param agentId - Agent identifier
   * @param amount - Amount to refund
   * @param description - Transaction description
   * @returns Updated account and transaction, or undefined if not found
   */
  refund(agentId: string, amount: number, description = '退款'): { account: AgentAccount; transaction: CreditTransaction } | undefined {
    const account = this.registry.accounts[agentId];
    if (!account) {
      logger.warn({ agentId }, 'Cannot refund: account not found');
      return undefined;
    }

    this.resetDailyUsageIfNeeded(account);

    account.balance += amount;
    // Note: we don't reduce usedToday as the daily limit is about spending, not net
    account.updatedAt = Date.now();

    const transaction: CreditTransaction = {
      id: this.generateTransactionId(),
      agentId,
      type: 'refund',
      amount,
      balanceAfter: account.balance,
      description,
      timestamp: Date.now(),
    };

    this.recordTransaction(transaction);
    this.save();

    logger.info({ agentId, amount, balance: account.balance }, 'Credits refunded');
    return { account, transaction };
  }

  /**
   * Get transaction history for an agent.
   *
   * @param agentId - Agent identifier
   * @param limit - Maximum number of transactions to return
   * @returns Array of transactions (most recent first)
   */
  getTransactionHistory(agentId: string, limit = 50): CreditTransaction[] {
    return this.registry.transactions
      .filter(t => t.agentId === agentId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * List all agent accounts.
   *
   * @returns Array of agent accounts
   */
  listAccounts(): AgentAccount[] {
    // Reset daily usage for all accounts before returning
    for (const account of Object.values(this.registry.accounts)) {
      this.resetDailyUsageIfNeeded(account);
    }
    return Object.values(this.registry.accounts);
  }

  /**
   * Reset daily usage counter if the date has changed.
   */
  private resetDailyUsageIfNeeded(account: AgentAccount): void {
    const [today] = new Date().toISOString().split('T');
    if (account.lastResetDate !== today) {
      account.usedToday = 0;
      account.lastResetDate = today;
      account.updatedAt = Date.now();
      this.save();
      logger.debug({ agentId: account.agentId }, 'Daily usage reset');
    }
  }

  /**
   * Generate a unique transaction ID.
   */
  private generateTransactionId(): string {
    return `txn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Record a transaction in history.
   */
  private recordTransaction(transaction: CreditTransaction): void {
    this.registry.transactions.push(transaction);
    // Keep only last 1000 transactions to prevent unbounded growth
    if (this.registry.transactions.length > 1000) {
      this.registry.transactions = this.registry.transactions.slice(-1000);
    }
  }
}

// Singleton instance
let defaultInstance: ExpertService | undefined;

/**
 * Get the default ExpertService instance.
 */
export function getExpertService(): ExpertService {
  if (!defaultInstance) {
    defaultInstance = new ExpertService();
  }
  return defaultInstance;
}
