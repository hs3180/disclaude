/**
 * LOOP.md parser — reads and writes Loop task state files.
 *
 * Issue #4039 / #4040: Parses LOOP.md files used by the Loop execution system.
 * LOOP.md contains a task title, configuration, goal, constraints, checkbox TODO items,
 * and a progress log section.
 *
 * File format:
 * ```markdown
 * # {Task Title}
 * ## Configuration
 * - **max_duration**: 2h
 * - **max_consecutive_failures**: 3
 * ## Goal
 * {outcome description}
 * ## Constraints
 * {limitations}
 * ## TODO
 * - [ ] {step 1}
 * - [ ] {step 2}
 * - ~[x]~ {failed step}
 * ## Progress Log
 * > agent appends records here
 * ```
 *
 * @module @disclaude/core/task
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LoopParser');

// ============================================================================
// Types
// ============================================================================

/** Status of a single TODO item */
export type TodoItemStatus = 'pending' | 'completed' | 'failed';

/** A single TODO item from LOOP.md */
export interface TodoItem {
  /** The step description */
  text: string;
  /** Current status */
  status: TodoItemStatus;
  /** 0-based index in the TODO list */
  index: number;
}

/** Parsed configuration section */
export interface LoopConfig {
  /** Maximum execution duration (default: "2h") */
  maxDuration: string;
  /** Maximum consecutive failures before stopping (default: 3) */
  maxConsecutiveFailures: number;
}

/** Complete parsed LOOP.md structure */
export interface LoopFile {
  /** Task title (from # heading) */
  title: string;
  /** Configuration section */
  config: LoopConfig;
  /** Goal section content */
  goal: string;
  /** Constraints section content */
  constraints: string;
  /** TODO items */
  todos: TodoItem[];
  /** Progress log content */
  progressLog: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: LoopConfig = {
  maxDuration: '2h',
  maxConsecutiveFailures: 3,
};

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a LOOP.md file from string content.
 * Returns null if the content is not a valid LOOP.md.
 */
export function parseLoopMd(content: string): LoopFile | null {
  try {
    const title = extractTitle(content);
    if (!title) {
      return null;
    }

    const sections = splitSections(content);

    return {
      title,
      config: parseConfig(sections['Configuration'] ?? ''),
      goal: (sections['Goal'] ?? '').trim(),
      constraints: (sections['Constraints'] ?? '').trim(),
      todos: parseTodos(sections['TODO'] ?? ''),
      progressLog: (sections['Progress Log'] ?? '').trim(),
    };
  } catch (error) {
    logger.error(`Failed to parse LOOP.md: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Read and parse a LOOP.md file from disk.
 */
export async function readLoopMd(filePath: string): Promise<LoopFile | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return parseLoopMd(content);
  } catch {
    return null;
  }
}

/**
 * Extract the title from the first # heading.
 */
function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Split content into sections by ## headers.
 */
function splitSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = content.split('\n');
  let currentSection = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      if (currentSection) {
        sections[currentSection] = currentLines.join('\n');
      }
      currentSection = headerMatch[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentSection) {
    sections[currentSection] = currentLines.join('\n');
  }

  return sections;
}

/**
 * Parse the Configuration section into a LoopConfig object.
 */
function parseConfig(configText: string): LoopConfig {
  const config = { ...DEFAULT_CONFIG };

  const durationMatch = configText.match(/\*\*max_duration\*\*:\s*(.+)/);
  if (durationMatch) {
    config.maxDuration = durationMatch[1].trim();
  }

  const failuresMatch = configText.match(/\*\*max_consecutive_failures\*\*:\s*(\d+)/);
  if (failuresMatch) {
    config.maxConsecutiveFailures = parseInt(failuresMatch[1], 10);
  }

  return config;
}

/**
 * Parse the TODO section into TodoItem array.
 */
function parseTodos(todoText: string): TodoItem[] {
  const items: TodoItem[] = [];
  const lines = todoText.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Completed: - [x] {text} or - [x] {text} (note)
    const completedMatch = trimmed.match(/^- \[x\]\s+(.+)/);
    if (completedMatch && !trimmed.startsWith('- ~[x]~')) {
      items.push({ text: completedMatch[1].trim(), status: 'completed', index: items.length });
      continue;
    }

    // Failed: - ~[x]~ {text}
    const failedMatch = trimmed.match(/^- ~\[x\]~\s+(.+)/);
    if (failedMatch) {
      items.push({ text: failedMatch[1].trim(), status: 'failed', index: items.length });
      continue;
    }

    // Pending: - [ ] {text}
    const pendingMatch = trimmed.match(/^- \[ \]\s+(.+)/);
    if (pendingMatch) {
      items.push({ text: pendingMatch[1].trim(), status: 'pending', index: items.length });
      continue;
    }
  }

  return items;
}

// ============================================================================
// Query helpers
// ============================================================================

/**
 * Find the next pending (unchecked) TODO item.
 */
export function findNextPending(todos: TodoItem[]): TodoItem | null {
  return todos.find(item => item.status === 'pending') ?? null;
}

/**
 * Check if all TODO items are completed or failed (no pending items remain).
 */
export function isAllDone(todos: TodoItem[]): boolean {
  return todos.length > 0 && todos.every(item => item.status !== 'pending');
}

/**
 * Count items by status.
 */
export function countByStatus(todos: TodoItem[]): { pending: number; completed: number; failed: number } {
  return {
    pending: todos.filter(t => t.status === 'pending').length,
    completed: todos.filter(t => t.status === 'completed').length,
    failed: todos.filter(t => t.status === 'failed').length,
  };
}

/**
 * Parse a duration string (e.g. "2h", "30m", "1h30m") to milliseconds.
 * Returns null if the format is invalid.
 */
export function parseDuration(duration: string): number | null {
  const match = duration.match(/^(\d+h)?(\d+m)?(\d+s)?$/);
  if (!match || (!match[1] && !match[2] && !match[3])) {
    return null;
  }

  let ms = 0;
  if (match[1]) {
    ms += parseInt(match[1], 10) * 60 * 60 * 1000;
  }
  if (match[2]) {
    ms += parseInt(match[2], 10) * 60 * 1000;
  }
  if (match[3]) {
    ms += parseInt(match[3], 10) * 1000;
  }

  return ms;
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Generate a LOOP.md file content string.
 */
export function serializeLoopMd(loop: LoopFile): string {
  const todoLines = loop.todos.map(item => {
    switch (item.status) {
      case 'completed': return `- [x] ${item.text}`;
      case 'failed': return `- ~[x]~ ${item.text}`;
      case 'pending': return `- [ ] ${item.text}`;
    }
  });

  return [
    `# ${loop.title}`,
    '',
    '## Configuration',
    `- **max_duration**: ${loop.config.maxDuration}`,
    `- **max_consecutive_failures**: ${loop.config.maxConsecutiveFailures}`,
    '',
    '## Goal',
    loop.goal,
    '',
    '## Constraints',
    loop.constraints,
    '',
    '## TODO',
    ...todoLines,
    '',
    '## Progress Log',
    loop.progressLog,
  ].join('\n');
}

/**
 * Write a LoopFile to disk.
 */
export async function writeLoopMd(filePath: string, loop: LoopFile): Promise<void> {
  const dir = join(filePath, '..');
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, serializeLoopMd(loop), 'utf-8');
}
