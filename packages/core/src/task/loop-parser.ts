/**
 * Loop Parser for Ralph Loop execution.
 *
 * Parses LOOP.md files used by the Loop skill (V3 async chain drive).
 * Provides methods to read/validate loop state, check progress, and update checkboxes.
 *
 * @module task/loop-parser
 */

import * as fs from 'fs/promises';

/** Parsed configuration from LOOP.md */
export interface LoopConfig {
  clearContextPerStep: boolean;
  maxDuration: string;
  maxConsecutiveFailures: number;
  startedAt: string;
}

/** A single todo item from LOOP.md */
export interface LoopTodoItem {
  index: number;
  checked: boolean;
  failed: boolean;
  text: string;
}

/** Parsed LOOP.md structure */
export interface LoopState {
  title: string;
  config: LoopConfig;
  goal: string;
  constraints: string;
  todos: LoopTodoItem[];
  progressLog: string;
  rawContent: string;
}

/**
 * Parser for LOOP.md files used in Ralph Loop autonomous task execution.
 *
 * LOOP.md format:
 * ```
 * # {title}
 *
 * ## 配置
 * - **clear_context_per_step**: false
 * - **max_duration**: 2h
 * - **max_consecutive_failures**: 3
 * - **startedAt**: {ISO timestamp}
 *
 * ## 目标
 * {goal}
 *
 * ## 约束
 * {constraints}
 *
 * ## 待办
 * - [ ] Step 1
 * - [x] Step 2 (completed)
 * - ~[x]~ Step 3 (failed)
 *
 * ## 进度记录
 * {progress}
 * ```
 */
export class LoopParser {
  /**
   * Parse a LOOP.md file and return structured state.
   * @param loopFilePath - Absolute path to LOOP.md
   */
  static async parse(loopFilePath: string): Promise<LoopState> {
    const rawContent = await fs.readFile(loopFilePath, 'utf-8');
    return LoopParser.parseContent(rawContent);
  }

  /**
   * Parse LOOP.md content string directly.
   * @param content - Raw LOOP.md content
   */
  static parseContent(content: string): LoopState {
    const title = LoopParser.extractTitle(content);
    const config = LoopParser.extractConfig(content);
    const goal = LoopParser.extractSection(content, '目标');
    const constraints = LoopParser.extractSection(content, '约束');
    const todos = LoopParser.extractTodos(content);
    const progressLog = LoopParser.extractSection(content, '进度记录');

    return {
      title,
      config,
      goal,
      constraints,
      todos,
      progressLog,
      rawContent: content,
    };
  }

  /**
   * Get the next unchecked todo item, or null if all done.
   */
  static getNextPending(state: LoopState): LoopTodoItem | null {
    return state.todos.find((t) => !t.checked && !t.failed) ?? null;
  }

  /**
   * Check if all todos are done (checked or failed).
   */
  static isComplete(state: LoopState): boolean {
    return state.todos.every((t) => t.checked || t.failed);
  }

  /**
   * Check if elapsed time exceeds max_duration.
   * @returns true if timed out
   */
  static isTimedOut(state: LoopState): boolean {
    const started = new Date(state.config.startedAt).getTime();
    if (isNaN(started)) {return false;}

    const now = Date.now();
    const elapsedMs = now - started;
    const maxMs = LoopParser.parseDuration(state.config.maxDuration);
    return elapsedMs > maxMs;
  }

  /**
   * Count consecutive failures from the end of completed items.
   */
  static countConsecutiveFailures(state: LoopState): number {
    let count = 0;
    // Walk through todos in order, counting consecutive failures
    // from the last processed item backwards
    for (let i = state.todos.length - 1; i >= 0; i--) {
      const todo = state.todos[i];
      if (todo.failed) {
        count++;
      } else if (todo.checked) {
        // A successful item breaks the consecutive failure chain
        continue;
      } else {
        // Unprocessed item — stop counting
        break;
      }
    }
    return count;
  }

  /**
   * Check if the loop should stop due to consecutive failures.
   */
  static hasTooManyFailures(state: LoopState): boolean {
    return (
      LoopParser.countConsecutiveFailures(state) >=
      state.config.maxConsecutiveFailures
    );
  }

  /**
   * Mark a todo item as completed and write back to file.
   * @param loopFilePath - Path to LOOP.md
   * @param index - 0-based todo index
   */
  static async markDone(
    loopFilePath: string,
    index: number
  ): Promise<void> {
    const content = await fs.readFile(loopFilePath, 'utf-8');
    const updated = LoopParser.markTodoInContent(content, index, 'done');
    await fs.writeFile(loopFilePath, updated, 'utf-8');
  }

  /**
   * Mark a todo item as failed and write back to file.
   * @param loopFilePath - Path to LOOP.md
   * @param index - 0-based todo index
   */
  static async markFailed(
    loopFilePath: string,
    index: number
  ): Promise<void> {
    const content = await fs.readFile(loopFilePath, 'utf-8');
    const updated = LoopParser.markTodoInContent(content, index, 'failed');
    await fs.writeFile(loopFilePath, updated, 'utf-8');
  }

  /**
   * Append a progress log entry to the LOOP.md file.
   * @param loopFilePath - Path to LOOP.md
   * @param entry - Progress entry text
   */
  static async appendProgress(
    loopFilePath: string,
    entry: string
  ): Promise<void> {
    const content = await fs.readFile(loopFilePath, 'utf-8');
    const timestamp = new Date().toISOString();
    const logLine = `\n- **${timestamp}**: ${entry}`;

    // Find the 进度记录 section and append
    const sectionRegex = /^## 进度记录\s*\n/m;
    if (sectionRegex.test(content)) {
      const updated = content.replace(
        sectionRegex,
        `## 进度记录\n${logLine}\n`
      );
      await fs.writeFile(loopFilePath, updated, 'utf-8');
    } else {
      // Fallback: append at end
      await fs.writeFile(
        loopFilePath,
        `${content  }\n## 进度记录\n${  logLine  }\n`,
        'utf-8'
      );
    }
  }

  // ===== Private helpers =====

  private static extractTitle(content: string): string {
    const match = content.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim() ?? 'Untitled Loop';
  }

  private static extractConfig(content: string): LoopConfig {
    const configSection = LoopParser.extractSection(content, '配置');

    const getBool = (key: string): boolean => {
      const m = configSection.match(
        new RegExp(`\\*\\*${key}\\*\\*:\\s*(true|false)`, 'i')
      );
      return m?.[1]?.toLowerCase() === 'true';
    };

    const getString = (key: string): string => {
      const m = configSection.match(new RegExp(`\\*\\*${key}\\*\\*:\\s*(.+)$`, 'm'));
      return m?.[1]?.trim() ?? '';
    };

    const getNum = (key: string): number => {
      const m = configSection.match(new RegExp(`\\*\\*${key}\\*\\*:\\s*(\\d+)`));
      return m ? parseInt(m[1], 10) : 0;
    };

    return {
      clearContextPerStep: getBool('clear_context_per_step'),
      maxDuration: getString('max_duration') || '2h',
      maxConsecutiveFailures: getNum('max_consecutive_failures') || 3,
      startedAt: getString('startedAt'),
    };
  }

  private static extractSection(
    content: string,
    sectionName: string
  ): string {
    // Match from ## sectionName to the next ## heading (or end of string)
    const regex = new RegExp(
      `## ${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n## )`,
      ''
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? '';
  }

  private static extractTodos(content: string): LoopTodoItem[] {
    const todos: LoopTodoItem[] = [];
    const lines = content.split('\n');
    let inTodoSection = false;

    for (const line of lines) {
      if (/^## 待办/.test(line)) {
        inTodoSection = true;
        continue;
      }
      if (/^## /.test(line)) {
        if (inTodoSection) {break;}
        continue;
      }

      if (inTodoSection) {
        // Failed item: - ~[x]~ text
        const failedMatch = line.match(/^-\s*~\[x\]~\s*(.+)$/);
        if (failedMatch) {
          todos.push({
            index: todos.length,
            checked: false,
            failed: true,
            text: failedMatch[1].trim(),
          });
          continue;
        }

        // Completed item: - [x] text
        const doneMatch = line.match(/^-\s*\[x\]\s*(.+)$/);
        if (doneMatch) {
          todos.push({
            index: todos.length,
            checked: true,
            failed: false,
            text: doneMatch[1].trim(),
          });
          continue;
        }

        // Pending item: - [ ] text
        const pendingMatch = line.match(/^-\s*\[\s?\]\s*(.+)$/);
        if (pendingMatch) {
          todos.push({
            index: todos.length,
            checked: false,
            failed: false,
            text: pendingMatch[1].trim(),
          });
          continue;
        }
      }
    }

    return todos;
  }

  private static markTodoInContent(
    content: string,
    index: number,
    status: 'done' | 'failed'
  ): string {
    const lines = content.split('\n');
    let inTodoSection = false;
    let todoCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^## 待办/.test(line)) {
        inTodoSection = true;
        continue;
      }
      if (/^## /.test(line) && inTodoSection) {
        break;
      }

      if (inTodoSection) {
        // Match any todo line (pending, done, or failed)
        const isTodoLine = /^-\s*(\[[ x]\]|~\[x\]~)/.test(line);
        if (isTodoLine) {
          if (todoCount === index) {
            const textMatch = line.match(
              /^-\s*(?:\[[ x]\]|~\[x\]~)\s*(.+)$/
            );
            const text = textMatch?.[1] ?? '';
            if (status === 'done') {
              lines[i] = `- [x] ${text}`;
            } else {
              lines[i] = `- ~[x]~ ${text}`;
            }
            break;
          }
          todoCount++;
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Parse a duration string like "2h", "30m", "1d" into milliseconds.
   */
  private static parseDuration(duration: string): number {
    const match = duration.match(/^(\d+)\s*(h|m|s|d)$/i);
    if (!match) {return 2 * 60 * 60 * 1000;} // default 2h

    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case 'h':
        return value * 60 * 60 * 1000;
      case 'm':
        return value * 60 * 1000;
      case 's':
        return value * 1000;
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      default:
        return 2 * 60 * 60 * 1000;
    }
  }
}
