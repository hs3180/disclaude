/**
 * Expert System Types.
 *
 * Defines types for the human expert registration and skill declaration system.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 * @see Issue #536 - 专家查询与匹配
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
