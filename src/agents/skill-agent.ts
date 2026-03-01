/**
 * SkillAgent - Minimal agent that executes skills from markdown files.
 *
 * This is the simplified implementation as described in Issue #413:
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    Simplified Architecture                   │
 * ├─────────────────────────────────────────────────────────────┤
 * │                                                              │
 * │   TaskController                                             │
 * │        │                                                     │
 * │        ▼                                                     │
 * │   ┌────────────────────────────────────────────┐            │
 * │   │            SkillAgent (通用)                │            │
 * │   │                                            │            │
 * │   │  ┌─────────┐ ┌─────────┐ ┌─────────┐      │            │
 * │   │  │evaluate │ │ execute │ │ report  │      │            │
 * │   │  │  .md    │ │  .md    │ │  .md    │      │            │
 * │   │  └─────────┘ └─────────┘ └─────────┘      │            │
 * │   └────────────────────────────────────────────┘            │
 * │                                                              │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Key Features:
 * - Reads markdown file content as prompt
 * - Passes content directly to SDK (no YAML parsing)
 * - Supports template variable substitution
 * - Minimal implementation (< 100 lines)
 *
 * @module agents/skill-agent
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import type { AgentMessage } from '../types/agent.js';
import { BaseAgent, type BaseAgentConfig } from './base-agent.js';
import type { SkillAgent as SkillAgentInterface, UserInput } from './types.js';

/**
 * Options for SkillAgent execution.
 */
export interface SkillAgentExecuteOptions {
  /** Template variables to substitute in the skill content */
  templateVars?: Record<string, string>;
}

/**
 * Simple template variable substitution.
 * Replaces {variableName} patterns with actual values.
 *
 * @param content - Content with template variables
 * @param vars - Variable name-value pairs
 * @returns Content with variables substituted
 */
function substituteTemplateVars(
  content: string,
  vars: Record<string, string>
): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

/**
 * Minimal SkillAgent that executes skills from markdown files.
 *
 * Design principles (Issue #413):
 * - No YAML frontmatter parsing
 * - No allowedTools configuration
 * - Just read file and pass to SDK
 * - Template variable support for dynamic prompts
 *
 * @example
 * ```typescript
 * // Create agent with skill file
 * const evaluator = new SkillAgent(config, 'skills/evaluator/SKILL.md');
 *
 * // Execute with template variables
 * for await (const msg of evaluator.executeWithContext({
 *   taskId: 'task-123',
 *   iteration: '1',
 * })) {
 *   console.log(msg.content);
 * }
 * ```
 */
export class SkillAgent extends BaseAgent implements SkillAgentInterface {
  /** Agent type identifier */
  readonly type = 'skill' as const;

  /** Agent name for logging (derived from skill file name) */
  readonly name: string;

  /** Path to skill markdown file */
  private skillPath: string;

  /**
   * Create a SkillAgent.
   *
   * @param config - Agent configuration
   * @param skillPath - Path to skill markdown file (relative to workspace or absolute)
   */
  constructor(config: BaseAgentConfig, skillPath: string) {
    super(config);

    // Resolve skill path
    if (path.isAbsolute(skillPath)) {
      this.skillPath = skillPath;
    } else {
      this.skillPath = path.join(Config.getWorkspaceDir(), skillPath);
    }

    // Extract skill name from path for logging
    this.name = path.basename(skillPath, '.md');

    this.logger.debug({ skillPath: this.skillPath }, 'SkillAgent created');
  }

  protected getAgentName(): string {
    return this.name;
  }

  /**
   * Initialize the SkillAgent.
   * Minimal implementation - just mark as initialized.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.logger.debug({ skillPath: this.skillPath }, 'SkillAgent initialized');
  }

  /**
   * Execute the skill with optional template variables.
   *
   * Reads the skill file, substitutes template variables, and streams responses.
   *
   * @param options - Execution options with template variables
   * @yields AgentMessage responses
   */
  async *executeWithContext(
    options: SkillAgentExecuteOptions = {}
  ): AsyncGenerator<AgentMessage> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Read skill file
    const skillContent = await fs.readFile(this.skillPath, 'utf-8');

    // Substitute template variables if provided
    const prompt = options.templateVars
      ? substituteTemplateVars(skillContent, options.templateVars)
      : skillContent;

    this.logger.debug(
      {
        skillPath: this.skillPath,
        promptLength: prompt.length,
        templateVars: options.templateVars,
      },
      'Executing skill'
    );

    // Create SDK options (no special configuration needed)
    const sdkOptions = this.createSdkOptions({});

    try {
      for await (const { parsed } of this.queryOnce(prompt, sdkOptions)) {
        yield this.formatMessage(parsed);
      }
    } catch (error) {
      yield this.handleIteratorError(error, 'executeWithContext');
    }
  }

  /**
   * Execute a single task and yield results.
   * Implements SkillAgent interface.
   *
   * @param input - Task input (if string, used as additional context)
   * @yields AgentMessage responses
   */
  async *execute(input: string | UserInput[]): AsyncGenerator<AgentMessage> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Read skill file
    const skillContent = await fs.readFile(this.skillPath, 'utf-8');

    // Build prompt: skill content + input
    let prompt: string;
    if (typeof input === 'string') {
      prompt = `${skillContent}\n\n---\n\n## Input\n\n${input}`;
    } else {
      const inputText = input.map(u => u.content).join('\n');
      prompt = `${skillContent}\n\n---\n\n## Input\n\n${inputText}`;
    }

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
