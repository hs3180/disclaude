/**
 * LOOP.md format parser.
 *
 * Parses the markdown-based LOOP.md format defined in issue #4039.
 * Supports: title, config section, goal, constraints, checkbox-based todos
 * (including failed items marked with ~[x]~), and progress records.
 *
 * @module primary-node/loop/loop-md-parser
 */

/** Status of an individual todo item. */
export type TodoStatus = 'pending' | 'completed' | 'failed';

/** A single todo checkbox item from the LOOP.md 待办 section. */
export interface LoopTodoItem {
  /** Raw text of the item (without the checkbox marker). */
  text: string;
  /** Current status. */
  status: TodoStatus;
  /** Optional note appended after the item (e.g. failure reason). */
  note?: string;
}

/** Configuration parsed from the ## 配置 section. */
export interface LoopConfig {
  /** true = fresh session per step, false = single session (default: false). */
  clearContextPerStep: boolean;
  /** Maximum total execution time (e.g. "2h", "30m"). */
  maxDuration?: string;
  /** Maximum number of consecutive failures before stopping. */
  maxConsecutiveFailures?: number;
}

/** Full parsed LOOP.md document. */
export interface ParsedLoopMd {
  /** Title from the first H1 heading. */
  title: string;
  /** Configuration values. */
  config: LoopConfig;
  /** Goal text from the ## 目标 section. */
  goal: string;
  /** Constraint text from the ## 约束 section. */
  constraints: string;
  /** Todo items from the ## 待办 section. */
  todos: LoopTodoItem[];
  /** Progress records from the ## 进度记录 section. */
  progress: string;
  /** Any sections not explicitly parsed, keyed by heading. */
  extraSections: Record<string, string>;
}

/**
 * Parse a LOOP.md markdown string into a structured object.
 *
 * Supported checkbox formats:
 *   `- [ ] task`        → pending
 *   `- [x] task`        → completed
 *   `- ~[x]~ task`      → failed
 *   `- ~[x]~ task (failed: reason)` → failed with note
 */
export function parseLoopMd(content: string): ParsedLoopMd {
  const lines = content.split('\n');

  // Extract title from first H1
  const titleLine = lines.find((l) => l.startsWith('# '));
  const title = titleLine ? titleLine.replace(/^#\s+/, '').trim() : '';

  // Split into sections by H2 headings
  const sections = splitSections(lines);

  // Parse config section
  const config = parseConfig(sections['配置'] ?? sections['config'] ?? '');

  // Parse goal
  const goal = (sections['目标'] ?? sections['goal'] ?? '').trim();

  // Parse constraints
  const constraints = (sections['约束'] ?? sections['constraints'] ?? '').trim();

  // Parse todos
  const todos = parseTodos(sections['待办'] ?? sections['todo'] ?? sections['todos'] ?? '');

  // Parse progress
  const progress = (sections['进度记录'] ?? sections['progress'] ?? '').trim();

  // Collect extra sections (not title, config, goal, constraints, todos, progress)
  const knownSections = new Set([
    '配置', 'config',
    '目标', 'goal',
    '约束', 'constraints',
    '待办', 'todo', 'todos',
    '进度记录', 'progress',
  ]);
  const extraSections: Record<string, string> = {};
  for (const [heading, body] of Object.entries(sections)) {
    if (!knownSections.has(heading)) {
      extraSections[heading] = body;
    }
  }

  return { title, config, goal, constraints, todos, progress, extraSections };
}

/**
 * Check whether all todo items in a parsed LOOP.md are completed or failed.
 */
export function isLoopComplete(parsed: ParsedLoopMd): boolean {
  return parsed.todos.length > 0 && parsed.todos.every((t) => t.status !== 'pending');
}

/**
 * Count todos by status.
 */
export function getTodoStats(parsed: ParsedLoopMd): {
  total: number;
  completed: number;
  failed: number;
  pending: number;
} {
  const total = parsed.todos.length;
  const completed = parsed.todos.filter((t) => t.status === 'completed').length;
  const failed = parsed.todos.filter((t) => t.status === 'failed').length;
  return { total, completed, failed, pending: total - completed - failed };
}

// ── Internal helpers ──────────────────────────────────────────────

/** Split lines into sections keyed by H2 heading text. */
function splitSections(lines: string[]): Record<string, string> {
  const sections: Record<string, string> = {};
  let currentHeading = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentHeading) {
        sections[currentHeading] = currentBody.join('\n');
      }
      currentHeading = line.replace(/^##\s+/, '').trim();
      currentBody = [];
    } else if (currentHeading) {
      currentBody.push(line);
    }
  }
  if (currentHeading) {
    sections[currentHeading] = currentBody.join('\n');
  }
  return sections;
}

/** Parse the config section into a LoopConfig object. */
function parseConfig(body: string): LoopConfig {
  const config: LoopConfig = { clearContextPerStep: false };
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    // Match `- **key**: value` format
    const match = trimmed.match(/^-\s+\*\*(.+?)\*\*:\s*(.+)$/);
    if (!match) {continue;}
    const [, rawKey, rawValue] = match;
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();

    if (key === 'clear_context_per_step') {
      config.clearContextPerStep = value === 'true';
    } else if (key === 'max_duration') {
      config.maxDuration = value;
    } else if (key === 'max_consecutive_failures') {
      const n = parseInt(value, 10);
      if (!Number.isNaN(n)) {
        config.maxConsecutiveFailures = n;
      }
    }
  }
  return config;
}

/** Parse todo checkbox lines into LoopTodoItem array. */
function parseTodos(body: string): LoopTodoItem[] {
  const items: LoopTodoItem[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();

    // Failed item: `- ~[x]~ text`
    const failedMatch = trimmed.match(/^-\s+~\[x\]~\s+(.+)$/);
    if (failedMatch) {
      const [, rest] = failedMatch;
      // Check for note in parentheses: "text（failed: reason）" or "text (failed: reason)"
      const noteMatch = rest.match(/^(.+?)\s*[（(](.+?)[）)]\s*$/);
      if (noteMatch && /fail/i.test(noteMatch[2])) {
        items.push({ text: noteMatch[1].trim(), status: 'failed', note: noteMatch[2].trim() });
      } else {
        items.push({ text: rest.trim(), status: 'failed' });
      }
      continue;
    }

    // Completed item: `- [x] text`
    const completedMatch = trimmed.match(/^-\s+\[x\]\s+(.+)$/);
    if (completedMatch) {
      items.push({ text: completedMatch[1].trim(), status: 'completed' });
      continue;
    }

    // Pending item: `- [ ] text`
    const pendingMatch = trimmed.match(/^-\s+\[ \]\s+(.+)$/);
    if (pendingMatch) {
      items.push({ text: pendingMatch[1].trim(), status: 'pending' });
      continue;
    }
  }
  return items;
}
