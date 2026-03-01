/**
 * GenericSkillAgent - Minimal skill execution agent.
 *
 * Reads a skill markdown file, replaces template variables, and executes via SDK.
 * This is the simplified architecture from Issue #413.
 *
 * Design principles:
 * - Minimal wrapper (~50 lines)
 * - No YAML frontmatter parsing
 * - No allowedTools configuration (SDK handles tool restrictions)
 * - Template variable replacement for context injection
 *
 * @example
 * ```typescript
 * const agent = new GenericSkillAgent(config);
 *
 * // Execute a skill with context
 * for await (const msg of agent.executeSkill('skills/evaluator/SKILL.md', {
 *   taskId: 'task-123',
 *   iteration: 1,
 * })) {
 *   console.log(msg.content);
 * }
 * ```
 *
 * @module agents/skill-agent
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { BaseAgent, type BaseAgentConfig } from './base-agent.js';
import type { SkillAgent as SkillAgentInterface, UserInput } from './types.js';
import type { AgentMessage } from '../types/agent.js';
import { Config } from '../config/index.js';

/**
 * Context object for skill execution.
 * These values are available as template variables in skill files.
 */
export interface SkillContext {
  /** Task identifier */
  taskId?: string;
  /** Current iteration number */
  iteration?: number;
  /** Workspace directory */
  workspaceDir?: string;
  /** Task specification file path */
  taskMdPath?: string;
  /** Evaluation output file path */
  evaluationPath?: string;
  /** Execution output file path */
  executionPath?: string;
  /** Previous execution file path */
  previousExecutionPath?: string | null;
  /** Final result file path */
  finalResultPath?: string;
  /** Evaluation content for executor guidance */
  evaluationContent?: string;
  /** Additional context values */
  [key: string]: string | number | undefined | null;
}

/**
 * GenericSkillAgent - Minimal skill execution agent.
 *
 * Implements Issue #413's simplified architecture:
 * - Read skill markdown file
 * - Replace template variables (e.g., {{taskId}})
 * - Pass to SDK as prompt
 */
export class GenericSkillAgent extends BaseAgent implements SkillAgentInterface {
  /** Agent type identifier */
  readonly type = 'skill' as const;

  /** Agent name for logging */
  readonly name = 'GenericSkillAgent';

  constructor(config: BaseAgentConfig) {
    super(config);
  }

  protected getAgentName(): string {
    return 'GenericSkillAgent';
  }

  /**
   * Execute a skill file with context.
   *
   * @param skillPath - Path to the skill markdown file
   * @param context - Context values for template replacement
   * @yields AgentMessage responses
   */
  async *executeSkill(
    skillPath: string,
    context: SkillContext = {}
  ): AsyncGenerator<AgentMessage> {
    // Resolve skill path relative to workspace
    const resolvedPath = this.resolveSkillPath(skillPath);

    // Read skill file
    const skillContent = await this.readSkillFile(resolvedPath);

    // Replace template variables
    const prompt = this.replaceTemplateVariables(skillContent, context);

    this.logger.debug(
      {
        skillPath: resolvedPath,
        contextKeys: Object.keys(context),
        promptLength: prompt.length,
      },
      'Executing skill'
    );

    // Execute via SDK
    const sdkOptions = this.createSdkOptions({});

    try {
      for await (const { parsed } of this.queryOnce(prompt, sdkOptions)) {
        yield this.formatMessage(parsed);
      }
    } catch (error) {
      yield this.handleIteratorError(error, 'executeSkill');
    }
  }

  /**
   * Resolve skill path to absolute path.
   */
  private resolveSkillPath(skillPath: string): string {
    // If already absolute, use as-is
    if (path.isAbsolute(skillPath)) {
      return skillPath;
    }

    // Resolve relative to workspace directory
    const workspaceDir = Config.getWorkspaceDir();
    return path.resolve(workspaceDir, '..', skillPath);
  }

  /**
   * Read skill file content.
   */
  private async readSkillFile(skillPath: string): Promise<string> {
    try {
      return await fs.readFile(skillPath, 'utf-8');
    } catch (error) {
      this.logger.error({ skillPath, error }, 'Failed to read skill file');
      throw new Error(`Failed to read skill file: ${skillPath}`);
    }
  }

  /**
   * Replace template variables in content.
   *
   * Supports {{variableName}} syntax.
   * Undefined variables are replaced with empty string.
   */
  private replaceTemplateVariables(
    content: string,
    context: SkillContext
  ): string {
    // Add derived paths if taskId and iteration are provided
    const enrichedContext = { ...context };

    if (context.taskId && context.workspaceDir) {
      const taskDir = path.join(context.workspaceDir, 'tasks', context.taskId);

      if (!enrichedContext.taskMdPath) {
        enrichedContext.taskMdPath = path.join(taskDir, 'Task.md');
      }
    }

    // Replace all {{variableName}} patterns
    return content.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const value = enrichedContext[key];
      if (value === undefined || value === null) {
        return '';
      }
      return String(value);
    });
  }

  /**
   * Execute a single task and yield results.
   * Implements SkillAgent interface.
   *
   * @param input - Task input as string or structured data
   * @yields AgentMessage responses
   */
  async *execute(input: string | UserInput[]): AsyncGenerator<AgentMessage> {
    // For direct string input, use as prompt directly
    const prompt: string = typeof input === 'string'
      ? input
      : input.map(u => u.content).join('\n');

    const sdkOptions = this.createSdkOptions({});

    try {
      for await (const { parsed } of this.queryOnce(prompt, sdkOptions)) {
        yield this.formatMessage(parsed);
      }
    } catch (error) {
      yield this.handleIteratorError(error, 'execute');
    }
  }
}
