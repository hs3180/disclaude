/**
 * ModeManager - Per-chat agent mode state management.
 *
 * Issue #1709: Research Mode - SOUL + cwd + Skill set switching.
 *
 * Manages mode switching between normal and research modes
 * on a per-chat basis. Each chat session can independently
 * switch modes without affecting other sessions.
 *
 * Design principles:
 * - Per-chat isolation: Each chatId has independent mode state
 * - Immutable state transitions: Mode changes return new state objects
 * - Minimal footprint: Only stores what's needed for mode switching
 * - No SDK coupling: Pure state management, no SDK dependencies
 *
 * @module mode/mode-manager
 */

import { createLogger, type Logger } from '../utils/logger.js';
import type { AgentMode, ModeState, ResearchModeConfig } from './types.js';
import { createResearchModeConfig, sanitizeTopicName } from './research-soul.js';

/**
 * Options for creating a ModeManager instance.
 */
export interface ModeManagerOptions {
  /** Base workspace directory for research working directories */
  workspaceDir: string;
}

/**
 * ModeManager - Manages per-chat agent mode state.
 *
 * Handles switching between 'normal' and 'research' modes,
 * including SOUL content and working directory configuration.
 *
 * @example
 * ```typescript
 * const manager = new ModeManager({ workspaceDir: '/app/workspace' });
 *
 * // Switch to research mode
 * const state = manager.switchToResearch('chat-123', 'machine-learning');
 * console.log(state.mode); // 'research'
 * console.log(state.research?.cwd); // '/app/workspace/workspace/research/machine-learning'
 *
 * // Switch back to normal
 * const normalState = manager.switchToNormal('chat-123');
 * console.log(normalState.mode); // 'normal'
 * ```
 */
export class ModeManager {
  private readonly states = new Map<string, ModeState>();
  private readonly workspaceDir: string;
  private readonly logger: Logger;

  constructor(options: ModeManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.logger = createLogger('ModeManager');
  }

  /**
   * Get the current mode for a chat.
   *
   * @param chatId - Chat identifier
   * @returns Current agent mode ('normal' if no state exists)
   */
  getMode(chatId: string): AgentMode {
    return this.states.get(chatId)?.mode ?? 'normal';
  }

  /**
   * Get the full mode state for a chat.
   *
   * @param chatId - Chat identifier
   * @returns Full mode state, or default normal state if none exists
   */
  getModeState(chatId: string): ModeState {
    return this.states.get(chatId) ?? { mode: 'normal' };
  }

  /**
   * Check if a chat is in research mode.
   *
   * @param chatId - Chat identifier
   * @returns true if the chat is in research mode
   */
  isResearchMode(chatId: string): boolean {
    return this.getMode(chatId) === 'research';
  }

  /**
   * Switch a chat to research mode.
   *
   * Creates a new research mode configuration with:
   * - Sanitized topic name for directory
   * - Research working directory path
   * - Research SOUL content
   * - Activation timestamp
   *
   * If the chat is already in research mode with the same topic,
   * returns the existing state without changes.
   *
   * @param chatId - Chat identifier
   * @param topic - Research topic name
   * @returns New mode state with research configuration
   */
  switchToResearch(chatId: string, topic: string): ModeState {
    const sanitizedTopic = sanitizeTopicName(topic);

    // If already in research mode with same topic, return existing state
    const existing = this.states.get(chatId);
    if (existing?.mode === 'research' && existing.research?.topic === sanitizedTopic) {
      this.logger.debug(
        { chatId, topic: sanitizedTopic },
        'Already in research mode for this topic, returning existing state'
      );
      return existing;
    }

    // If switching from a different research topic, log the topic change
    if (existing?.mode === 'research' && existing.research?.topic !== sanitizedTopic) {
      this.logger.info(
        { chatId, from: existing.research.topic, to: sanitizedTopic },
        'Switching research topic'
      );
    }

    const researchConfig = createResearchModeConfig(sanitizedTopic, this.workspaceDir);
    const state: ModeState = {
      mode: 'research',
      research: researchConfig,
    };

    this.states.set(chatId, state);

    this.logger.info(
      { chatId, topic: sanitizedTopic, cwd: researchConfig.cwd },
      'Switched to research mode'
    );

    return state;
  }

  /**
   * Switch a chat back to normal mode.
   *
   * Clears any research mode configuration. If the chat is already
   * in normal mode, returns the default state.
   *
   * @param chatId - Chat identifier
   * @returns Normal mode state
   */
  switchToNormal(chatId: string): ModeState {
    const existing = this.states.get(chatId);

    if (!existing || existing.mode === 'normal') {
      return { mode: 'normal' };
    }

    this.logger.info(
      { chatId, previousTopic: existing.research?.topic },
      'Switched to normal mode'
    );

    const state: ModeState = { mode: 'normal' };
    this.states.set(chatId, state);
    return state;
  }

  /**
   * Clear mode state for a chat.
   *
   * Removes all mode state for the specified chat.
   * Typically called when a chat session is reset or disposed.
   *
   * @param chatId - Chat identifier
   */
  clearState(chatId: string): void {
    this.states.delete(chatId);
    this.logger.debug({ chatId }, 'Cleared mode state');
  }

  /**
   * Clear all mode states.
   *
   * Removes all mode states for all chats.
   * Typically called during shutdown.
   */
  clearAll(): void {
    this.states.clear();
    this.logger.debug('Cleared all mode states');
  }

  /**
   * Get the research working directory for a chat (if in research mode).
   *
   * @param chatId - Chat identifier
   * @returns Research cwd if in research mode, undefined otherwise
   */
  getResearchCwd(chatId: string): string | undefined {
    return this.states.get(chatId)?.research?.cwd;
  }

  /**
   * Get the research SOUL content for a chat (if in research mode).
   *
   * @param chatId - Chat identifier
   * @returns Research SOUL content if in research mode, undefined otherwise
   */
  getResearchSoul(chatId: string): string | undefined {
    return this.states.get(chatId)?.research?.soulContent;
  }

  /**
   * Get the number of chats currently in research mode.
   *
   * @returns Count of chats in research mode
   */
  getResearchModeCount(): number {
    let count = 0;
    for (const state of this.states.values()) {
      if (state.mode === 'research') {
        count++;
      }
    }
    return count;
  }

  /**
   * Get all chat IDs currently in research mode.
   *
   * @returns Array of chat IDs in research mode
   */
  getResearchModeChatIds(): string[] {
    const chatIds: string[] = [];
    for (const [chatId, state] of this.states.entries()) {
      if (state.mode === 'research') {
        chatIds.push(chatId);
      }
    }
    return chatIds;
  }
}
