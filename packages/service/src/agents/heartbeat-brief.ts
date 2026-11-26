/**
 * Issue #5762 (T-120): the one-line "what is it doing" brief carried by the
 * narration-silent progress heartbeat (#5654 event path, #5719 timer
 * backstop).
 *
 * The heartbeat only fires for backends that do NOT narrate, so its quoted
 * "summary" is always the user's own trigger line — the one thing the reader
 * already knows — and the only other signal is a tool count. This module
 * derives a bounded, public-safe line from metadata the platform already
 * holds at the `tool_use` event: the tool name plus a small whitelist of
 * model-authored description fields (`metadata.toolInput`). No extra model
 * call, no new SDK event (#5762 验收②), and never the command body, file
 * content, a URL or an environment value (#4774, #5762 验收③).
 *
 * Label priority per tool call (newest wins for the logged `source`):
 * todo item → Agent/Bash description → Skill → file basename → tool mix.
 */

/** `agent.progressHeartbeat.detail` — unset resolves to `'labels'`. */
export type ProgressHeartbeatDetail = 'off' | 'tools' | 'labels';

/** Where the brief line came from. Logged as `briefSource`, never the text. */
export type HeartbeatBriefSource =
  | 'off' | 'todo' | 'agent-desc' | 'bash-desc' | 'file' | 'skill' | 'tool-mix' | 'none';

export type HeartbeatLabelSource = Exclude<HeartbeatBriefSource, 'off' | 'tool-mix' | 'none'>;

/** One `tool_use` event reduced to what the brief may publish. */
export interface HeartbeatToolNote {
  toolName: string;
  label?: string;
  source?: HeartbeatLabelSource;
}

export interface HeartbeatBriefWaiting {
  toolName: string;
  label?: string;
  source?: HeartbeatLabelSource;
  /** Already-rendered "已 N 分钟" style elapsed text. */
  elapsedText: string;
}

export interface HeartbeatBriefInput {
  /** Tool calls since the last heartbeat, oldest first. */
  notes: readonly HeartbeatToolNote[];
  /** Tool name → calls since the last heartbeat. */
  usage: ReadonlyMap<string, number>;
  /** Timer backstop: the turn is parked inside this tool call (#5719). */
  waiting?: HeartbeatBriefWaiting;
}

export interface HeartbeatBrief {
  /** Full line including the prefix; absent when there is nothing to say or detail is `off`. */
  line?: string;
  source: HeartbeatBriefSource;
  /** Code units of `line` (0 when absent) — logged instead of the text. */
  length: number;
}

/** The whole brief line (prefix included) never exceeds this many code units (#5762 验收④). */
export const HEARTBEAT_BRIEF_MAX_LINE = 80;
/** Upper bound on any single label before joining. */
export const HEARTBEAT_BRIEF_MAX_LABEL = 30;
/** Distinct labels shown in one brief, oldest → newest. */
export const HEARTBEAT_BRIEF_MAX_LABELS = 3;
export const HEARTBEAT_BRIEF_PREFIX = '最近在做：';

/** Tool names shown in the `Tool×count` mix. */
const MAX_MIX_TOOLS = 4;

export function normalizeHeartbeatDetail(value: unknown): ProgressHeartbeatDetail {
  return value === 'off' || value === 'tools' ? value : 'labels';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Model-authored text → one bounded line, or undefined when unusable. Fails
 * closed: a description carrying a URL or a credential-looking assignment is
 * dropped rather than published, even though it is only a description.
 */
export function cleanHeartbeatLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') { return undefined; }
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0) { return undefined; }
  if (text.includes('://') || /[A-Za-z0-9_]*(?:token|key|secret|password)[A-Za-z0-9_]*\s*=/i.test(text)) {
    return undefined;
  }
  return truncate(text, HEARTBEAT_BRIEF_MAX_LABEL);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

/** Path basename only — directories are not published. */
function baseName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') { return undefined; }
  const base = raw.split(/[\\/]/).pop() ?? '';
  return base.length > 0 && base.length <= HEARTBEAT_BRIEF_MAX_LABEL ? base : undefined;
}

/**
 * Whitelisted label for one tool call. Only description-grade fields are
 * read: `Bash.command`, file contents, URLs and every unlisted tool yield
 * undefined.
 */
export function labelForToolUse(toolName: string, toolInput: unknown): { label: string; source: HeartbeatLabelSource } | undefined {
  const input = asRecord(toolInput);
  switch (toolName) {
    case 'TodoWrite': {
      const todos = Array.isArray(input?.todos) ? input.todos : [];
      for (let i = todos.length - 1; i >= 0; i--) {
        const todo = asRecord(todos[i]);
        if (todo?.status !== 'in_progress') { continue; }
        const label = cleanHeartbeatLabel(todo.activeForm) ?? cleanHeartbeatLabel(todo.content);
        return label === undefined ? undefined : { label, source: 'todo' };
      }
      return undefined;
    }
    case 'TaskCreate':
    case 'TaskUpdate': {
      // TaskUpdate without a `subject` (status-only) is not a label.
      const label = cleanHeartbeatLabel(input?.subject);
      return label === undefined ? undefined : { label, source: 'todo' };
    }
    case 'Agent':
    case 'Task': {
      const label = cleanHeartbeatLabel(input?.description);
      if (label === undefined) { return undefined; }
      const type = cleanHeartbeatLabel(input?.subagent_type);
      return { label: type === undefined ? label : `${label}（${type}）`, source: 'agent-desc' };
    }
    case 'Bash': {
      // `description` only — never `command` (#5762 验收③).
      const label = cleanHeartbeatLabel(input?.description);
      return label === undefined ? undefined : { label, source: 'bash-desc' };
    }
    case 'Skill': {
      const label = cleanHeartbeatLabel(input?.skill);
      return label === undefined ? undefined : { label, source: 'skill' };
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const label = cleanHeartbeatLabel(baseName(input?.file_path ?? input?.notebook_path));
      return label === undefined ? undefined : { label, source: 'file' };
    }
    default:
      return undefined;
  }
}

function formatToolMix(usage: ReadonlyMap<string, number>): string {
  const ranked = [...usage.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_MIX_TOOLS);
  return ranked.map(([name, count]) => `${name}×${count}`).join('、');
}

/** Last N distinct labels, oldest → newest; a repeated label moves to the newest slot. */
function recentLabels(notes: readonly HeartbeatToolNote[]): string[] {
  const distinct = new Map<string, void>();
  for (const note of notes) {
    if (note.label === undefined) { continue; }
    distinct.delete(note.label);
    distinct.set(note.label, undefined);
    if (distinct.size > HEARTBEAT_BRIEF_MAX_LABELS) { distinct.delete(distinct.keys().next().value as string); }
  }
  return [...distinct.keys()];
}

function finish(line: string | undefined, source: HeartbeatBriefSource): HeartbeatBrief {
  return line === undefined ? { source, length: 0 } : { line, source, length: line.length };
}

/**
 * Build the brief line for one heartbeat. Pure: the caller owns the window
 * bookkeeping (notes/usage reset on send, the outstanding tool for the
 * timer backstop) and passes the rendered elapsed text.
 */
export function buildHeartbeatBrief(detail: ProgressHeartbeatDetail, input: HeartbeatBriefInput): HeartbeatBrief {
  if (detail === 'off') { return finish(undefined, 'off'); }
  const maxBody = HEARTBEAT_BRIEF_MAX_LINE - HEARTBEAT_BRIEF_PREFIX.length;
  const mix = formatToolMix(input.usage);
  const mixBrief = (): HeartbeatBrief => mix.length === 0
    ? finish(undefined, 'none')
    : finish(HEARTBEAT_BRIEF_PREFIX + truncate(mix, maxBody), 'tool-mix');

  if (detail === 'tools') { return mixBrief(); }

  const { waiting } = input;
  if (waiting) {
    const body = `等待「${waiting.label ?? waiting.toolName}」（${waiting.toolName}，已 ${waiting.elapsedText}）`;
    return finish(HEARTBEAT_BRIEF_PREFIX + truncate(body, maxBody), waiting.source ?? 'tool-mix');
  }

  const labels = recentLabels(input.notes);
  if (labels.length === 0) { return mixBrief(); }
  const newestLabelled = [...input.notes].reverse().find(note => note.label !== undefined);
  let body = labels.join(' → ');
  if (body.length <= maxBody) {
    const suffix = mix.length > 0 ? `（${mix}）` : '';
    if (body.length + suffix.length <= maxBody) { body += suffix; }
  }
  return finish(HEARTBEAT_BRIEF_PREFIX + truncate(body, maxBody), newestLabelled?.source ?? 'tool-mix');
}
