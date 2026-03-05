/**
 * Expert System Types.
 *
 * Defines types for the human expert registration and skill declaration system.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 * @see Issue #536 - 专家查询与匹配
 * @see Issue #538 - 积分系统 - 身价与消费
 */

/**
 * Skill level (1-5 self-assessment).
 */
export type SkillLevel = 1 | 2 | 3 | 4 | 5;

/**
 * A single skill declaration.
 */
export interface Skill {
  /** Skill name (e.g., "React/TypeScript", "Node.js") */
  name: string;
  /** Self-assessed skill level (1-5) */
  level: SkillLevel;
  /** Tags for categorization (e.g., ["frontend", "web"]) */
  tags: string[];
}

/**
 * Availability schedule.
 */
export interface Availability {
  /** Days pattern (e.g., "weekdays", "weekends", "all") */
  days: string;
  /** Time range (e.g., "10:00-18:00") */
  timeRange: string;
}

/**
 * Expert profile.
 */
export interface ExpertProfile {
  /** User's open_id */
  userId: string;
  /** Registration timestamp */
  registeredAt: number;
  /** List of declared skills */
  skills: Skill[];
  /** Availability schedule (optional) */
  availability?: Availability;
  /** Price per consultation in credits (Issue #538) */
  price?: number;
  /** Last updated timestamp */
  updatedAt: number;
}

/**
 * Expert registry storage format.
 */
export interface ExpertRegistry {
  /** Version for future migrations */
  version: number;
  /** Experts indexed by userId */
  experts: Record<string, ExpertProfile>;
}

/**
 * Options for adding a skill.
 */
export interface AddSkillOptions {
  /** User's open_id */
  userId: string;
  /** Skill name */
  name: string;
  /** Skill level (1-5) */
  level: SkillLevel;
  /** Tags (optional) */
  tags?: string[];
}

/**
 * Options for removing a skill.
 */
export interface RemoveSkillOptions {
  /** User's open_id */
  userId: string;
  /** Skill name to remove */
  name: string;
}

/**
 * Options for setting availability.
 */
export interface SetAvailabilityOptions {
  /** User's open_id */
  userId: string;
  /** Days pattern */
  days: string;
  /** Time range */
  timeRange: string;
}

/**
 * Options for finding experts.
 *
 * @see Issue #536 - 专家查询与匹配
 */
export interface FindExpertsOptions {
  /** Minimum skill level required (1-5) */
  minLevel?: SkillLevel;
  /** Only return currently available experts */
  available?: boolean;
  /** Maximum number of results to return */
  limit?: number;
}

/**
 * Expert match result with matching skill details.
 *
 * @see Issue #536 - 专家查询与匹配
 */
export interface ExpertMatch {
  /** Expert profile */
  expert: ExpertProfile;
  /** Matching skills */
  matchingSkills: Skill[];
  /** Whether the expert is currently available */
  isAvailable: boolean;
}

// ============================================================================
// Budget System Types (Issue #538 - 积分系统)
// ============================================================================

/**
 * Agent budget account for credit management.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */
export interface AgentAccount {
  /** Agent identifier */
  agentId: string;
  /** Current credit balance */
  balance: number;
  /** Daily spending limit */
  dailyLimit: number;
  /** Amount spent today */
  usedToday: number;
  /** Last reset date (for daily usage tracking) */
  lastResetDate: string;
  /** Account creation timestamp */
  createdAt: number;
  /** Last updated timestamp */
  updatedAt: number;
}

/**
 * Budget registry storage format.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */
export interface BudgetRegistry {
  /** Version for future migrations */
  version: number;
  /** Accounts indexed by agentId */
  accounts: Record<string, AgentAccount>;
}

/**
 * Options for recharging an agent account.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */
export interface RechargeOptions {
  /** Agent identifier */
  agentId: string;
  /** Amount to add */
  credits: number;
}

/**
 * Options for setting daily limit.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */
export interface SetDailyLimitOptions {
  /** Agent identifier */
  agentId: string;
  /** New daily limit */
  dailyLimit: number;
}

/**
 * Options for deducting credits.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */
export interface DeductCreditsOptions {
  /** Agent identifier */
  agentId: string;
  /** Amount to deduct */
  credits: number;
  /** Description for the transaction */
  description?: string;
}

/**
 * Result of a credit deduction attempt.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */
export interface DeductResult {
  /** Whether the deduction was successful */
  success: boolean;
  /** Remaining balance after deduction (if successful) */
  newBalance?: number;
  /** Error reason (if failed) */
  error?: 'insufficient_balance' | 'daily_limit_exceeded' | 'account_not_found';
}

/**
 * Options for setting expert price.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */
export interface SetPriceOptions {
  /** User's open_id */
  userId: string;
  /** Price per consultation in credits */
  price: number;
}
