/**
 * LOOP.md parser — parses checkbox-based task files for Ralph Loop execution.
 *
 * Reads LOOP.md files, extracts checkbox items, tracks progress,
 * and determines completion status. Used by loop execution agents
 * to find the next unchecked item.
 *
 * Issue #4039: Loop System — Ralph Loop based autonomous task execution.
 *
 * @module @disclaude/core/scheduling
 */

/**
 * A single checkbox item from LOOP.md.
 */
export interface LoopCheckItem {
  /** 0-based index in the checklist */
  index: number;
  /** Whether the item is checked */
  checked: boolean;
  /** The text content of the item */
  text: string;
}

/**
 * Parsed LOOP.md result.
 */
export interface ParsedLoopFile {
  /** The task title (first # heading) */
  title: string;
  /** All checkbox items found in the file */
  items: LoopCheckItem[];
  /** 0-based index of the next unchecked item, or -1 if all done */
  nextIndex: number;
  /** Total number of items */
  total: number;
  /** Number of completed items */
  completed: number;
  /** Whether all items are done */
  allDone: boolean;
}

/**
 * Parse a LOOP.md file content and extract checkbox items.
 *
 * @param content - The full content of the LOOP.md file
 * @returns Parsed result with items, progress, and next action
 */
export function parseLoopFile(content: string): ParsedLoopFile {
  // Extract title from first # heading
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? 'Untitled Loop Task';

  // Extract all checkbox items: - [ ] or - [x]
  const checkboxRegex = /^[\s]*- \[([ xX])\]\s*(.+)$/gm;
  const items: LoopCheckItem[] = [];
  let match: RegExpExecArray | null;

  while ((match = checkboxRegex.exec(content)) !== null) {
    const checked = match[1].toLowerCase() === 'x';
    const text = match[2].trim();
    items.push({ index: items.length, checked, text });
  }

  const completed = items.filter(i => i.checked).length;
  const nextIndex = items.findIndex(i => !i.checked);
  const allDone = items.length > 0 && nextIndex === -1;

  return {
    title,
    items,
    nextIndex,
    total: items.length,
    completed,
    allDone,
  };
}

/**
 * Check off a checkbox item in LOOP.md content.
 *
 * @param content - The full content of the LOOP.md file
 * @param index - 0-based index of the item to check off
 * @returns Updated content with the item checked, or original if index invalid
 */
export function checkOffItem(content: string, index: number): string {
  let currentIndex = 0;
  // Match both checked and unchecked items to maintain absolute indexing
  return content.replace(
    /^([\s]*)- \[([ xX])\]\s*(.+)$/gm,
    (fullMatch, indent: string, _checkState: string, text: string) => {
      if (currentIndex === index) {
        currentIndex++;
        return `${indent}- [x] ${text}`;
      }
      currentIndex++;
      return fullMatch;
    }
  );
}

/**
 * Append a progress log entry to the LOOP.md content.
 *
 * Adds a line after the last content in the "进度记录" section.
 *
 * @param content - The full content of the LOOP.md file
 * @param message - The progress message to append
 * @returns Updated content with the progress entry appended
 */
export function appendProgress(content: string, message: string): string {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);
  const line = `> ${timestamp} - ${message}`;

  // Find the progress section and append after the last line there
  const progressRegex = /(## 进度记录[\s\S]*?)(>.*(?:\n|$)|<!--.*-->(?:\n|$)|\n)/;
  const match = content.match(progressRegex);

  if (match) {
    // Append after the last entry in the progress section
    const insertPoint = match.index! + match[0].length;
    return content.slice(0, insertPoint) + line + '\n' + content.slice(insertPoint);
  }

  // If no progress section found, append at the end
  return content.trimEnd() + '\n\n## 进度记录\n\n' + line + '\n';
}
