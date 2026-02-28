/**
 * SkillAgent - Generic skill execution agent.
 *
 * A minimal wrapper that reads skill markdown files and executes them
 * using the SDK. No YAML parsing, no complex configuration.
 *
 * Design Principles (Issue #413):
 * - Read skill markdown file
 * - Pass content to SDK as prompt
 * - Support template variable substitution
 *
 * @module agents/skill-agent
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { BaseAgent, type BaseAgentConfig } from './base-agent.js';
import type { SkillAgent as ISkillAgent, UserInput } from './types.js';
import type { AgentMessage, AgentInput } from '../types/agent.js';
import { Config } from '../config/index.js';

/**
 * Context for skill execution.
 * Used for template variable substitution.
 */
export interface SkillContext {
  /** Task identifier */
  taskId?: string;
  /** Current iteration number */
  iteration?: number;
  /** Chat ID for Feishu tools */
  chatId?: string;
  /** Parent message ID for thread replies */
  parentMessageId?: string;
  /** Additional context variables */
  [key: string]: unknown;
}

/**
 * Configuration for SkillAgentImpl.
 */
export interface SkillAgentImplConfig extends BaseAgentConfig {
  /** Path to the skill markdown file (relative to skills directory or absolute) */
  skillPath: string;
  /** Allowed tools for this skill (optional, defaults to all) */
  allowedTools?: string[];
}

/**
 * SkillAgent - Generic skill execution agent.
 *
 * Minimal implementation:
 * 1. Read skill markdown file
 * 2. Substitute template variables
 * 3. Pass to SDK as prompt
 *
 * @example
 * ```typescript
 * const evaluator = new SkillAgent({
 *   apiKey: 'sk-...',
 *   model: 'claude-3-5-sonnet-20241022',
 *   skillPath: 'evaluator/SKILL.md',
 * });
 *
 * for await (const msg of evaluator.executeWithContext(prompt, { taskId: '123' })) {
 *   console.log(msg.content);
 * }
 * ```
 */
export class SkillAgent extends BaseAgent implements ISkillAgent {
  readonly type = 'skill' as const;
  readonly name: string;

  private skillPath: string;
  private skillContent: string | null = null;
  private allowedTools: string[];

  constructor(config: SkillAgentImplConfig) {
    super(config);

    this.skillPath = config.skillPath;
    this.allowedTools = config.allowedTools ?? [];

    // Extract skill name from directory name (e.g., 'evaluator/SKILL.md' -> 'Evaluator')
    const dirName = path.dirname(this.skillPath);
    const skillDir = dirName === '.' ? path.basename(this.skillPath, '.md') : path.basename(dirName);
    this.name = skillDir.charAt(0).toUpperCase() + skillDir.slice(1);
  }

  protected getAgentName(): string {
    return this.name;
  }

  /**
   * Load skill content from file.
   * Caches the content for subsequent calls.
   */
  private async loadSkill(): Promise<string> {
    if (this.skillContent) {
      return this.skillContent;
    }

    // Resolve skill path
    const skillsDir = Config.getSkillsDir();
    const fullPath = path.isAbsolute(this.skillPath)
      ? this.skillPath
      : path.join(skillsDir, this.skillPath);

    try {
      this.skillContent = await fs.readFile(fullPath, 'utf-8');
      return this.skillContent;
    } catch (error) {
      this.logger.error({ skillPath: fullPath, error }, 'Failed to load skill file');
      throw new Error(`Failed to load skill file: ${fullPath}`);
    }
  }

  /**
   * Substitute template variables in content.
   * Supports {{variable}} syntax.
   */
  private substituteVariables(content: string, context: SkillContext): string {
    return content.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (key in context) {
        return String(context[key] ?? '');
      }
      // Leave unknown variables as-is
      return `{{${key}}}`;
    });
  }

  /**
   * Execute skill with context for template substitution.
   *
   * @param input - Additional prompt/input to append to skill
   * @param context - Context for template variable substitution
   * @yields AgentMessage responses
   */
  async *executeWithContext(
    input: AgentInput,
    context: SkillContext = {}
  ): AsyncGenerator<AgentMessage> {
    // Load skill content
    const skillContent = await this.loadSkill();

    // Substitute template variables
    const processedSkill = this.substituteVariables(skillContent, context);

    // Combine skill with input
    let prompt: string;
    if (typeof input === 'string') {
      prompt = input ? `${processedSkill}\n\n---\n\n${input}` : processedSkill;
    } else {
      // For array input, prepend skill as system message
      prompt = processedSkill;
    }

    // Create SDK options
    const sdkOptions = this.createSdkOptions({
      allowedTools: this.allowedTools.length > 0 ? this.allowedTools : undefined,
    });

    try {
      for await (const { parsed } of this.queryOnce(prompt, sdkOptions)) {
        yield this.formatMessage(parsed);
      }
    } catch (error) {
      yield this.handleIteratorError(error, 'execute');
    }
  }

  /**
   * Execute a single task and yield results.
   * Implements SkillAgent interface.
   *
   * @param input - Task input as string or structured data
   * @yields AgentMessage responses
   */
  async *execute(input: string | UserInput[]): AsyncGenerator<AgentMessage> {
    // Convert UserInput[] to string if needed
    const prompt: string = typeof input === 'string'
      ? input
      : input.map(u => u.content).join('\n');

    yield* this.executeWithContext(prompt);
  }

  /**
   * Get the raw skill content.
   * Useful for debugging or inspection.
   */
  async getSkillContent(): Promise<string> {
    return this.loadSkill();
  }
}
