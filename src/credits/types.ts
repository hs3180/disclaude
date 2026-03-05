/**
 * Credits System Types.
 *
 * Defines types for the agent credits management system.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

/**
 * Agent credits account.
 */
export interface AgentAccount {
  /** Agent identifier (usually chatId or agentId) */
  agentId: string;
  /** Current balance in credits */
  balance: number;
  /** Daily spending limit */
  dailyLimit: number;
  /** Amount spent today */
  usedToday: number;
  /** Last reset timestamp for daily usage (midnight of current day) */
  lastResetAt: number;
  /** Account creation timestamp */
  createdAt: number;
  /** Last updated timestamp */
  updatedAt: number;
}

/**
 * Credits registry storage format.
 */
export interface CreditsRegistry {
  /** Version for future migrations */
  version: number;
  /** Accounts indexed by agentId */
  accounts: Record<string, AgentAccount>;
}

/**
 * Options for creating a new account.
 */
export interface CreateAccountOptions {
  /** Agent identifier */
  agentId: string;
  /** Initial balance (default: 0) */
  initialBalance?: number;
  /** Daily spending limit (default: 100) */
  dailyLimit?: number;
}

/**
 * Result of a credit deduction operation.
 */
export interface DeductResult {
  /** Whether the deduction was successful */
  success: boolean;
  /** Remaining balance after deduction */
  remainingBalance: number;
  /** Error message if deduction failed */
  error?: 'insufficient_balance' | 'daily_limit_exceeded' | 'account_not_found';
}

/**
 * Options for recharging an account.
 */
export interface RechargeOptions {
  /** Agent identifier */
  agentId: string;
  /** Amount to add */
  credits: number;
}

/**
 * Options for setting daily limit.
 */
export interface SetDailyLimitOptions {
  /** Agent identifier */
  agentId: string;
  /** New daily limit */
  dailyLimit: number;
}

/**
 * Options for deducting credits.
 */
export interface DeductCreditsOptions {
  /** Agent identifier */
  agentId: string;
  /** Amount to deduct */
  credits: number;
}

/**
 * CreditService configuration.
 */
export interface CreditServiceConfig {
  /** Storage file path (default: workspace/credits.json) */
  filePath?: string;
  /** Default daily limit for new accounts */
  defaultDailyLimit?: number;
  /** Default initial balance for new accounts */
  defaultInitialBalance?: number;
}
