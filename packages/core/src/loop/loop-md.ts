/**
 * LOOP.md — the loop definition file (Issue #4193).
 *
 * A LOOP.md is a single file that defines a loop: a small YAML frontmatter
 * (the loop's structural parameters) followed by a markdown body (the prompt
 * executed each iteration). The runner reads it fresh every iteration, so the
 * file is **read-only at runtime** — there is no write conflict between the
 * runner and a user/editor who adjusts the prompt mid-run.
 *
 * Recommended location (per #4193 / #4040):
 *   `.disclaude/loop/<name>/LOOP.md`
 * The parser/reader here are path-agnostic; the caller resolves the path.
 *
 * Scope: this module is the **spec + parser** (Issue #4193 scope item 1). The
 * runner consuming it (`startFromLoopMd`, re-reading the prompt each iteration)
 * lives in primary-node; migrating the MCP/IPC/REST `loop_start` contract onto
 * LOOP.md is a later part.
 *
 * @module @disclaude/core/loop
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'node:path';
import * as yaml from 'js-yaml';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LoopMd');

/** Recommended directory + filename for a loop definition file (#4193). */
export const LOOP_MD_DIR = '.disclaude/loop';
export const LOOP_MD_FILENAME = 'LOOP.md';

/**
 * Parsed loop parameters (the LOOP.md YAML frontmatter, normalized to the
 * shapes the runner consumes — durations become milliseconds).
 */
export interface LoopMdParams {
  /** Loop name / slug. Required. */
  name: string;
  /** Target chat the runner pushes each iteration's prompt to. Required. */
  chatId: string;
  /** Working directory for the loop (optional; informational for the runner). */
  workDir?: string;
  /** Max iterations (default 10, per the runner's `LoopStartParams`). */
  maxSteps: number;
  /** Max total duration in ms (default 1h). */
  maxDurationMs: number;
  /** Interval between iterations in ms (default 30s). */
  stepIntervalMs: number;
  /** Free-form status marker (e.g. `running`). Optional, informational. */
  status?: string;
  /** ISO timestamp the loop was started. Optional, informational. */
  startedAt?: string;
}

/** A parsed LOOP.md: normalized params + the prompt body. */
export interface LoopMdDefinition {
  params: LoopMdParams;
  /** The prompt executed each iteration (markdown body, trimmed). */
  prompt: string;
  /** Absolute path the definition was read from, when read via {@link readLoopMd}. */
  sourcePath?: string;
}

/** Defaults mirror `LoopRunner`'s `LoopStartParams` defaults (Issue #4075). */
const DEFAULT_MAX_STEPS = 10;
const DEFAULT_MAX_DURATION_MS = 3600_000; // 1h
const DEFAULT_STEP_INTERVAL_MS = 30_000; // 30s

/** Unit → millisecond multipliers for {@link parseDuration}. */
const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3600_000,
  d: 86_400_000,
};

/**
 * Parse a human duration or millisecond count into milliseconds.
 *
 * Accepts:
 * - a number (treated as milliseconds),
 * - a bare-numeric string (`"30000"` → 30000ms),
 * - a unit-suffixed string (`"2h"`, `"30m"`, `"45s"`, `"500ms"`, `"1d"`).
 *
 * Throws on an unparseable string. Returns `defaultMs` for `null`/`undefined`.
 */
export function parseDuration(
  input: string | number | null | undefined,
  defaultMs: number,
): number {
  if (input === null || input === undefined) {
    return defaultMs;
  }
  if (typeof input === 'number') {
    return Math.max(0, input);
  }
  const s = String(input).trim();
  if (s === '') {
    return defaultMs;
  }
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    return Math.max(0, Math.round(parseFloat(s))); // bare number → ms
  }
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!match) {
    throw new Error(
      `Invalid duration "${input}" (expected e.g. "2h", "30m", "45s", "500ms", or a number of ms)`,
    );
  }
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return Math.max(0, Math.round(value * DURATION_UNITS[unit]));
}

/** Raw frontmatter as it may appear in LOOP.md (all fields optional at parse time). */
interface RawLoopMdFrontmatter {
  name?: unknown;
  chatId?: unknown;
  workDir?: unknown;
  maxSteps?: unknown;
  maxDuration?: string | number;
  stepInterval?: string | number;
  status?: unknown;
  startedAt?: unknown;
}

/**
 * Split a LOOP.md document into its YAML frontmatter text and prompt body.
 *
 * Frontmatter is optional: a leading `---\n...\n---` fence. When absent the
 * entire document is the body (params fall back to defaults).
 */
function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  // A document must START with a `---` line to be treated as frontmatter.
  const open = /^---[ \t]*\r?\n/.exec(content);
  if (!open) {
    return { frontmatter: null, body: content };
  }
  const afterOpen = content.slice(open[0].length);
  // The closing fence is the next line that is exactly `---` (optional trailing
  // whitespace), anywhere in the document. `m` makes `^` match line starts, so
  // a body that itself contains a `---` line does not fool the close match — it
  // simply lands after the real closing fence.
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(afterOpen);
  if (!close) {
    // Opening fence with no closing fence: not valid frontmatter. Treat the
    // whole document as body rather than silently dropping content.
    return { frontmatter: null, body: content };
  }
  const frontmatter = afterOpen.slice(0, close.index);
  const body = afterOpen.slice(close.index + close[0].length);
  return { frontmatter, body };
}

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  // js-yaml parses unquoted timestamps (e.g. `startedAt: 2026-07-09T...Z`) as
  // native Date objects; coerce to ISO string so authors don't have to quote.
  if (value instanceof Date) {
    return value.toISOString();
  }
  // yaml may parse unquoted numerics as numbers; coerce for name/chatId-style
  // fields but warn so authors know to quote them.
  if (typeof value === 'number' || typeof value === 'boolean') {
    logger.warn({ field, value }, 'LOOP.md field parsed as non-string; coercing');
    return String(value);
  }
  throw new Error(`LOOP.md field "${field}" must be a string, got ${typeof value}`);
}

function asPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Math.max(0, parseInt(value.trim(), 10));
  }
  throw new Error(`LOOP.md field "${field}" must be a non-negative integer, got ${JSON.stringify(value)}`);
}

/**
 * Parse a LOOP.md document (file contents) into a {@link LoopMdDefinition}.
 *
 * Frontmatter is optional; `name` is required when frontmatter is present.
 * `chatId` is NOT enforced here (it is required only for the runner, which
 * validates it separately) so a frontmatter-less prompt-only document parses.
 */
export function parseLoopMd(content: string): LoopMdDefinition {
  const { frontmatter, body } = splitFrontmatter(content);

  let raw: RawLoopMdFrontmatter = {};
  if (frontmatter !== null) {
    const loaded = yaml.load(frontmatter) as unknown;
    if (loaded === undefined || loaded === null) {
      raw = {};
    } else if (typeof loaded !== 'object' || Array.isArray(loaded)) {
      throw new Error('LOOP.md frontmatter must be a YAML mapping (key: value), got a different shape');
    } else {
      raw = loaded as RawLoopMdFrontmatter;
    }
  }

  const name = asString(raw.name, 'name');
  if (frontmatter !== null && (!name || name.trim() === '')) {
    // name is the loop's identity; require it when frontmatter is used.
    throw new Error('LOOP.md frontmatter is missing required field "name"');
  }

  const params: LoopMdParams = {
    name: name ?? '',
    chatId: asString(raw.chatId, 'chatId') ?? '',
    workDir: asString(raw.workDir, 'workDir'),
    maxSteps: asPositiveInt(raw.maxSteps, 'maxSteps') ?? DEFAULT_MAX_STEPS,
    maxDurationMs: parseDuration(raw.maxDuration, DEFAULT_MAX_DURATION_MS),
    stepIntervalMs: parseDuration(raw.stepInterval, DEFAULT_STEP_INTERVAL_MS),
    status: asString(raw.status, 'status'),
    startedAt: asString(raw.startedAt, 'startedAt'),
  };

  return { params, prompt: body.trim() };
}

/**
 * Read and parse a LOOP.md file from disk (synchronous read).
 *
 * Throws if the file cannot be read or parsed.
 */
export function readLoopMd(path: string): LoopMdDefinition {
  const content = readFileSync(path, 'utf-8');
  const def = parseLoopMd(content);
  def.sourcePath = path;
  return def;
}

/**
 * Build the conventional LOOP.md path for a loop name under a base directory:
 * `<baseDir>/.disclaude/loop/<name>/LOOP.md` (per #4193 / #4040).
 */
export function loopMdPath(name: string, baseDir: string = process.cwd()): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (safe === '') {
    throw new Error(`LOOP.md loop name "${name}" has no filesystem-safe characters`);
  }
  // Use posix join semantics for a stable cross-platform path string.
  const base = baseDir.replace(/\/+$/, '');
  return `${base}/${LOOP_MD_DIR}/${safe}/${LOOP_MD_FILENAME}`;
}

/**
 * Serialize a {@link LoopMdDefinition} back into the LOOP.md document format
 * (YAML frontmatter + prompt body) — the inverse of {@link parseLoopMd}.
 *
 * The frontmatter uses the same keys the parser reads (`name` / `chatId` /
 * `workDir` / `maxSteps` / `maxDuration` / `stepInterval` / `status` /
 * `startedAt`); durations are written as millisecond numbers, which
 * {@link parseDuration} accepts, so `parseLoopMd(serializeLoopMd(def))`
 * round-trips. Optional fields (`workDir` / `status` / `startedAt`) are omitted
 * when absent rather than emitted as `null`.
 *
 * Issue #4040 (part 1): the loop skill creates a LOOP.md definition file; this
 * writer is the primitive for that step (mirroring {@link readLoopMd}). It does
 * not start a loop — that is the runner's job.
 */
export function serializeLoopMd(def: LoopMdDefinition): string {
  const { params } = def;
  // Build the frontmatter mapping, omitting optional absent fields.
  const frontmatter: Record<string, unknown> = {
    name: params.name,
    chatId: params.chatId,
    maxSteps: params.maxSteps,
    maxDuration: params.maxDurationMs,
    stepInterval: params.stepIntervalMs,
  };
  if (params.workDir !== undefined) {
    frontmatter.workDir = params.workDir;
  }
  if (params.status !== undefined) {
    frontmatter.status = params.status;
  }
  if (params.startedAt !== undefined) {
    frontmatter.startedAt = params.startedAt;
  }

  // yaml.dump emits each key on its own line with a trailing newline; wrap with
  // the `---` fences the parser expects (splitFrontmatter requires the doc to
  // start with a `---` line).
  const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
  return `---\n${yamlStr}---\n${def.prompt.trim()}\n`;
}

/**
 * Serialize {@link def} and write it to `path` as a LOOP.md file (synchronous).
 *
 * Creates the parent directory if it does not exist (the conventional path
 * `.disclaude/loop/<name>/LOOP.md` usually does not exist yet when the skill
 * first writes it). Mirrors {@link readLoopMd}. Does not start a loop.
 */
export function writeLoopMd(def: LoopMdDefinition, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeLoopMd(def), 'utf-8');
}
