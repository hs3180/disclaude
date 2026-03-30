/**
 * Research Mode Manager.
 *
 * Manages research mode state per chat.
 * Issue #1709: Research 模式 — SOUL + 工作目录 + Skill 套装切换
 *
 * When research mode is enabled for a chat:
 * - Creates a dedicated research workspace at workspace/research/<topic>/
 * - Sets up .claude/ directory with research-specific skills
 * - Creates CLAUDE.md with research guidelines (acts as "Research SOUL")
 * - The agent for that chat uses the research cwd for SDK invocation
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger, setupResearchWorkspace } from '@disclaude/core';

const logger = createLogger('ResearchMode');

/**
 * Research mode state for a single chat.
 */
interface ResearchState {
  /** Research topic */
  topic: string;
  /** Absolute path to the research working directory */
  researchCwd: string;
  /** Timestamp when research mode was enabled */
  enabledAt: number;
}

/**
 * Research Mode Manager.
 *
 * Manages per-chat research mode state, including:
 * - Workspace creation for research topics
 * - Research cwd tracking
 * - Mode enable/disable lifecycle
 */
export class ResearchModeManager {
  /**
   * Research mode state storage.
   * Key: chatId, Value: research state
   */
  private researchStates: Map<string, ResearchState> = new Map();

  /**
   * Check if research mode is enabled for a specific chat.
   *
   * @param chatId - Chat ID to check
   * @returns true if research mode is enabled
   */
  isEnabled(chatId: string): boolean {
    return this.researchStates.has(chatId);
  }

  /**
   * Get the research topic for a chat.
   *
   * @param chatId - Chat ID to check
   * @returns Research topic string or undefined if not in research mode
   */
  getTopic(chatId: string): string | undefined {
    return this.researchStates.get(chatId)?.topic;
  }

  /**
   * Get the research working directory for a chat.
   *
   * @param chatId - Chat ID to check
   * @returns Absolute path to research cwd or undefined if not in research mode
   */
  getResearchCwd(chatId: string): string | undefined {
    return this.researchStates.get(chatId)?.researchCwd;
  }

  /**
   * Enable research mode for a chat.
   *
   * Creates the research workspace directory with:
   * - .claude/ directory structure
   * - Research SOUL.md (CLAUDE.md with research guidelines)
   * - Research-specific skill subset
   *
   * @param chatId - Chat ID to enable research mode for
   * @param topic - Research topic (used as directory name)
   * @returns Absolute path to the created research working directory
   */
  enable(chatId: string, topic: string): string {
    // Sanitize topic for use as directory name
    const sanitizedTopic = topic
      .replace(/[<>:"/\\|?*]/g, '_')  // Remove invalid file chars
      .replace(/\s+/g, '_')            // Replace spaces with underscores
      .slice(0, 100);                  // Limit length

    // Set up research workspace (creates directory, CLAUDE.md, skills)
    const result = setupResearchWorkspace(sanitizedTopic, topic);

    const state: ResearchState = {
      topic,
      researchCwd: result.researchCwd,
      enabledAt: Date.now(),
    };

    this.researchStates.set(chatId, state);
    logger.info({ chatId, topic, researchCwd: result.researchCwd }, 'Research mode enabled');

    return result.researchCwd;
  }

  /**
   * Disable research mode for a chat.
   *
   * @param chatId - Chat ID to disable research mode for
   */
  disable(chatId: string): void {
    const state = this.researchStates.get(chatId);
    if (state) {
      logger.info({ chatId, topic: state.topic, researchCwd: state.researchCwd }, 'Research mode disabled');
      this.researchStates.delete(chatId);
    }
  }

  /**
   * Get all chats with research mode enabled.
   *
   * @returns Array of chat IDs with research mode enabled
   */
  getResearchModeChats(): string[] {
    return Array.from(this.researchStates.keys());
  }
}
