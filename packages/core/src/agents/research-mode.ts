/**
 * Research Mode Manager - Handles research mode lifecycle and directory management.
 *
 * This module manages the research mode state for agents:
 * - Creates and initializes research working directories
 * - Generates research-specific CLAUDE.md (SOUL) templates
 * - Provides mode state tracking per chatId
 *
 * Issue #1709 - Research Mode Phase 1: Mode switching framework.
 *
 * @module agents/research-mode
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, type Logger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import type { AgentMode, ResearchModeState } from './types.js';

const logger = createLogger('ResearchMode');

/**
 * Default CLAUDE.md template for research mode.
 *
 * This template is written to the research working directory as CLAUDE.md,
 * which the SDK loads via settingSources: ['project'] as the system prompt context.
 *
 * It defines research behavior norms including directory access restrictions
 * (prompt-level only — no SDK-level enforcement in Phase 1).
 */
const DEFAULT_RESEARCH_CLAUDE_MD = `# Research Mode

You are in **Research Mode** — an isolated research environment.

## Research Behavior Norms

### Directory Access
- Only access files within the current research working directory and its subdirectories.
- Do NOT access other project files in the workspace.
- Do NOT access system directories or paths outside the research directory.

### Research Methodology
1. **Define scope**: Clearly identify what you're researching.
2. **Systematic search**: Use web search and available tools to gather information.
3. **Organize findings**: Save key findings as files in this directory.
4. **Track progress**: Update this file or create RESEARCH.md to track research status.
5. **Summarize**: Provide clear, structured summaries of findings.

### Output Guidelines
- Save research notes as markdown files in this directory.
- Use descriptive filenames (e.g., \`findings-topic-name.md\`).
- Include sources and timestamps in your notes.
- Keep the research directory organized with clear file structure.

### Exit Research Mode
When research is complete, the user will exit research mode.
Summarize key findings before exiting.
`;

/**
 * Result of entering research mode.
 */
export interface EnterResearchResult {
  /** Absolute path to the research directory */
  researchDir: string;
  /** Path to the CLAUDE.md file in the research directory */
  claudeMdPath: string;
  /** Whether the directory was newly created */
  created: boolean;
}

/**
 * Research Mode Manager.
 *
 * Manages research mode state and directory lifecycle for agents.
 * Thread-safe by design — each chatId has its own state.
 *
 * @example
 * ```typescript
 * const manager = new ResearchModeManager();
 *
 * // Enter research mode
 * const result = await manager.enterResearch(chatId, 'ai-safety');
 * // result.researchDir = '/workspace/research/ai-safety'
 *
 * // Check mode
 * const state = manager.getState(chatId);
 * // state.mode = 'research'
 *
 * // Exit research mode
 * manager.exitResearch(chatId);
 * // state.mode = 'normal'
 * ```
 */
export class ResearchModeManager {
  private readonly states = new Map<string, ResearchModeState>();
  private readonly log: Logger;

  constructor(options?: { logger?: Logger }) {
    this.log = options?.logger || logger;
  }

  /**
   * Get the current mode state for a chatId.
   *
   * @param chatId - Chat identifier
   * @returns Current research mode state
   */
  getState(chatId: string): ResearchModeState {
    let state = this.states.get(chatId);
    if (!state) {
      state = { mode: 'normal' };
      this.states.set(chatId, state);
    }
    return state;
  }

  /**
   * Get the current agent mode for a chatId.
   *
   * @param chatId - Chat identifier
   * @returns Current agent mode ('normal' or 'research')
   */
  getMode(chatId: string): AgentMode {
    return this.getState(chatId).mode;
  }

  /**
   * Check if a chatId is in research mode.
   *
   * @param chatId - Chat identifier
   * @returns true if in research mode
   */
  isResearchMode(chatId: string): boolean {
    return this.getMode(chatId) === 'research';
  }

  /**
   * Get the research directory for a chatId (if in research mode).
   *
   * @param chatId - Chat identifier
   * @returns Absolute path to research directory, or undefined if not in research mode
   */
  getResearchDir(chatId: string): string | undefined {
    return this.getState(chatId).researchDir;
  }

  /**
   * Enter research mode for a chatId.
   *
   * Creates the research working directory and initializes it with a
   * CLAUDE.md file containing research behavior norms.
   *
   * @param chatId - Chat identifier
   * @param topic - Research topic name (used as directory name)
   * @returns Result with research directory path and creation status
   * @throws Error if topic is empty or already in research mode
   */
  async enterResearch(chatId: string, topic: string): Promise<EnterResearchResult> {
    const state = this.getState(chatId);

    if (state.mode === 'research') {
      throw new Error(
        `Already in research mode for topic "${state.topic}". ` +
        'Exit research mode first with /research exit.'
      );
    }

    if (!topic || !topic.trim()) {
      throw new Error('Research topic is required. Usage: /research <topic>');
    }

    // Sanitize topic: remove path separators and special characters
    const sanitizedTopic = topic
      .trim()
      .replace(/[\/\\]/g, '-')
      .replace(/[<>:"|?*]/g, '')
      .substring(0, 100);

    // Get research directory path
    const researchDir = Config.getResearchDir(sanitizedTopic);
    const claudeMdPath = path.join(researchDir, 'CLAUDE.md');

    // Check if directory already exists
    let created = false;
    try {
      await fs.access(researchDir);
      this.log.debug({ chatId, researchDir }, 'Research directory already exists');
    } catch {
      // Directory doesn't exist, create it
      await fs.mkdir(researchDir, { recursive: true });
      created = true;
      this.log.info({ chatId, researchDir, topic: sanitizedTopic }, 'Created research directory');
    }

    // Write CLAUDE.md if it doesn't exist (don't overwrite existing)
    try {
      await fs.access(claudeMdPath);
      this.log.debug({ chatId, claudeMdPath }, 'CLAUDE.md already exists, keeping existing');
    } catch {
      // Check for custom template
      const researchConfig = Config.getResearchConfig();
      const template = researchConfig.soulTemplate
        ? await this.loadCustomTemplate(researchConfig.soulTemplate)
        : DEFAULT_RESEARCH_CLAUDE_MD;

      await fs.writeFile(claudeMdPath, template, 'utf-8');
      this.log.info({ chatId, claudeMdPath }, 'Created research CLAUDE.md');
    }

    // Update state
    state.mode = 'research';
    state.topic = sanitizedTopic;
    state.researchDir = researchDir;
    state.activatedAt = Date.now();

    this.log.info(
      { chatId, topic: sanitizedTopic, researchDir },
      'Entered research mode'
    );

    return { researchDir, claudeMdPath, created };
  }

  /**
   * Exit research mode for a chatId.
   *
   * Resets the mode state back to normal. Does NOT delete the research directory.
   *
   * @param chatId - Chat identifier
   * @returns The previous research state (topic, dir) or null if not in research mode
   */
  exitResearch(chatId: string): { topic: string; researchDir: string } | null {
    const state = this.getState(chatId);

    if (state.mode !== 'research') {
      return null;
    }

    const previousState = {
      topic: state.topic ?? '',
      researchDir: state.researchDir ?? '',
    };

    this.log.info(
      { chatId, topic: previousState.topic, researchDir: previousState.researchDir },
      'Exited research mode'
    );

    // Reset state
    state.mode = 'normal';
    state.topic = undefined;
    state.researchDir = undefined;
    state.activatedAt = undefined;

    return previousState;
  }

  /**
   * Clear state for a chatId (e.g., on dispose).
   *
   * @param chatId - Chat identifier
   */
  clearState(chatId: string): void {
    this.states.delete(chatId);
  }

  /**
   * Clear all states (e.g., on shutdown).
   */
  clearAll(): void {
    this.states.clear();
  }

  /**
   * Get all chatIds currently in research mode.
   *
   * @returns Array of chatIds in research mode with their topics
   */
  getActiveResearchSessions(): Array<{ chatId: string; topic: string; researchDir: string }> {
    const sessions: Array<{ chatId: string; topic: string; researchDir: string }> = [];
    for (const [chatId, state] of this.states) {
      if (state.mode === 'research' && state.topic && state.researchDir) {
        sessions.push({
          chatId,
          topic: state.topic,
          researchDir: state.researchDir,
        });
      }
    }
    return sessions;
  }

  /**
   * Load a custom CLAUDE.md template from file.
   *
   * @param templatePath - Path to the custom template file
   * @returns Template content
   * @throws Error if template cannot be read
   */
  private async loadCustomTemplate(templatePath: string): Promise<string> {
    try {
      const content = await fs.readFile(templatePath, 'utf-8');
      this.log.info({ templatePath }, 'Loaded custom research CLAUDE.md template');
      return content;
    } catch (error) {
      const err = error as Error;
      this.log.error({ err, templatePath }, 'Failed to load custom research template, using default');
      return DEFAULT_RESEARCH_CLAUDE_MD;
    }
  }
}
