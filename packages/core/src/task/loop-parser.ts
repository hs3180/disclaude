/**
 * LoopParser — Parse and manipulate LOOP.md files for the Loop execution engine.
 *
 * LOOP.md format:
 *   # {title}
 *   ## 配置
 *   - **clear_context_per_step**: false
 *   - **max_duration**: 2h
 *   - **max_consecutive_failures**: 3
 *   ## 目标
 *   {objective}
 *   ## 约束
 *   {constraints}
 *   ## 待办
 *   - [ ] step 1
 *   - [x] step 2
 *   - ~[x]~ step 3 (failed)
 *   ## 进度记录
 *   {progress notes}
 *
 * Checkbox states: `[ ]` pending, `[x]` completed, `~[x]~` failed
 *
 * @module task/loop-parser
 */

import * as fs from 'fs/promises';
import * as syncFs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Checkbox state for a loop step. */
export type CheckboxState = 'pending' | 'completed' | 'failed';

/** A single todo item from the LOOP.md 待办 section. */
export interface LoopStep {
  /** Original line text (preserved for round-trip). */
  readonly raw: string;
  /** Zero-based index in the 待办 list. */
  readonly index: number;
  /** Step description text (without checkbox markup). */
  readonly text: string;
  /** Optional parenthetical note, e.g. "(失败：API 超时)". */
  readonly note: string;
  /** Current state. */
  state: CheckboxState;
}

/** Parsed configuration from the 配置 section. */
export interface LoopConfig {
  clearContextPerStep: boolean;
  maxDurationMs: number;
  maxConsecutiveFailures: number;
}

/** Full parsed result of a LOOP.md file. */
export interface LoopDocument {
  readonly title: string;
  readonly config: LoopConfig;
  readonly objective: string;
  readonly constraints: string;
  readonly steps: LoopStep[];
  readonly progressNotes: string;
  /** Raw markdown content for round-trip serialization. */
  readonly rawContent: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: LoopConfig = {
  clearContextPerStep: false,
  maxDurationMs: 2 * 60 * 60 * 1000, // 2h
  maxConsecutiveFailures: 3,
};

const RE_CHECKBOX = /^(\s*)- \[([ xX])\] (.*)$/;
const RE_FAILED_CHECKBOX = /^(\s*)- ~\[([ xX])\]~(.*)$/;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseCheckboxLine(line: string, index: number): LoopStep | null {
  const failed = RE_FAILED_CHECKBOX.exec(line);
  if (failed) {
    const text = (failed[3] ?? '').trim();
    const note = extractNote(text);
    return { raw: line, index, text: text.replace(note, '').trim(), note, state: 'failed' };
  }

  const match = RE_CHECKBOX.exec(line);
  if (match) {
    const text = (match[3] ?? '').trim();
    const note = extractNote(text);
    const checked = (match[2] ?? '').toLowerCase() === 'x';
    return { raw: line, index, text: text.replace(note, '').trim(), note, state: checked ? 'completed' : 'pending' };
  }

  return null;
}

function extractNote(text: string): string {
  const m = text.match(/\s*\([^)]*\)\s*$/);
  return m ? (m[0] ?? '').trim() : '';
}

function parseDuration(raw: string): number {
  const s = raw.trim();
  if (!s) {return DEFAULT_CONFIG.maxDurationMs;}
  const num = parseFloat(s);
  if (s.endsWith('h') || s.endsWith('H')) {return num * 3600 * 1000;}
  if (s.endsWith('m') || s.endsWith('M')) {return num * 60 * 1000;}
  if (s.endsWith('s') || s.endsWith('S')) {return num * 1000;}
  return num * 1000; // default to seconds
}

function parseConfigSection(lines: string[]): LoopConfig {
  const config = { ...DEFAULT_CONFIG };
  for (const line of lines) {
    const m = line.match(/^\s*-\s+\*\*(\w+)\*\*:\s*(.+)$/);
    if (!m) {continue;}
    const key = (m[1] ?? '').replace(/[-_\s]/g, '').toLowerCase();
    const rawVal = (m[2] ?? '').trim();
    const val = rawVal.split(/\s*#\s*/)[0]?.trim() ?? rawVal;
    switch (key) {
      case 'clearcontextperstep':
        config.clearContextPerStep = val === 'true';
        break;
      case 'maxduration':
        config.maxDurationMs = parseDuration(val);
        break;
      case 'maxconsecutivefailures':
        config.maxConsecutiveFailures = parseInt(val, 10) || DEFAULT_CONFIG.maxConsecutiveFailures;
        break;
    }
  }
  return config;
}

function isCheckboxLine(line: string): boolean {
  return RE_CHECKBOX.test(line) || RE_FAILED_CHECKBOX.test(line);
}

// ---------------------------------------------------------------------------
// LoopParser
// ---------------------------------------------------------------------------

export class LoopParser {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  // -----------------------------------------------------------------------
  // Parse
  // -----------------------------------------------------------------------

  /**
   * Parse the LOOP.md file and return a structured document.
   * Throws if the file cannot be read.
   */
  async parse(): Promise<LoopDocument> {
    const content = await fs.readFile(this.filePath, 'utf-8');
    return this.parseContent(content);
  }

  /**
   * Synchronous version of parse().
   */
  parseSync(): LoopDocument {
    const content = syncFs.readFileSync(this.filePath, 'utf-8');
    return this.parseContent(content);
  }

  /**
   * Parse LOOP.md content from a string.
   */
  parseContent(content: string): LoopDocument {
    const lines = content.split('\n');
    const title = extractTitle(lines);
    const { config, objective, constraints, steps, progressNotes } = extractSections(lines);
    return { title, config, objective, constraints, steps, progressNotes, rawContent: content };
  }

  // -----------------------------------------------------------------------
  // Mutate & save
  // -----------------------------------------------------------------------

  /**
   * Update a step's checkbox state and persist to disk.
   * Appends a note if provided (e.g. "(失败：API 超时)").
   */
  async updateStep(index: number, state: CheckboxState, note?: string): Promise<LoopDocument> {
    const doc = this.parseSync();
    if (index < 0 || index >= doc.steps.length) {
      throw new Error(`Step index ${index} out of range (0..${doc.steps.length - 1})`);
    }
    const content = applyStepState(doc.rawContent, index, state, note);
    await fs.writeFile(this.filePath, content, 'utf-8');
    return this.parseContent(content);
  }

  /**
   * Append a progress note to the 进度记录 section.
   */
  async appendProgress(note: string): Promise<LoopDocument> {
    const content = await fs.readFile(this.filePath, 'utf-8');
    const updated = appendToProgressSection(content, note);
    await fs.writeFile(this.filePath, updated, 'utf-8');
    return this.parseContent(updated);
  }

  // -----------------------------------------------------------------------
  // Static helpers
  // -----------------------------------------------------------------------

  /**
   * Check if a line is a checkbox item.
   */
  static isCheckboxLine(line: string): boolean {
    return isCheckboxLine(line);
  }

  /**
   * Parse a single checkbox line.
   */
  static parseCheckboxLine(line: string, index: number): LoopStep | null {
    return parseCheckboxLine(line, index);
  }

  /**
   * Get progress summary counts.
   */
  static getProgress(doc: LoopDocument): { completed: number; failed: number; pending: number; total: number } {
    let completed = 0, failed = 0, pending = 0;
    for (const step of doc.steps) {
      if (step.state === 'completed') {completed++;}
      else if (step.state === 'failed') {failed++;}
      else {pending++;}
    }
    return { completed, failed, pending, total: doc.steps.length };
  }
}

// ---------------------------------------------------------------------------
// Internal section extraction
// ---------------------------------------------------------------------------

function extractTitle(lines: string[]): string {
  for (const line of lines) {
    const m = line.match(/^#\s+(.+)$/);
    if (m) {return (m[1] ?? '').trim();}
  }
  return '';
}

interface Sections {
  config: LoopConfig;
  objective: string;
  constraints: string;
  steps: LoopStep[];
  progressNotes: string;
}

function extractSections(lines: string[]): Sections {
  let currentSection = '';
  let currentLines: string[] = [];
  let config = { ...DEFAULT_CONFIG };
  let objective = '';
  let constraints = '';
  const steps: LoopStep[] = [];
  let progressNotes = '';
  let stepIndex = 0;

  function flush() {
    switch (currentSection) {
      case '配置':
      case 'config':
      case 'Config':
        config = parseConfigSection(currentLines);
        break;
      case '目标':
      case 'objective':
      case 'Objective':
        objective = currentLines.join('\n').trim();
        break;
      case '约束':
      case 'constraints':
      case 'Constraints':
        constraints = currentLines.join('\n').trim();
        break;
      case '待办':
      case 'todos':
      case 'Todos':
        for (const line of currentLines) {
          const step = parseCheckboxLine(line, stepIndex);
          if (step) {
            steps.push(step);
            stepIndex++;
          }
        }
        break;
      case '进度记录':
      case 'progress':
      case 'Progress':
        progressNotes = currentLines.join('\n').trim();
        break;
    }
    currentLines = [];
  }

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush();
      currentSection = (heading[1] ?? '').trim();
      continue;
    }
    // Skip title line (# ...) and anything before first section
    if (currentSection) {
      currentLines.push(line);
    }
  }
  flush();

  return { config, objective, constraints, steps, progressNotes };
}

// ---------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------

function applyStepState(content: string, index: number, state: CheckboxState, note?: string): string {
  const lines = content.split('\n');
  let stepCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!isCheckboxLine(line)) {continue;}
    if (stepCount === index) {
      const step = parseCheckboxLine(line, stepCount);
      if (!step) {break;}

      // Preserve leading whitespace
      const wsMatch = line.match(/^(\s*)/);
      const ws = wsMatch?.[1] ?? '';

      // Build text portion
      let {text} = step;
      if (note) {
        text = `${step.text} ${note}`;
      }

      if (state === 'failed') {
        lines[i] = `${ws}- ~[x]~${text}`;
      } else if (state === 'completed') {
        lines[i] = `${ws}- [x] ${text}`;
      } else {
        lines[i] = `${ws}- [ ] ${text}`;
      }
      break;
    }
    stepCount++;
  }
  return lines.join('\n');
}

function appendToProgressSection(content: string, note: string): string {
  const lines = content.split('\n');

  // Find the progress section
  let progressIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('##') && line.includes('进度')) {
      progressIdx = i;
      break;
    }
  }

  const timestamp = new Date().toISOString();
  const entry = `> [${timestamp}] ${note}`;

  if (progressIdx >= 0) {
    // Insert after the heading (or after existing content)
    let insertIdx = progressIdx + 1;
    // Skip blank lines right after heading
    while (insertIdx < lines.length && (lines[insertIdx] ?? '').trim() === '') {
      insertIdx++;
    }
    lines.splice(insertIdx, 0, entry);
  } else {
    // No progress section — append one
    lines.push('', '## 进度记录', '', entry);
  }

  return lines.join('\n');
}
