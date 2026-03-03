/**
 * Human-in-the-Loop types for Issue #532.
 *
 * Defines types for expert configuration and interaction prompts.
 */

/**
 * Skill level definition (1-5 self-assessment).
 */
export interface SkillDefinition {
  /** Skill name (e.g., "React", "TypeScript") */
  name: string;
  /** Self-assessed level (1-5) */
  level: number;
  /** Optional tags for categorization */
  tags?: string[];
}

/**
 * Human expert configuration.
 */
export interface ExpertConfig {
  /** Expert's Feishu open_id */
  open_id: string;
  /** Display name */
  name: string;
  /** Skills and levels */
  skills: SkillDefinition[];
  /** Availability settings (optional) */
  availability?: {
    /** Available time ranges (e.g., "weekdays 10:00-18:00") */
    schedule?: string;
    /** Timezone (e.g., "Asia/Shanghai") */
    timezone?: string;
  };
}

/**
 * Expert registry configuration (workspace/experts.yaml).
 */
export interface ExpertRegistryConfig {
  /** List of registered experts */
  experts: ExpertConfig[];
}

/**
 * Card button with associated prompt template.
 *
 * When user clicks the button, the promptTemplate is injected
 * into the conversation as if the user sent it.
 */
export interface InteractionButton {
  /** Button label */
  label: string;
  /** Button value (used for tracking) */
  value: string;
  /** Prompt template to inject when button is clicked */
  promptTemplate: string;
}

/**
 * Options for creating a discussion chat.
 */
export interface CreateDiscussionOptions {
  /** Chat topic/name */
  topic: string;
  /** Initial member open_ids */
  members: string[];
  /** Initial message to send (optional) */
  initialMessage?: string;
}

/**
 * Options for asking an expert.
 */
export interface AskExpertOptions {
  /** Skill to search for */
  skill: string;
  /** Minimum skill level required (1-5) */
  minLevel?: number;
  /** Question/prompt for the expert */
  question: string;
  /** Context information (optional) */
  context?: string;
  /** Chat ID to create the discussion in (optional, creates new if not provided) */
  chatId?: string;
}

/**
 * Result of creating a discussion.
 */
export interface CreateDiscussionResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Created chat ID */
  chatId?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of asking an expert.
 */
export interface AskExpertResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Chat ID where the question was posted */
  chatId?: string;
  /** Expert who was contacted */
  expert?: {
    name: string;
    open_id: string;
  };
  /** Error message if failed */
  error?: string;
}
