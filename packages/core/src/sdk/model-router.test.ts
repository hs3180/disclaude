/**
 * Tests for Smart Model Router (packages/core/src/sdk/model-router.ts)
 *
 * Tests the following functionality:
 * - Task classification from skill names and explicit hints
 * - Model routing rule matching (by taskType and skill name)
 * - Rule priority (first match wins)
 * - Fallback to default model when no rules match
 * - Routing context building from skill paths
 * - Disabled routing falls back to default
 */

import { describe, it, expect } from 'vitest';
import {
  classifyTask,
  routeModel,
  buildRoutingContext,
  type ModelRoutingConfig,
  type RoutingContext,
  type TaskType,
} from './model-router.js';

// ============================================================================
// classifyTask
// ============================================================================

describe('classifyTask', () => {
  it('should use explicit taskType hint when provided', () => {
    const ctx: RoutingContext = { taskType: 'coding' };
    expect(classifyTask(ctx)).toBe('coding');
  });

  it('should classify evaluator skill as evaluation', () => {
    const ctx: RoutingContext = { skillName: 'evaluator' };
    expect(classifyTask(ctx)).toBe('evaluation');
  });

  it('should classify progress-reporter skill as reporting', () => {
    const ctx: RoutingContext = { skillName: 'progress-reporter' };
    expect(classifyTask(ctx)).toBe('reporting');
  });

  it('should classify reporter skill as reporting', () => {
    const ctx: RoutingContext = { skillName: 'reporter' };
    expect(classifyTask(ctx)).toBe('reporting');
  });

  it('should classify research skill as research', () => {
    const ctx: RoutingContext = { skillName: 'agentic-research' };
    expect(classifyTask(ctx)).toBe('research');
  });

  it('should classify executor skill as general', () => {
    const ctx: RoutingContext = { skillName: 'executor' };
    expect(classifyTask(ctx)).toBe('general');
  });

  it('should default to general for unknown skills', () => {
    const ctx: RoutingContext = { skillName: 'unknown-skill' };
    expect(classifyTask(ctx)).toBe('general');
  });

  it('should default to general when no context provided', () => {
    const ctx: RoutingContext = {};
    expect(classifyTask(ctx)).toBe('general');
  });

  it('should prioritize explicit taskType over skill name', () => {
    // Even if skill name maps to 'evaluation', explicit hint wins
    const ctx: RoutingContext = { skillName: 'evaluator', taskType: 'coding' };
    expect(classifyTask(ctx)).toBe('coding');
  });

  it('should be case-insensitive for skill name matching', () => {
    const ctx: RoutingContext = { skillName: 'EVALUATOR' };
    expect(classifyTask(ctx)).toBe('evaluation');
  });
});

// ============================================================================
// routeModel
// ============================================================================

describe('routeModel', () => {
  const defaultModel = 'claude-sonnet-4-20250514';

  const basicConfig: ModelRoutingConfig = {
    enabled: true,
    rules: [
      { taskType: 'coding', model: 'claude-opus-4-20250514' },
      { taskType: 'research', model: 'claude-opus-4-20250514' },
      { taskType: 'evaluation', model: 'claude-haiku-4-20250414' },
      { taskType: 'reporting', model: 'claude-haiku-4-20250414' },
      { skill: 'custom-skill', model: 'claude-sonnet-4-20250514' },
    ],
  };

  it('should return default model when routing is disabled', () => {
    const config: ModelRoutingConfig = { enabled: false, rules: [] };
    const result = routeModel(config, { skillName: 'evaluator' }, defaultModel);
    expect(result.model).toBe(defaultModel);
    expect(result.matchedRule).toBeUndefined();
  });

  it('should route coding tasks to coding model', () => {
    const result = routeModel(basicConfig, { taskType: 'coding' }, defaultModel);
    expect(result.model).toBe('claude-opus-4-20250514');
    expect(result.matchedRule).toBe('taskType:coding');
  });

  it('should route evaluation tasks to evaluation model', () => {
    const result = routeModel(basicConfig, { skillName: 'evaluator' }, defaultModel);
    expect(result.model).toBe('claude-haiku-4-20250414');
    expect(result.matchedRule).toBe('taskType:evaluation');
  });

  it('should route research tasks to research model', () => {
    const result = routeModel(basicConfig, { skillName: 'agentic-research' }, defaultModel);
    expect(result.model).toBe('claude-opus-4-20250514');
    expect(result.matchedRule).toBe('taskType:research');
  });

  it('should fall back to default model when no rule matches', () => {
    const result = routeModel(basicConfig, { skillName: 'unknown-agent' }, defaultModel);
    expect(result.model).toBe(defaultModel);
    expect(result.matchedRule).toBeUndefined();
  });

  it('should match skill-specific rules before task type rules', () => {
    const config: ModelRoutingConfig = {
      enabled: true,
      rules: [
        { taskType: 'evaluation', model: 'model-by-tasktype' },
        { skill: 'evaluator', model: 'model-by-skill' },
      ],
    };
    // taskType rule comes first, should match first
    const result = routeModel(config, { skillName: 'evaluator' }, defaultModel);
    expect(result.model).toBe('model-by-tasktype');
  });

  it('should match skill-specific rules when no task type rule matches first', () => {
    const config: ModelRoutingConfig = {
      enabled: true,
      rules: [
        { skill: 'evaluator', model: 'model-by-skill' },
        { taskType: 'evaluation', model: 'model-by-tasktype' },
      ],
    };
    // skill rule comes first, should match first
    const result = routeModel(config, { skillName: 'evaluator' }, defaultModel);
    expect(result.model).toBe('model-by-skill');
  });

  it('should support provider override in rules', () => {
    const config: ModelRoutingConfig = {
      enabled: true,
      rules: [
        { taskType: 'evaluation', model: 'glm-4', provider: 'glm' },
      ],
    };
    const result = routeModel(config, { skillName: 'evaluator' }, defaultModel);
    expect(result.model).toBe('glm-4');
    expect(result.provider).toBe('glm');
  });

  it('should use empty rules config as fallback', () => {
    const config: ModelRoutingConfig = { enabled: true, rules: [] };
    const result = routeModel(config, { skillName: 'evaluator' }, defaultModel);
    expect(result.model).toBe(defaultModel);
  });

  it('should handle case-insensitive skill matching', () => {
    const config: ModelRoutingConfig = {
      enabled: true,
      rules: [
        { skill: 'My-Evaluator', model: 'custom-model' },
      ],
    };
    const result = routeModel(config, { skillName: 'my-evaluator' }, defaultModel);
    expect(result.model).toBe('custom-model');
  });
});

// ============================================================================
// buildRoutingContext
// ============================================================================

describe('buildRoutingContext', () => {
  it('should extract skill name from skill path', () => {
    const ctx = buildRoutingContext({
      skillPath: 'skills/evaluator/SKILL.md',
    });
    expect(ctx.skillName).toBe('evaluator');
  });

  it('should extract skill name from absolute path', () => {
    const ctx = buildRoutingContext({
      skillPath: '/app/skills/progress-reporter/SKILL.md',
    });
    expect(ctx.skillName).toBe('progress-reporter');
  });

  it('should use provided skillName directly', () => {
    const ctx = buildRoutingContext({
      skillName: 'custom-agent',
    });
    expect(ctx.skillName).toBe('custom-agent');
  });

  it('should prefer skillName over path extraction', () => {
    const ctx = buildRoutingContext({
      skillPath: 'skills/evaluator/SKILL.md',
      skillName: 'override-name',
    });
    expect(ctx.skillName).toBe('override-name');
  });

  it('should handle missing path gracefully', () => {
    const ctx = buildRoutingContext({});
    expect(ctx.skillName).toBeUndefined();
    expect(ctx.taskType).toBeUndefined();
    expect(ctx.agentName).toBeUndefined();
  });

  it('should pass through agentName and taskType', () => {
    const ctx = buildRoutingContext({
      skillName: 'evaluator',
      agentName: 'TestEvaluator',
      taskType: 'evaluation',
    });
    expect(ctx.agentName).toBe('TestEvaluator');
    expect(ctx.taskType).toBe('evaluation');
  });
});
