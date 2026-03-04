/**
 * Expert System Types.
 *
 * Defines types for the human expert registration and skill declaration system.
 *
 * Issue #535: 人类专家注册与技能声明
 */

/**
 * Skill level (1-5 self-assessment).
 */
export type SkillLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Skill definition.
 */
export interface Skill {
  /** Skill name (e.g., "React", "TypeScript", "Node.js") */
  name: string;

  /** Self-assessed skill level (1-5) */
  level: SkillLevel;

  /** Optional tags for categorization */
  tags?: string[];
}

/**
 * Expert availability schedule.
 */
export interface ExpertAvailability {
  /** Schedule description (e.g., "weekdays 10:00-18:00") */
  schedule: string;

  /** Timezone (e.g., "Asia/Shanghai") */
  timezone?: string;
}

/**
 * Expert profile.
 */
export interface Expert {
  /** Feishu open_id */
  open_id: string;

  /** Display name */
  name?: string;

  /** List of skills */
  skills: Skill[];

  /** Availability settings */
  availability?: ExpertAvailability;

  /** Creation timestamp (ISO string) */
  createdAt: string;

  /** Last update timestamp (ISO string) */
  updatedAt: string;
}

/**
 * Expert registry data structure (stored as JSON).
 */
export interface ExpertRegistry {
  /** List of experts */
  experts: Expert[];
}
