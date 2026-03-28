/**
 * Agent Mode management — Research Mode Phase 1.
 *
 * Provides per-chatId mode switching between 'normal' and 'research' modes.
 * When in research mode, the agent operates in an isolated workspace
 * with a dedicated SOUL.md (via CLAUDE.md), notes/, and sources/ directories.
 *
 * Issue #1709: 增加 Research 模式：SOUL + 工作目录 + Skill 套装切换
 *
 * @module modes/agent-mode
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger, type Logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Agent operating mode.
 *
 * - `normal`: Default mode with full skill access and standard workspace.
 * - `research`: Isolated research mode with dedicated workspace and SOUL.
 */
export type AgentMode = 'normal' | 'research';

/**
 * Research mode state for a single chatId.
 */
export interface ResearchState {
  /** The research topic (used as directory name) */
  topic: string;
  /** The sanitized directory name derived from the topic */
  dirName: string;
  /** Absolute path to the research workspace */
  workspacePath: string;
  /** Timestamp when research mode was activated (ms since epoch) */
  activatedAt: number;
}

/**
 * Options for ResearchModeManager.
 */
export interface ResearchModeManagerOptions {
  /** Base workspace directory (default: Config.getWorkspaceDir()) */
  baseWorkspaceDir?: string;
  /** Custom logger instance */
  logger?: Logger;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default CLAUDE.md content for research workspace.
 * This acts as the SOUL.md for research mode, injected via SDK's
 * `settingSources: ['project']` mechanism.
 */
const DEFAULT_RESEARCH_CLAUDE_MD = `# Research Mode

You are operating in **Research Mode** — an isolated research environment.

## Behavioral Guidelines

### Directory Restrictions
- Only access files within the current research workspace and its subdirectories
- Do NOT access other project files in the parent workspace
- Do NOT access system directories or paths outside this research workspace

### Research Workflow
1. Clearly define the research objective
2. Gather and organize relevant information
3. Record findings in the \`notes/\` directory
4. Save source materials in the \`sources/\` directory
5. Maintain a \`RESEARCH.md\` file with current progress and findings

### Output Standards
- Prefer structured, factual summaries over opinions
- Cite sources when possible
- Track open questions and unresolved items

### Mode Exit
- The user can exit research mode at any time with \`/research off\`
- Research data is preserved in the workspace for future reference
`;

/**
 * Default RESEARCH.md content for new research workspaces.
 */
const DEFAULT_RESEARCH_MD = `# Research Notes

## Topic
{{TOPIC}}

## Status
🔄 In Progress

## Objective
<!-- Define the research objective here -->

## Findings
<!-- Record key findings -->

## Open Questions
<!-- Track unresolved questions -->

## Sources
<!-- List reference sources -->

---

*Research started: {{DATE}}*
`;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sanitize a topic name for use as a directory name.
 *
 * Handles CJK characters by transliterating common characters and
 * removing/replacing special characters that are invalid in directory names.
 *
 * @param topic - The raw topic name from user input
 * @returns A sanitized directory name safe for filesystem use
 */
export function sanitizeTopicName(topic: string): string {
  if (!topic || topic.trim().length === 0) {
    throw new Error('Topic name cannot be empty');
  }

  const trimmed = topic.trim();

  // Limit length to 100 characters
  const limited = trimmed.length > 100 ? trimmed.slice(0, 100) : trimmed;

  // Replace characters that are invalid in directory names
  // Keep alphanumeric, CJK, hyphens, underscores, spaces
  let sanitized = limited.replace(/[/\\:*?"<>|\0]/g, '-');

  // Replace multiple consecutive spaces/hyphens with single hyphen
  sanitized = sanitized.replace(/[\s-]+/g, '-');

  // Remove leading/trailing hyphens or dots
  sanitized = sanitized.replace(/^[.\-]+/, '').replace(/[.\-]+$/, '');

  // Lowercase for consistency (CJK characters are unaffected)
  sanitized = sanitized.toLowerCase();

  // Fallback if sanitization results in empty string
  if (sanitized.length === 0) {
    return `research-${Date.now()}`;
  }

  return sanitized;
}

// ============================================================================
// ResearchModeManager
// ============================================================================

/**
 * Manages agent mode state on a per-chatId basis.
 *
 * Stores mode state in memory. When research mode is activated, creates
 * an isolated workspace directory with CLAUDE.md (SOUL), notes/, and sources/.
 *
 * Usage:
 * ```typescript
 * const manager = new ResearchModeManager({ baseWorkspaceDir: '/path/to/workspace' });
 *
 * // Activate research mode
 * const state = manager.enterResearch(chatId, 'AI Safety');
 * console.log(state.workspacePath); // '/path/to/workspace/research/ai-safety'
 *
 * // Check current mode
 * const mode = manager.getMode(chatId); // 'research'
 *
 * // Exit research mode (workspace is preserved)
 * manager.exitResearch(chatId);
 * ```
 */
export class ResearchModeManager {
  private readonly modes = new Map<string, AgentMode>();
  private readonly researchStates = new Map<string, ResearchState>();
  private readonly baseWorkspaceDir: string;
  private readonly logger: Logger;

  constructor(options: ResearchModeManagerOptions = {}) {
    this.baseWorkspaceDir = options.baseWorkspaceDir ?? process.cwd();
    this.logger = options.logger ?? createLogger('ResearchModeManager');
  }

  /**
   * Get the current agent mode for a chatId.
   *
   * @param chatId - The chat identifier
   * @returns Current mode ('normal' if not set)
   */
  getMode(chatId: string): AgentMode {
    return this.modes.get(chatId) ?? 'normal';
  }

  /**
   * Check if a chatId is in research mode.
   *
   * @param chatId - The chat identifier
   * @returns true if in research mode
   */
  isResearchMode(chatId: string): boolean {
    return this.getMode(chatId) === 'research';
  }

  /**
   * Get the research state for a chatId.
   *
   * @param chatId - The chat identifier
   * @returns Research state or undefined if not in research mode
   */
  getResearchState(chatId: string): ResearchState | undefined {
    return this.researchStates.get(chatId);
  }

  /**
   * Get the working directory for a chatId.
   *
   * In research mode, returns the research workspace path.
   * In normal mode, returns undefined (caller should use default workspace).
   *
   * @param chatId - The chat identifier
   * @returns Absolute path to working directory, or undefined for normal mode
   */
  getWorkingDirectory(chatId: string): string | undefined {
    const state = this.researchStates.get(chatId);
    if (state) {
      return state.workspacePath;
    }
    return undefined;
  }

  /**
   * Enter research mode for a chatId.
   *
   * Creates an isolated research workspace directory with:
   * - `CLAUDE.md` — Research SOUL (injected via SDK settingSources)
   * - `notes/` — Directory for research notes
   * - `sources/` — Directory for source materials
   * - `RESEARCH.md` — Initial research status file
   *
   * If research mode is already active for this chatId, returns existing state.
   *
   * @param chatId - The chat identifier
   * @param topic - The research topic (used as directory name)
   * @returns The research state
   * @throws Error if topic is empty
   */
  enterResearch(chatId: string, topic: string): ResearchState {
    // If already in research mode, return existing state
    const existing = this.researchStates.get(chatId);
    if (existing) {
      this.logger.info(
        { chatId, topic: existing.topic },
        'Already in research mode, returning existing state'
      );
      return existing;
    }

    const dirName = sanitizeTopicName(topic);
    const workspacePath = path.join(this.baseWorkspaceDir, 'research', dirName);

    // Create workspace directory structure
    fs.mkdirSync(path.join(workspacePath, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'sources'), { recursive: true });

    // Create CLAUDE.md (Research SOUL) if not exists
    const claudeMdPath = path.join(workspacePath, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      fs.writeFileSync(claudeMdPath, DEFAULT_RESEARCH_CLAUDE_MD, 'utf-8');
    }

    // Create RESEARCH.md if not exists
    const researchMdPath = path.join(workspacePath, 'RESEARCH.md');
    if (!fs.existsSync(researchMdPath)) {
      const initialContent = DEFAULT_RESEARCH_MD
        .replace('{{TOPIC}}', topic)
        .replace('{{DATE}}', new Date().toISOString());
      fs.writeFileSync(researchMdPath, initialContent, 'utf-8');
    }

    const state: ResearchState = {
      topic,
      dirName,
      workspacePath,
      activatedAt: Date.now(),
    };

    this.modes.set(chatId, 'research');
    this.researchStates.set(chatId, state);

    this.logger.info(
      { chatId, topic, workspacePath },
      'Entered research mode'
    );

    return state;
  }

  /**
   * Exit research mode for a chatId.
   *
   * Resets the mode to 'normal'. The research workspace directory
   * and its contents are preserved for future reference.
   *
   * @param chatId - The chat identifier
   * @returns true if was in research mode, false if already in normal mode
   */
  exitResearch(chatId: string): boolean {
    const wasResearch = this.modes.get(chatId) === 'research';

    this.modes.set(chatId, 'normal');
    this.researchStates.delete(chatId);

    if (wasResearch) {
      this.logger.info({ chatId }, 'Exited research mode');
    }

    return wasResearch;
  }

  /**
   * Clear all mode state for a chatId.
   *
   * Unlike exitResearch(), this fully removes all state tracking.
   * Use for cleanup when a chat session is permanently terminated.
   *
   * @param chatId - The chat identifier
   */
  clear(chatId: string): void {
    this.modes.delete(chatId);
    this.researchStates.delete(chatId);
  }

  /**
   * Get all chatIds currently in research mode.
   *
   * @returns Array of chatId strings in research mode
   */
  getActiveResearchChats(): string[] {
    const result: string[] = [];
    for (const [chatId, mode] of this.modes) {
      if (mode === 'research') {
        result.push(chatId);
      }
    }
    return result;
  }
}
