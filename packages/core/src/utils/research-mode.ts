/**
 * Research Mode Service - Manages research mode directory and SOUL lifecycle.
 *
 * Issue #1709: Research Mode Phase 1
 *
 * This module provides:
 * - Research directory creation and management
 * - SOUL file (CLAUDE.md) setup for research sessions
 * - Research directory path resolution
 *
 * Research directory structure:
 * ```
 * workspace/
 *   research/
 *     {topic}/
 *       CLAUDE.md        (Research SOUL - behavior rules)
 *       RESEARCH.md      (Research state - optional, Issue #1710)
 *       ...              (Research files and notes)
 * ```
 *
 * @module utils/research-mode
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from './logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('ResearchMode');

/**
 * Default Research SOUL content.
 *
 * This CLAUDE.md template defines research-specific behavior rules
 * that are loaded by the Claude SDK when the cwd is set to a research directory.
 */
const DEFAULT_RESEARCH_SOUL = `# Research Mode

You are operating in **Research Mode**. Follow these guidelines:

## Research Behavior

1. **Focus**: Stay on the current research topic. Avoid unrelated tasks.
2. **Thoroughness**: Explore multiple sources and perspectives before drawing conclusions.
3. **Documentation**: Record findings, sources, and reasoning in RESEARCH.md.
4. **Citation**: Always cite sources when presenting research findings.

## Directory Guidelines

- Work only within the current research directory and its subdirectories.
- Save all research outputs (notes, data, reports) in this directory.
- Use RESEARCH.md to track research progress and key findings.

## Output Format

- Use structured markdown for research notes and findings.
- Include source links/references for all factual claims.
- Clearly distinguish between facts, analysis, and opinions.
`;

/**
 * Options for initializing a research directory.
 */
export interface ResearchDirOptions {
  /**
   * Custom path to a SOUL file (CLAUDE.md) to use.
   * If not provided, the default research SOUL template is used.
   */
  soulFilePath?: string;

  /**
   * Custom research directory path.
   * If not provided, defaults to {workspace}/research/{topic}/.
   */
  dirPath?: string;
}

/**
 * Result of initializing a research directory.
 */
export interface ResearchDirResult {
  /** The absolute path to the research directory */
  dirPath: string;
  /** The path to the SOUL file (CLAUDE.md) */
  soulFilePath: string;
  /** Whether the directory was newly created */
  created: boolean;
  /** Whether the SOUL file was newly created */
  soulCreated: boolean;
}

/**
 * Resolve the research base directory from config.
 *
 * Uses the configured base directory from disclaude.config.yaml,
 * falling back to {workspace}/research/.
 *
 * @returns Absolute path to the research base directory
 */
export function getResearchBaseDir(): string {
  const researchConfig = Config.getResearchConfig();
  const baseDir = researchConfig.baseDir;

  if (baseDir) {
    // Resolve relative paths against workspace directory
    return path.isAbsolute(baseDir)
      ? baseDir
      : path.resolve(Config.getWorkspaceDir(), baseDir);
  }

  return path.resolve(Config.getWorkspaceDir(), 'research');
}

/**
 * Resolve the full research directory path for a given topic.
 *
 * @param topic - Research topic name (used as directory name)
 * @returns Absolute path to the research directory for the topic
 */
export function getResearchDir(topic: string): string {
  // Sanitize topic name for use as directory name
  const sanitizedTopic = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

  return path.join(getResearchBaseDir(), sanitizedTopic);
}

/**
 * Resolve the SOUL file (CLAUDE.md) path for a research directory.
 *
 * @param researchDir - Absolute path to the research directory
 * @returns Absolute path to the CLAUDE.md file
 */
export function getSoulFilePath(researchDir: string): string {
  return path.join(researchDir, 'CLAUDE.md');
}

/**
 * Initialize a research directory for a given topic.
 *
 * Creates the research directory structure and sets up the SOUL file (CLAUDE.md).
 * If the directory or SOUL file already exists, they are not overwritten.
 *
 * @param topic - Research topic name
 * @param options - Optional configuration overrides
 * @returns Result with directory and SOUL file paths
 *
 * @example
 * ```typescript
 * const result = await initResearchDir('machine-learning');
 * // result.dirPath: '/workspace/research/machine-learning'
 * // result.soulFilePath: '/workspace/research/machine-learning/CLAUDE.md'
 * ```
 */
export async function initResearchDir(
  topic: string,
  options: ResearchDirOptions = {}
): Promise<ResearchDirResult> {
  const dirPath = options.dirPath || getResearchDir(topic);
  const soulFilePath = getSoulFilePath(dirPath);

  logger.info({ topic, dirPath, soulFilePath }, 'Initializing research directory');

  // Check if directory already exists before creating
  let dirCreated = false;
  try {
    await fs.access(dirPath);
    logger.debug({ dirPath }, 'Research directory already exists');
  } catch {
    // Directory doesn't exist - create it
    await fs.mkdir(dirPath, { recursive: true });
    dirCreated = true;
    logger.debug({ dirPath }, 'Research directory created');
  }

  // Set up SOUL file (CLAUDE.md)
  let soulCreated = false;
  try {
    await fs.access(soulFilePath);
    logger.debug({ soulFilePath }, 'SOUL file already exists, skipping');
  } catch {
    // SOUL file doesn't exist - create it
    const soulContent = options.soulFilePath
      ? await readCustomSoulFile(options.soulFilePath)
      : DEFAULT_RESEARCH_SOUL;

    await fs.writeFile(soulFilePath, soulContent, 'utf-8');
    soulCreated = true;
    logger.debug({ soulFilePath }, 'SOUL file created');
  }

  logger.info(
    { dirPath, dirCreated, soulCreated },
    'Research directory initialized'
  );

  return { dirPath, soulFilePath, created: dirCreated, soulCreated };
}

/**
 * Check if a research directory exists for a given topic.
 *
 * @param topic - Research topic name
 * @returns true if the research directory exists
 */
export async function researchDirExists(topic: string): Promise<boolean> {
  const dirPath = getResearchDir(topic);
  try {
    await fs.access(dirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a research directory and all its contents.
 *
 * Use with caution - this permanently deletes all research files.
 *
 * @param topic - Research topic name
 * @returns true if the directory was removed, false if it didn't exist
 */
export async function cleanupResearchDir(topic: string): Promise<boolean> {
  const dirPath = getResearchDir(topic);

  try {
    await fs.access(dirPath);
  } catch {
    logger.debug({ topic, dirPath }, 'Research directory does not exist, nothing to clean up');
    return false;
  }

  await fs.rm(dirPath, { recursive: true, force: true });
  logger.info({ topic, dirPath }, 'Research directory cleaned up');
  return true;
}

/**
 * List all existing research directories.
 *
 * @returns Array of topic names that have research directories
 */
export async function listResearchDirs(): Promise<string[]> {
  const baseDir = getResearchBaseDir();

  try {
    await fs.access(baseDir);
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    // Base directory doesn't exist yet
    return [];
  }
}

/**
 * Read a custom SOUL file from the given path.
 *
 * @param soulFilePath - Path to the custom SOUL file
 * @returns Content of the SOUL file
 * @throws Error if the file cannot be read
 */
async function readCustomSoulFile(soulFilePath: string): Promise<string> {
  try {
    const content = await fs.readFile(soulFilePath, 'utf-8');
    logger.debug({ soulFilePath, contentLength: content.length }, 'Read custom SOUL file');
    return content;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    logger.error({ err, soulFilePath }, 'Failed to read custom SOUL file');
    throw new Error(
      `Failed to read custom SOUL file: ${soulFilePath} (${err.message})`
    );
  }
}
