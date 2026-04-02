/**
 * Mode Manager - Manages agent operating modes per chat session.
 *
 * Issue #1709: Implements the mode switching framework for Research Mode.
 *
 * Each chat session can operate in one of two modes:
 * - `normal`: Default mode for everyday conversation
 * - `research`: Isolated research space with dedicated SOUL, cwd, and skill set
 *
 * Mode state is tracked per chatId and persists until:
 * - Explicit mode switch command
 * - Session reset (/reset)
 *
 * Architecture:
 * ```
 * ModeManager (singleton)
 *   └── Map<chatId, ModeState>
 *         ├── mode: 'normal' | 'research'
 *         ├── topic: string (research topic, only in research mode)
 *         ├── cwd: string (research working directory)
 *         └── switchedAt: Date
 * ```
 *
 * @module agents/mode-manager
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, type Logger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import { findSkill, readSkillContent } from '../skills/finder.js';
import type { AgentMode, ResearchModeConfig } from '../config/types.js';

/**
 * State of a mode for a single chat session.
 */
export interface ModeState {
  /** Current agent mode */
  mode: AgentMode;
  /** Research topic (only meaningful when mode is 'research') */
  topic?: string;
  /** Resolved working directory for current mode */
  cwd: string;
  /** Timestamp when mode was last switched */
  switchedAt: Date;
  /** Research SOUL content (loaded from skill, only in research mode) */
  soulContent?: string;
}

/**
 * Result of a mode switch operation.
 */
export interface ModeSwitchResult {
  /** Whether the switch was successful */
  success: boolean;
  /** The new mode */
  mode: AgentMode;
  /** Human-readable message describing the result */
  message: string;
  /** The resolved working directory */
  cwd?: string;
}

/**
 * Mode Manager for per-chat session mode management.
 *
 * Tracks the operating mode for each chatId and handles mode switching
 * with SOUL content loading and working directory resolution.
 */
export class ModeManager {
  private readonly logger: Logger;
  private readonly modeStates = new Map<string, ModeState>();
  private readonly researchConfig: ResearchModeConfig | null;

  constructor() {
    this.logger = createLogger('ModeManager');
    this.researchConfig = Config.getResearchModeConfig();
  }

  /**
   * Get the current mode for a chat session.
   *
   * @param chatId - Chat session identifier
   * @returns Current mode state
   */
  getMode(chatId: string): ModeState {
    if (!this.modeStates.has(chatId)) {
      this.modeStates.set(chatId, {
        mode: 'normal',
        cwd: Config.getWorkspaceDir(),
        switchedAt: new Date(),
      });
    }
    return this.modeStates.get(chatId)!;
  }

  /**
   * Check if research mode feature is enabled.
   *
   * @returns true if research mode is configured and enabled
   */
  isResearchModeEnabled(): boolean {
    return this.researchConfig !== null;
  }

  /**
   * Get the research mode configuration.
   *
   * @returns Research mode config, or null if disabled
   */
  getResearchConfig(): ResearchModeConfig | null {
    return this.researchConfig;
  }

  /**
   * Switch to research mode for a chat session.
   *
   * Activates research mode by:
   * 1. Resolving the research working directory (creates if needed)
   * 2. Loading the research SOUL skill content
   * 3. Updating the mode state
   *
   * @param chatId - Chat session identifier
   * @param topic - Research topic (used for directory naming)
   * @returns Mode switch result
   */
  async switchToResearch(chatId: string, topic: string): Promise<ModeSwitchResult> {
    if (!this.researchConfig) {
      return {
        success: false,
        mode: 'normal',
        message: '❌ Research mode is not enabled. Configure `researchMode` in disclaude.config.yaml to enable it.',
      };
    }

    if (!topic || !topic.trim()) {
      return {
        success: false,
        mode: this.getMode(chatId).mode,
        message: '❌ Research topic is required. Usage: `/research <topic>`',
      };
    }

    const sanitizedTopic = this.sanitizeTopic(topic.trim());
    const cwdPattern = this.researchConfig.cwdPattern ?? 'research/{topic}';
    const researchDir = path.resolve(
      Config.getWorkspaceDir(),
      cwdPattern.replace('{topic}', sanitizedTopic)
    );

    // Create research directory if it doesn't exist
    try {
      await fs.mkdir(researchDir, { recursive: true });
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, researchDir }, 'Failed to create research directory');
      return {
        success: false,
        mode: this.getMode(chatId).mode,
        message: `❌ Failed to create research directory: ${err.message}`,
      };
    }

    // Load research SOUL content
    let soulContent: string | undefined;
    const soulSkillName = this.researchConfig.soulSkill ?? 'research-mode';
    try {
      soulContent = await readSkillContent(soulSkillName) ?? undefined;
      if (soulContent) {
        this.logger.info({ soulSkillName }, 'Loaded research SOUL skill');
      } else {
        this.logger.warn({ soulSkillName }, 'Research SOUL skill not found, using defaults');
      }
    } catch (error) {
      this.logger.warn({ error, soulSkillName }, 'Failed to load research SOUL skill');
    }

    const state: ModeState = {
      mode: 'research',
      topic: sanitizedTopic,
      cwd: researchDir,
      switchedAt: new Date(),
      soulContent,
    };

    this.modeStates.set(chatId, state);

    this.logger.info(
      { chatId, topic: sanitizedTopic, cwd: researchDir },
      'Switched to research mode'
    );

    return {
      success: true,
      mode: 'research',
      message: `🔬 **Research Mode Activated**\n\n- **Topic**: ${sanitizedTopic}\n- **Working Directory**: \`${researchDir}\`\n- **SOUL**: ${soulContent ? `Loaded (${soulSkillName})` : 'Default'}\n\nUse \`/mode normal\` to return to normal mode.`,
      cwd: researchDir,
    };
  }

  /**
   * Switch back to normal mode for a chat session.
   *
   * @param chatId - Chat session identifier
   * @returns Mode switch result
   */
  switchToNormal(chatId: string): ModeSwitchResult {
    const currentState = this.getMode(chatId);

    if (currentState.mode === 'normal') {
      return {
        success: true,
        mode: 'normal',
        message: 'ℹ️ Already in normal mode.',
        cwd: Config.getWorkspaceDir(),
      };
    }

    const previousTopic = currentState.topic;

    const state: ModeState = {
      mode: 'normal',
      cwd: Config.getWorkspaceDir(),
      switchedAt: new Date(),
    };

    this.modeStates.set(chatId, state);

    this.logger.info(
      { chatId, previousTopic },
      'Switched to normal mode'
    );

    return {
      success: true,
      mode: 'normal',
      message: previousTopic
        ? `✅ Returned to normal mode. Research on "${previousTopic}" has been saved in the research directory.`
        : '✅ Returned to normal mode.',
      cwd: Config.getWorkspaceDir(),
    };
  }

  /**
   * Switch mode based on a command string.
   *
   * Supports:
   * - `/research <topic>` - Switch to research mode
   * - `/mode normal` - Switch to normal mode
   * - `/mode research <topic>` - Switch to research mode (alias)
   *
   * @param chatId - Chat session identifier
   * @param command - The mode command string
   * @returns Mode switch result, or null if not a mode command
   */
  async handleModeCommand(chatId: string, command: string): Promise<ModeSwitchResult | null> {
    const trimmed = command.trim();

    // Match /research <topic>
    const researchMatch = trimmed.match(/^\/research\s+(.+)$/i);
    if (researchMatch) {
      return this.switchToResearch(chatId, researchMatch[1]);
    }

    // Match /mode normal
    if (/^\/mode\s+normal$/i.test(trimmed)) {
      return this.switchToNormal(chatId);
    }

    // Match /mode research <topic>
    const modeResearchMatch = trimmed.match(/^\/mode\s+research\s+(.+)$/i);
    if (modeResearchMatch) {
      return this.switchToResearch(chatId, modeResearchMatch[1]);
    }

    // Not a mode command
    return null;
  }

  /**
   * Clear mode state for a chat session.
   *
   * Called when a session is reset or disposed.
   *
   * @param chatId - Chat session identifier
   */
  clearMode(chatId: string): void {
    this.modeStates.delete(chatId);
    this.logger.debug({ chatId }, 'Cleared mode state');
  }

  /**
   * Clear all mode states.
   */
  clearAll(): void {
    this.modeStates.clear();
    this.logger.debug('Cleared all mode states');
  }

  /**
   * Sanitize a research topic for use in directory names.
   *
   * Removes or replaces characters that are unsafe for file paths.
   *
   * @param topic - Raw topic string
   * @returns Sanitized topic safe for directory names
   */
  private sanitizeTopic(topic: string): string {
    return topic
      .replace(/[<>:"/\\|?*]/g, '-')  // Replace unsafe chars with hyphen
      .replace(/\s+/g, '-')            // Replace whitespace with hyphen
      .replace(/-+/g, '-')             // Collapse multiple hyphens
      .replace(/^-+|-+$/g, '')        // Trim leading/trailing hyphens
      .substring(0, 100)               // Limit length
      || 'untitled';                   // Fallback for empty result
  }

  /**
   * Get the current mode as a string label.
   *
   * @param chatId - Chat session identifier
   * @returns Human-readable mode label
   */
  getModeLabel(chatId: string): string {
    const state = this.getMode(chatId);
    if (state.mode === 'research') {
      return `research (${state.topic})`;
    }
    return 'normal';
  }
}
