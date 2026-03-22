/**
 * SOUL Loader - Load SOUL (personality/behavior) definitions for agents.
 *
 * SOUL files are markdown files that define agent personalities and behaviors.
 * They are used to inject custom system prompts into agents for specific use cases.
 *
 * ## Directory Structure
 *
 * ```
 * souls/
 * ├── discussion.md    # Discussion mode SOUL - keeps conversations focused
 * └── ...              # Other SOUL definitions
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * import { loadSoul, loadSoulWithContext } from '@disclaude/core';
 *
 * // Load basic SOUL
 * const discussionSoul = await loadSoul('discussion');
 *
 * // Load SOUL with initial question context
 * const soulWithContext = await loadSoulWithContext('discussion', {
 *   initialQuestion: 'Should we automate code formatting?'
 * });
 * ```
 *
 * Issue #1228: Discussion focus SOUL implementation
 *
 * @module souls
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/**
 * Context variables for SOUL loading.
 */
export interface SoulContext {
  /** Initial question for discussion mode */
  initialQuestion?: string;
  /** Additional context to inject */
  [key: string]: string | undefined;
}

/**
 * Find the SOULs directory.
 *
 * Searches in the following order:
 * 1. Project root (workspace/souls/)
 * 2. Package directory (packages/core/souls/)
 *
 * @param soulName - Name of the SOUL (without .md extension)
 * @returns Path to the SOUL file, or null if not found
 */
export async function findSoul(soulName: string): Promise<string | null> {
  // Possible locations for SOUL files
  const possiblePaths = [
    // Project root souls directory
    path.join(process.cwd(), 'souls', `${soulName}.md`),
    // Workspace souls directory
    path.join(process.cwd(), 'workspace', 'souls', `${soulName}.md`),
    // Package-level souls (for built-in SOULs)
    path.join(__dirname, '..', '..', '..', 'souls', `${soulName}.md`),
  ];

  for (const soulPath of possiblePaths) {
    try {
      await fs.access(soulPath);
      logger.debug({ soulName, soulPath }, 'Found SOUL file');
      return soulPath;
    } catch {
      // Continue to next path
    }
  }

  logger.warn({ soulName, searchedPaths: possiblePaths }, 'SOUL file not found');
  return null;
}

/**
 * Load a SOUL definition by name.
 *
 * @param soulName - Name of the SOUL (without .md extension)
 * @returns SOUL content, or empty string if not found
 */
export async function loadSoul(soulName: string): Promise<string> {
  const soulPath = await findSoul(soulName);

  if (!soulPath) {
    logger.warn({ soulName }, 'SOUL not found, returning empty string');
    return '';
  }

  try {
    const content = await fs.readFile(soulPath, 'utf-8');
    logger.info({ soulName, soulPath, contentLength: content.length }, 'SOUL loaded');
    return content;
  } catch (error) {
    logger.error({ err: error, soulName, soulPath }, 'Failed to load SOUL');
    return '';
  }
}

/**
 * Load a SOUL definition with context variables.
 *
 * This function loads a SOUL and appends context information
 * (such as the initial question for discussion mode).
 *
 * @param soulName - Name of the SOUL (without .md extension)
 * @param context - Context variables to inject
 * @returns SOUL content with context, or empty string if not found
 */
export async function loadSoulWithContext(
  soulName: string,
  context: SoulContext
): Promise<string> {
  const soulContent = await loadSoul(soulName);

  if (!soulContent) {
    return '';
  }

  // Build context section
  const contextParts: string[] = [];

  if (context.initialQuestion) {
    contextParts.push(`## Initial Question\n\n${context.initialQuestion}`);
  }

  // Add any additional context
  for (const [key, value] of Object.entries(context)) {
    if (key !== 'initialQuestion' && value) {
      contextParts.push(`## ${key}\n\n${value}`);
    }
  }

  if (contextParts.length === 0) {
    return soulContent;
  }

  // Combine SOUL content with context
  const result = `${soulContent}\n\n---\n\n${contextParts.join('\n\n')}`;

  logger.info(
    { soulName, contextKeys: Object.keys(context), resultLength: result.length },
    'SOUL loaded with context'
  );

  return result;
}

/**
 * List all available SOULs.
 *
 * @returns Array of SOUL names (without .md extension)
 */
export async function listSouls(): Promise<string[]> {
  const possibleDirs = [
    path.join(process.cwd(), 'souls'),
    path.join(process.cwd(), 'workspace', 'souls'),
    path.join(__dirname, '..', '..', '..', 'souls'),
  ];

  const soulNames = new Set<string>();

  for (const dir of possibleDirs) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.endsWith('.md')) {
          soulNames.add(file.slice(0, -3)); // Remove .md extension
        }
      }
    } catch {
      // Directory doesn't exist, continue
    }
  }

  const result = Array.from(soulNames);
  logger.debug({ souls: result }, 'Listed available SOULs');
  return result;
}
