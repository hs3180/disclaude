/**
 * SkillAgent - Generic agent that executes skills from markdown files.
 *
 * This is the unified agent implementation as described in Issue #413:
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
 * - Loads skill configuration from markdown files
 * - Parses YAML frontmatter for tool configuration
 * - Single generic agent replaces Evaluator/Executor/Reporter classes
 * - Easy to customize via skill files without code changes
 *
 * @module agents/skill-agent
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import type { AgentMessage } from '../types/agent.js';
import { BaseAgent, type BaseAgentConfig } from './base-agent.js';
import type { SkillAgent as SkillAgentInterface, UserInput } from './types.js';
import { createFeishuSdkMcpServer } from '../mcp/feishu-context-mcp.js';

// ============================================================================
// Skill File Types
// ============================================================================

/**
 * Parsed skill configuration from markdown file.
 */
export interface SkillConfig {
  /** Skill name */
  name: string;
  /** Skill description */
  description: string;
  /** Allowed tools list */
  allowedTools: string[];
  /** Disallowed tools list */
  disallowedTools?: string[];
  /** Skill prompt content (markdown body) */
  prompt: string;
}

/**
 * Options for SkillAgent execution.
 */
export interface SkillAgentExecuteOptions {
  /** Task ID for context */
  taskId?: string;
  /** Iteration number */
  iteration?: number;
  /** Chat ID for feedback */
  chatId?: string;
  /** Additional template variables */
  templateVars?: Record<string, string>;
}

// ============================================================================
// Skill File Parser
// ============================================================================

/**
 * Parse skill configuration from markdown file.
 *
 * Supports YAML frontmatter format:
 * ```markdown
 * ---
 * name: skill-name
 * description: Skill description
 * allowedTools:
 *   - Read
 *   - Write
 * ---
 *
 * # Skill Prompt
 * ...
 * ```
 *
 * @param filePath - Path to skill markdown file
 * @returns Parsed skill configuration
 */
export async function parseSkillFile(filePath: string): Promise<SkillConfig> {
  const content = await fs.readFile(filePath, 'utf-8');

  // Parse YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!frontmatterMatch) {
    throw new Error(`Invalid skill file format: ${filePath}. Expected YAML frontmatter.`);
  }

  const [, frontmatter, prompt] = frontmatterMatch;

  // Simple YAML parser for frontmatter
  const config = parseYamlFrontmatter(frontmatter);

  if (!config.name) {
    throw new Error(`Skill file missing 'name' field: ${filePath}`);
  }

  return {
    name: config.name as string,
    description: (config.description as string) || '',
    allowedTools: (config.allowedTools as string[]) || [],
    disallowedTools: config.disallowedTools as string[] | undefined,
    prompt: prompt.trim(),
  };
}

/**
 * Simple YAML frontmatter parser.
 * Handles basic key-value pairs and arrays.
 */
function parseYamlFrontmatter(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    // Array item
    if (line.match(/^  - (.+)$/)) {
      if (currentKey && currentArray) {
        currentArray.push(line.trim().substring(2));
      }
      continue;
    }

    // Key-value pair
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      // Save previous array if any
      if (currentKey && currentArray) {
        result[currentKey] = currentArray;
        currentArray = null;
      }

      const [, key, value] = match;
      currentKey = key;

      if (value === '') {
        // Start of array
        currentArray = [];
      } else {
        // Simple value
        result[key] = value;
        currentKey = null;
      }
    }
  }

  // Save last array if any
  if (currentKey && currentArray) {
    result[currentKey] = currentArray;
  }

  return result;
}

// ============================================================================
// Skill Agent Implementation
// ============================================================================

/**
 * Generic SkillAgent that executes skills from markdown files.
 *
 * Replaces the specialized Evaluator/Executor/Reporter classes with
 * a single unified agent that reads skill configuration from files.
 *
 * @example
 * ```typescript
 * // Create agent with skill file
 * const evaluator = new SkillAgent(config, 'skills/evaluate.md');
 *
 * // Execute with context
 * for await (const msg of evaluator.executeWithContext({
 *   taskId: 'task-123',
 *   iteration: 1,
 * })) {
 *   console.log(msg.content);
 * }
 * ```
 */
export class SkillAgent extends BaseAgent implements SkillAgentInterface {
  /** Agent type identifier */
  readonly type = 'skill' as const;

  /** Agent name for logging */
  readonly name: string;

  /** Loaded skill configuration */
  private skillConfig: SkillConfig | null = null;

  /** Path to skill file */
  private skillPath: string;

  /** MCP servers for this skill */
  private mcpServers: Record<string, unknown> = {};

  /**
   * Create a SkillAgent.
   *
   * @param config - Agent configuration
   * @param skillPath - Path to skill markdown file (relative to skills dir or absolute)
   */
  constructor(config: BaseAgentConfig, skillPath: string) {
    super(config);

    // Resolve skill path
    if (path.isAbsolute(skillPath)) {
      this.skillPath = skillPath;
    } else {
      this.skillPath = path.join(Config.getWorkspaceDir(), 'skills', skillPath);
    }

    // Extract skill name from path for logging
    this.name = path.basename(skillPath, '.md');

    this.logger.debug({ skillPath: this.skillPath }, 'SkillAgent created');
  }

  protected getAgentName(): string {
    return this.name;
  }

  /**
   * Load and initialize the skill configuration.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Load skill file
    this.skillConfig = await parseSkillFile(this.skillPath);

    // Setup MCP servers if needed
    if (this.skillConfig.allowedTools.includes('send_user_feedback') ||
        this.skillConfig.allowedTools.includes('send_file_to_feishu')) {
      this.mcpServers = {
        'feishu-context': createFeishuSdkMcpServer(),
      };
    }

    this.initialized = true;

    this.logger.debug(
      {
        skillName: this.skillConfig.name,
        allowedTools: this.skillConfig.allowedTools,
      },
      'SkillAgent initialized'
    );
  }

  /**
   * Get the skill configuration.
   */
  getSkillConfig(): SkillConfig {
    if (!this.skillConfig) {
      throw new Error('Skill not initialized. Call initialize() first.');
    }
    return this.skillConfig;
  }

  /**
   * Build prompt from skill template and context.
   */
  private buildPrompt(options: SkillAgentExecuteOptions): string {
    if (!this.skillConfig) {
      throw new Error('Skill not initialized. Call initialize() first.');
    }

    let prompt = this.skillConfig.prompt;

    // Replace template variables
    const vars: Record<string, string> = {
      taskId: options.taskId || '',
      iteration: String(options.iteration || 1),
      chatId: options.chatId || '',
      ...options.templateVars,
    };

    for (const [key, value] of Object.entries(vars)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }

    return prompt;
  }

  /**
   * Execute the skill with context.
   *
   * @param options - Execution options including task context
   * @yields AgentMessage responses
   */
  async *executeWithContext(options: SkillAgentExecuteOptions): AsyncGenerator<AgentMessage> {
    if (!this.initialized) {
      await this.initialize();
    }

    const prompt = this.buildPrompt(options);

    const sdkOptions = this.createSdkOptions({
      allowedTools: this.skillConfig!.allowedTools,
      disallowedTools: this.skillConfig!.disallowedTools,
      mcpServers: this.mcpServers,
    });

    this.logger.debug(
      {
        skillName: this.skillConfig!.name,
        promptLength: prompt.length,
        options,
      },
      'Executing skill'
    );

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
   * @param input - Task input as string or structured data
   * @yields AgentMessage responses
   */
  async *execute(input: string | UserInput[]): AsyncGenerator<AgentMessage> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Convert input to prompt
    const prompt: string = typeof input === 'string'
      ? input
      : input.map(u => u.content).join('\n');

    const sdkOptions = this.createSdkOptions({
      allowedTools: this.skillConfig!.allowedTools,
      disallowedTools: this.skillConfig!.disallowedTools,
      mcpServers: this.mcpServers,
    });

    try {
      for await (const { parsed } of this.queryOnce(prompt, sdkOptions)) {
        yield this.formatMessage(parsed);
      }
    } catch (error) {
      yield this.handleIteratorError(error, 'execute');
    }
  }
}

// ============================================================================
// Skill Agent Factory
// ============================================================================

/**
 * Factory for creating skill agents.
 */
export class SkillAgentFactory {
  private config: BaseAgentConfig;
  private skillsDir: string;

  constructor(config: BaseAgentConfig, skillsDir?: string) {
    this.config = config;
    this.skillsDir = skillsDir || path.join(Config.getWorkspaceDir(), 'skills');
  }

  /**
   * Create an evaluator skill agent.
   */
  createEvaluator(): SkillAgent {
    return new SkillAgent(this.config, path.join(this.skillsDir, 'evaluate.md'));
  }

  /**
   * Create an executor skill agent.
   */
  createExecutor(): SkillAgent {
    return new SkillAgent(this.config, path.join(this.skillsDir, 'execute.md'));
  }

  /**
   * Create a reporter skill agent.
   */
  createReporter(): SkillAgent {
    return new SkillAgent(this.config, path.join(this.skillsDir, 'report.md'));
  }

  /**
   * Create a skill agent for any skill file.
   */
  create(skillName: string): SkillAgent {
    return new SkillAgent(this.config, path.join(this.skillsDir, `${skillName}.md`));
  }
}

// ============================================================================
// Exports
// ============================================================================

export default SkillAgent;
