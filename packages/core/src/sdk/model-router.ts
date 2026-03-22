/**
 * Smart Model Router - Intelligent model selection based on task context.
 *
 * Implements Issue #1338: Route different task types to optimal models.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    Model Routing Flow                       │
 * ├─────────────────────────────────────────────────────────────┤
 * │                                                              │
 * │  Task Context (skill name, hints, task type)                 │
 *      │                                                         │
 *      ▼                                                         │
 * │  ┌─────────────────────────────────────────────┐            │
 * │  │  TaskClassifier                             │            │
 * │  │  - Skill name → task type mapping           │            │
 * │  │  - Explicit hint overrides                  │            │
 * │  └─────────────────┬───────────────────────────┘            │
 * │                    │                                         │
 * │                    ▼                                         │
 * │  ┌─────────────────────────────────────────────┐            │
 * │  │  ModelRouter                                │            │
 * │  │  - Task type → model mapping                │            │
 * │  │  - Fallback to default model                │            │
 * │  │  - Provider-specific overrides              │            │
 * │  └─────────────────┬───────────────────────────┘            │
 * │                    │                                         │
 * │                    ▼                                         │
 * │  { model: string, provider?: string }                       │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Configuration Example
 *
 * ```yaml
 * agent:
 *   model: "claude-sonnet-4-20250514"         # default model
 *   modelRouting:
 *     enabled: true
 *     rules:
 *       - taskType: coding
 *         model: "claude-sonnet-4-20250514"
 *       - taskType: research
 *         model: "claude-opus-4-20250514"
 *       - skill: evaluator
 *         model: "claude-haiku-4-20250414"
 * ```
 *
 * @module sdk/model-router
 */

import { createLogger } from '../utils/logger.js';

// ============================================================================
// Task Type Definitions
// ============================================================================

/**
 * Predefined task types for model routing.
 *
 * Each type represents a category of AI workloads with different
 * model requirements (speed, reasoning, coding ability, etc.).
 */
export type TaskType =
  | 'coding'      // Code generation, debugging, refactoring
  | 'research'    // Deep analysis, information gathering
  | 'evaluation'  // Task evaluation, quality assessment
  | 'reporting'   // Progress reports, user notifications
  | 'general';    // Default / catch-all

/**
 * A single model routing rule.
 *
 * Rules are evaluated in order. The first matching rule wins.
 * A rule can match by taskType or by skill name (exact match).
 */
export interface ModelRoutingRule {
  /** Match by task type */
  taskType?: TaskType;
  /** Match by skill name (exact match, e.g. 'evaluator', 'executor') */
  skill?: string;
  /** Model to use when this rule matches */
  model: string;
  /** Optional provider override for this rule */
  provider?: 'anthropic' | 'glm';
}

/**
 * Model routing configuration.
 *
 * @example
 * ```typescript
 * const routing: ModelRoutingConfig = {
 *   enabled: true,
 *   defaultModel: 'claude-sonnet-4-20250514',
 *   rules: [
 *     { taskType: 'coding', model: 'claude-sonnet-4-20250514' },
 *     { taskType: 'research', model: 'claude-opus-4-20250514' },
 *     { skill: 'evaluator', model: 'claude-haiku-4-20250414' },
 *   ],
 * };
 * ```
 */
export interface ModelRoutingConfig {
  /** Whether model routing is enabled */
  enabled: boolean;
  /** Rules evaluated in order, first match wins */
  rules: ModelRoutingRule[];
}

/**
 * Result of model routing.
 */
export interface ModelRoutingResult {
  /** Selected model identifier */
  model: string;
  /** Optional provider override */
  provider?: 'anthropic' | 'glm';
  /** Which rule matched (for debugging) */
  matchedRule?: string;
}

/**
 * Context for model routing decision.
 */
export interface RoutingContext {
  /** Skill name (e.g. 'evaluator', 'executor', 'reporter') */
  skillName?: string;
  /** Explicit task type hint (takes priority) */
  taskType?: TaskType;
  /** Agent name for logging */
  agentName?: string;
}

// ============================================================================
// Built-in Skill → Task Type Mapping
// ============================================================================

/**
 * Default mapping from skill names to task types.
 *
 * This provides sensible defaults that work out of the box.
 * Users can override via configuration rules.
 */
const BUILTIN_SKILL_TASK_MAP: Record<string, TaskType> = {
  // Evaluation tasks - typically simple assessments
  'evaluator': 'evaluation',

  // Reporting tasks - need clarity, not deep reasoning
  'reporter': 'reporting',
  'progress-reporter': 'reporting',

  // Research tasks - may need deeper reasoning
  'agentic-research': 'research',
  'research': 'research',

  // Default: general
  'executor': 'general',
};

// ============================================================================
// Task Classifier
// ============================================================================

/**
 * Classify a task based on skill name and context hints.
 *
 * Priority:
 * 1. Explicit taskType hint (highest)
 * 2. Skill name → task type mapping
 * 3. Default to 'general'
 */
export function classifyTask(context: RoutingContext): TaskType {
  // Priority 1: explicit hint
  if (context.taskType) {
    return context.taskType;
  }

  // Priority 2: skill name mapping
  if (context.skillName) {
    const skillLower = context.skillName.toLowerCase();
    for (const [pattern, taskType] of Object.entries(BUILTIN_SKILL_TASK_MAP)) {
      if (skillLower.includes(pattern) || pattern.includes(skillLower)) {
        return taskType;
      }
    }
  }

  // Priority 3: default
  return 'general';
}

// ============================================================================
// Model Router
// ============================================================================

const logger = createLogger('ModelRouter');

/**
 * Route a task to the optimal model based on configuration and context.
 *
 * Evaluation order:
 * 1. If routing is disabled, return default model
 * 2. Find first matching rule by taskType
 * 3. Find first matching rule by skill name
 * 4. Fall back to default model
 *
 * @param config - Model routing configuration
 * @param context - Routing context (skill name, task type hints)
 * @param defaultModel - Default model when no rule matches
 * @returns Model routing result with selected model
 *
 * @example
 * ```typescript
 * const result = routeModel(routingConfig, { skillName: 'evaluator' }, 'claude-sonnet-4-20250514');
 * // result.model === 'claude-haiku-4-20250414' (if configured)
 * ```
 */
export function routeModel(
  config: ModelRoutingConfig,
  context: RoutingContext,
  defaultModel: string
): ModelRoutingResult {
  // If routing is disabled, return default
  if (!config.enabled) {
    return { model: defaultModel };
  }

  // Classify task type
  const taskType = classifyTask(context);

  // Try to find a matching rule
  for (const rule of config.rules) {
    // Check skill name match first (more specific)
    if (rule.skill && context.skillName) {
      const skillLower = context.skillName.toLowerCase();
      const ruleSkillLower = rule.skill.toLowerCase();
      if (skillLower === ruleSkillLower || skillLower.includes(ruleSkillLower)) {
        logger.debug(
          {
            agentName: context.agentName,
            skillName: context.skillName,
            matchedModel: rule.model,
            matchType: 'skill',
          },
          'Model routing: matched by skill name'
        );
        return {
          model: rule.model,
          provider: rule.provider,
          matchedRule: `skill:${rule.skill}`,
        };
      }
    }

    // Check task type match
    if (rule.taskType && rule.taskType === taskType) {
      logger.debug(
        {
          agentName: context.agentName,
          skillName: context.skillName,
          taskType,
          matchedModel: rule.model,
          matchType: 'taskType',
        },
        'Model routing: matched by task type'
      );
      return {
        model: rule.model,
        provider: rule.provider,
        matchedRule: `taskType:${rule.taskType}`,
      };
    }
  }

  // No matching rule - use default
  logger.debug(
    {
      agentName: context.agentName,
      skillName: context.skillName,
      taskType,
      defaultModel,
    },
    'Model routing: no matching rule, using default model'
  );

  return { model: defaultModel };
}

/**
 * Build routing context from agent/skill metadata.
 *
 * Convenience function for common cases where you have
 * a skill path or agent name.
 *
 * @param options - Options for building routing context
 * @returns Routing context
 *
 * @example
 * ```typescript
 * const ctx = buildRoutingContext({
 *   skillPath: '/app/skills/evaluator/SKILL.md',
 *   agentName: 'Evaluator',
 * });
 * // ctx.skillName === 'evaluator'
 * ```
 */
export function buildRoutingContext(options: {
  skillPath?: string;
  skillName?: string;
  taskType?: TaskType;
  agentName?: string;
}): RoutingContext {
  let skillName = options.skillName;

  // Extract skill name from path if not provided directly
  if (!skillName && options.skillPath) {
    // Handle paths like: skills/evaluator/SKILL.md or /app/skills/evaluator/SKILL.md
    const match = options.skillPath.match(/(?:skills|skill)\/([^/]+)/i);
    if (match) {
      skillName = match[1];
    }
  }

  return {
    skillName,
    taskType: options.taskType,
    agentName: options.agentName,
  };
}
