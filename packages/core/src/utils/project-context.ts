/**
 * Project context utilities for reading CLAUDE.md from target project directories.
 *
 * Issue #1506: When the agent handles development tasks, it should detect and
 * utilize CLAUDE.md from the target project's own directory (not the workspace root).
 *
 * Key design decisions (based on rejected PR #1513 feedback):
 * - Source: Development project's own directory (not workspace root)
 * - Timing: After finding/downloading the project (not at agent startup)
 * - Method: Infrastructure for sub-agent based understanding (not prompt injection)
 *
 * This module provides:
 * - `readProjectClaudeMd()`: Reads CLAUDE.md from a project directory
 * - `buildProjectContextGuidance()`: Formats CLAUDE.md content as agent context
 * - `buildProjectAwarenessGuidance()`: Instructs agent to check for CLAUDE.md
 *
 * @module utils/project-context
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Maximum size for CLAUDE.md content to prevent token bloat.
 * Files larger than this will be truncated with a warning.
 */
export const MAX_PROJECT_CONTEXT_SIZE = 32 * 1024; // 32KB

/**
 * Read CLAUDE.md from a project directory.
 *
 * Gracefully handles missing files and errors:
 * - ENOENT (file not found): Returns null silently
 * - Other errors: Logs warning and returns null
 * - Files exceeding MAX_PROJECT_CONTEXT_SIZE: Truncated with warning note
 *
 * @param projectDir - Absolute path to the project root directory
 * @returns CLAUDE.md content, or null if not found/error
 *
 * @example
 * ```typescript
 * const claudeMd = await readProjectClaudeMd('/tmp/my-project');
 * if (claudeMd) {
 *   console.log('Found CLAUDE.md:', claudeMd.length, 'bytes');
 * }
 * ```
 */
export async function readProjectClaudeMd(projectDir: string): Promise<string | null> {
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');

  try {
    const content = await fs.readFile(claudeMdPath, 'utf-8');

    if (content.length > MAX_PROJECT_CONTEXT_SIZE) {
      const truncated = content.slice(0, MAX_PROJECT_CONTEXT_SIZE);
      const note = `\n\n> ⚠️ CLAUDE.md truncated: original ${content.length} bytes exceeds ${MAX_PROJECT_CONTEXT_SIZE} byte limit.`;
      return truncated + note;
    }

    return content;
  } catch (error) {
    // ENOENT is expected when project has no CLAUDE.md - return silently
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    // Other errors (permissions, etc.) - log and return null
    // Using console.warn here as logger may not be available in all contexts
    // eslint-disable-next-line no-console
    console.warn(
      `[project-context] Failed to read ${claudeMdPath}: ${(error as Error).message}`
    );
    return null;
  }
}
