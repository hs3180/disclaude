/**
 * Agent Mode Management.
 *
 * Provides per-chatId mode switching between 'normal' and 'research' modes.
 *
 * Issue #1709: Research Mode — Phase 1 (Mode switching framework + CWD + SOUL)
 *
 * When research mode is active for a chatId:
 * - The agent's working directory is switched to `workspace/research/{topic}/`
 * - A CLAUDE.md with research behavior norms is injected (via SDK settingSources)
 * - Mode state is persisted per-chatId
 *
 * Architecture:
 *   ResearchModeManager
 *     └── Map<chatId, ResearchModeState>
 *             ├── topic: string
 *             ├── workspaceDir: string
 *             └── enteredAt: Date
 *
 * @module modes/agent-mode
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ResearchMode');

/**
 * Agent operating modes.
 *
 * - `normal`: Default mode — standard workspace, full skill set
 * - `research`: Research mode — isolated workspace, research SOUL, focused skills
 */
export type AgentMode = 'normal' | 'research';

/**
 * State stored for each chatId in research mode.
 */
export interface ResearchModeState {
  /** Research topic (used as directory name and in prompts) */
  topic: string;
  /** Absolute path to the research workspace directory */
  workspaceDir: string;
  /** Timestamp when research mode was entered */
  enteredAt: Date;
}

/**
 * Result of entering research mode.
 */
export interface EnterResearchModeResult {
  /** The research workspace directory path */
  workspaceDir: string;
  /** The path to the created CLAUDE.md (SOUL) file */
  soulFilePath: string;
}

/**
 * Options for entering research mode.
 */
export interface EnterResearchModeOptions {
  /** Research topic description */
  topic: string;
  /** Base workspace directory (defaults to Config.getWorkspaceDir()) */
  workspaceBaseDir?: string;
}

/** Default research directory name under workspace root. */
const RESEARCH_DIR_NAME = 'research';

/** Default CLAUDE.md content for research mode (SOUL). */
const RESEARCH_CLAUDE_MD = `# Research Mode

You are operating in **Research Mode**. Follow these behavior norms:

## Research Behavior

- Focus on systematic investigation and evidence gathering
- Document all findings with source references
- Maintain objectivity — present multiple perspectives when relevant
- Track open questions and unresolved issues explicitly

## Directory Conventions

- \`notes/\` — Research notes and intermediate artifacts
- \`sources/\` — Collected source materials and references
- \`RESEARCH.md\` — Research state file (auto-maintained)

## Guidelines

- Prefer depth over breadth in investigation
- Summarize key findings before moving to next topic
- Flag assumptions and areas of uncertainty
- Use structured formatting (tables, lists) for findings
`;

/**
 * ResearchModeManager — manages per-chatId agent mode state.
 *
 * Follows the same pattern as passive mode management but with
 * additional state (topic, workspaceDir).
 *
 * @example
 * ```typescript
 * const manager = new ResearchModeManager();
 *
 * // Enter research mode
 * const result = await manager.enterResearchMode(chatId, {
 *   topic: 'AI Alignment Techniques',
 *   workspaceBaseDir: '/path/to/workspace',
 * });
 *
 * // Check mode
 * const mode = manager.getMode(chatId); // 'research'
 * const info = manager.getResearchInfo(chatId);
 * // info?.topic === 'AI Alignment Techniques'
 *
 * // Exit research mode
 * manager.exitResearchMode(chatId);
 * const mode2 = manager.getMode(chatId); // 'normal'
 * ```
 */
export class ResearchModeManager {
  private readonly states: Map<string, ResearchModeState> = new Map();

  /**
   * Get the current mode for a chatId.
   *
   * @param chatId - Chat identifier
   * @returns Current mode ('normal' or 'research')
   */
  getMode(chatId: string): AgentMode {
    return this.states.has(chatId) ? 'research' : 'normal';
  }

  /**
   * Check if research mode is active for a chatId.
   *
   * @param chatId - Chat identifier
   * @returns true if research mode is active
   */
  isResearchMode(chatId: string): boolean {
    return this.states.has(chatId);
  }

  /**
   * Get research mode state for a chatId.
   *
   * @param chatId - Chat identifier
   * @returns Research mode state, or undefined if not in research mode
   */
  getResearchInfo(chatId: string): ResearchModeState | undefined {
    return this.states.get(chatId);
  }

  /**
   * Enter research mode for a chatId.
   *
   * Creates the research workspace directory and injects a CLAUDE.md
   * (SOUL) file with research behavior norms. The CLAUDE.md is picked up
   * by the SDK via `settingSources: ['project']`.
   *
   * @param chatId - Chat identifier
   * @param options - Research mode options
   * @returns Result with workspace directory and SOUL file paths
   * @throws Error if topic is empty
   */
  async enterResearchMode(
    chatId: string,
    options: EnterResearchModeOptions
  ): Promise<EnterResearchModeResult> {
    const { topic, workspaceBaseDir } = options;

    if (!topic || !topic.trim()) {
      throw new Error('Research topic is required');
    }

    const trimmedTopic = topic.trim();
    const baseDir = workspaceBaseDir ?? process.cwd();
    const researchDir = path.resolve(baseDir, RESEARCH_DIR_NAME);
    const topicDir = path.join(researchDir, sanitizeTopicName(trimmedTopic));
    const soulFilePath = path.join(topicDir, 'CLAUDE.md');

    // Create research workspace directory
    await fs.mkdir(topicDir, { recursive: true });

    // Create CLAUDE.md (SOUL) — only write if not already present
    // to preserve user modifications
    try {
      await fs.access(soulFilePath);
      logger.debug({ chatId, soulFilePath }, 'CLAUDE.md already exists, skipping');
    } catch {
      await fs.writeFile(soulFilePath, RESEARCH_CLAUDE_MD, 'utf-8');
      logger.info({ chatId, soulFilePath }, 'Created CLAUDE.md (Research SOUL)');
    }

    // Also create sub-directories for research workflow
    for (const subDir of ['notes', 'sources']) {
      const subPath = path.join(topicDir, subDir);
      await fs.mkdir(subPath, { recursive: true });
    }

    // Store state
    const state: ResearchModeState = {
      topic: trimmedTopic,
      workspaceDir: topicDir,
      enteredAt: new Date(),
    };
    this.states.set(chatId, state);

    logger.info(
      { chatId, topic: trimmedTopic, workspaceDir: topicDir },
      'Entered research mode'
    );

    return { workspaceDir: topicDir, soulFilePath };
  }

  /**
   * Exit research mode for a chatId.
   *
   * Removes the mode state but does NOT delete the research workspace
   * directory — the user's research data is preserved.
   *
   * @param chatId - Chat identifier
   * @returns true if was in research mode, false otherwise
   */
  exitResearchMode(chatId: string): boolean {
    const hadState = this.states.has(chatId);
    this.states.delete(chatId);

    if (hadState) {
      logger.info({ chatId }, 'Exited research mode');
    }

    return hadState;
  }

  /**
   * Clear all mode states (e.g., on shutdown).
   */
  clearAll(): void {
    this.states.clear();
    logger.debug('Cleared all research mode states');
  }

  /**
   * Get all chatIds currently in research mode.
   *
   * @returns Array of chatId strings
   */
  getActiveResearchChats(): string[] {
    return Array.from(this.states.keys());
  }
}

/**
 * Sanitize a topic name for use as a directory name.
 *
 * Rules:
 * - Lowercased
 * - Spaces and underscores replaced with hyphens
 * - Non-alphanumeric characters (except CJK, hyphens) removed
 * - Maximum 64 characters
 * - Fallback to 'untitled' if result is empty
 *
 * @param topic - Raw topic string
 * @returns Sanitized directory name
 */
export function sanitizeTopicName(topic: string): string {
  // Lowercase
  let sanitized = topic.toLowerCase().trim();

  // Replace spaces and underscores with hyphens
  sanitized = sanitized.replace(/[\s_]+/g, '-');

  // Remove non-alphanumeric characters except CJK, hyphens
  // CJK ranges: \u4e00-\u9fff (CJK Unified), \u3040-\u30ff (Hiragana/Katakana)
  sanitized = sanitized.replace(/[^\w\u4e00-\u9fff\u3040-\u30ff-]/g, '');

  // Collapse multiple hyphens
  sanitized = sanitized.replace(/-+/g, '-');

  // Trim leading/trailing hyphens
  sanitized = sanitized.replace(/^-+|-+$/g, '');

  // Limit length
  if (sanitized.length > 64) {
    sanitized = sanitized.slice(0, 64).replace(/-+$/, '');
  }

  // Fallback
  if (!sanitized) {
    sanitized = 'untitled';
  }

  return sanitized;
}
