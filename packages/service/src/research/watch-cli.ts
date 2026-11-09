/**
 * `disclaude research watch ...` — on-demand research doc comment watch
 * control CLI (T-089 rework / #5197, review 6677596913).
 *
 * The maintainer direction: comment monitoring must not run automatically;
 * agents listen on demand. This thin REST client is the agent-facing switch —
 * it starts/stops/inspects a watch session hosted by the running disclaude
 * service and manages the explicit document → Project associations the session
 * polls. It never polls anything itself: with no session started there is
 * nothing resident anywhere.
 *
 * Output contract matches the channel CLI: exactly one single-line JSON
 * object (`{"ok":true,...}` on success, `{"ok":false,...}` with `error` and an
 * actionable `hint` on failure) so the unified bin router and agents can parse
 * it deterministically.
 *
 * Usage:
 *   disclaude research watch start [--interval SEC]   start/resume the watch session
 *   disclaude research watch stop                     stop the session (checkpoint kept)
 *   disclaude research watch status                   session + checkpoint + error report
 *   disclaude research watch add --doc T --chat C [--type docx] [--project N] [--as user|bot]
 *   disclaude research watch remove --doc T           drop the document association
 *
 * Common flags: --base-url URL (or DISCLAUDE_API_BASE_URL), --api-token TOKEN
 * (or DISCLAUDE_API_TOKEN) — the same wiring managed agents inherit.
 */

import { normalizeChannelApiBaseUrl } from '@disclaude/core';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export const RESEARCH_WATCH_HELP = [
  'disclaude research watch — on-demand research document comment watching (#5197)',
  '',
  'Usage:',
  '  disclaude research watch start [--interval SEC] [--base-url URL] [--api-token TOKEN]',
  '  disclaude research watch stop',
  '  disclaude research watch status',
  '  disclaude research watch add --doc TOKEN --chat CHAT_ID [--type docx] [--project NAME] [--as user|bot]',
  '  disclaude research watch remove --doc TOKEN',
  '',
  'The service polls ONLY explicitly associated research documents, and only',
  'while a session is running. New comments are delivered to the original',
  'research Project chat as system messages; the watcher never edits documents',
  'or replies to comments itself. Sessions resume from the persisted checkpoint',
  '(no duplicate delivery); failures back off and are reported via `status`.',
].join('\n');

/** Parsed watch subcommand (the leading `research` was consumed by cli-main). */
export type ResearchWatchCommand =
  | { kind: 'help' }
  | { kind: 'start'; intervalSec?: number; baseUrl?: string; apiToken?: string }
  | { kind: 'stop'; baseUrl?: string; apiToken?: string }
  | { kind: 'status'; baseUrl?: string; apiToken?: string }
  | { kind: 'add'; docToken: string; chatId: string; docType?: string; projectName?: string; identity?: string; baseUrl?: string; apiToken?: string }
  | { kind: 'remove'; docToken: string; baseUrl?: string; apiToken?: string };

/** Flags every subcommand accepts. */
const COMMON_FLAGS = ['base-url', 'api-token'];
const SUBCOMMAND_FLAGS: Record<string, string[]> = {
  start: ['interval'],
  stop: [],
  status: [],
  add: ['doc', 'chat', 'type', 'project', 'as'],
  remove: ['doc'],
};

interface RawArgs {
  flags: Map<string, string | true>;
  positionals: string[];
  /** Flags seen without a usable value (channel-cli #4788 pattern). */
  missing: string[];
}

function lex(argv: string[]): RawArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  const missing: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.set('help', true);
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags.set(key, true);
        missing.push(key);
      } else {
        flags.set(key, value);
        i += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals, missing };
}

function rejectUnknownFlags(subcommand: string, raw: RawArgs): string | undefined {
  const allowed = new Set([...COMMON_FLAGS, ...(SUBCOMMAND_FLAGS[subcommand] ?? [])]);
  const unknown = [...raw.flags.keys(), ...raw.missing].filter(key => key !== 'help' && !allowed.has(key));
  if (unknown.length === 0) { return undefined; }
  const listed = unknown.map(key => `--${key}`).join(', ');
  const valid = [...allowed].sort().map(key => `--${key}`).join(', ');
  return `Unknown option${unknown.length > 1 ? 's' : ''}: ${listed} (${subcommand} accepts: ${valid})`;
}

function stringFlag(raw: RawArgs, key: string): string | undefined {
  const value = raw.flags.get(key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse `research watch` arguments (argv starts at `watch`). Throws `Error`
 * with a usage-shaped message on invalid input; callers turn that into the
 * failure JSON line.
 */
export function parseResearchWatchArgs(argv: string[]): ResearchWatchCommand {
  const raw = lex(argv);
  if (raw.flags.has('help')) { return { kind: 'help' }; }
  if (raw.positionals.length === 0) {
    throw new Error('missing subcommand; expected research watch start|stop|status|add|remove');
  }
  const [head, subcommand] = raw.positionals;
  if (head !== 'watch') {
    throw new Error(`unexpected argument ${JSON.stringify(head)}; expected 'research watch <subcommand>'`);
  }
  if (subcommand === undefined) {
    throw new Error('missing subcommand; expected start|stop|status|add|remove');
  }
  if (!['start', 'stop', 'status', 'add', 'remove'].includes(subcommand)) {
    throw new Error(`unknown subcommand ${JSON.stringify(subcommand)}; expected start|stop|status|add|remove`);
  }
  if (raw.positionals.length > 2) {
    throw new Error(`unexpected positional argument ${JSON.stringify(raw.positionals[2])}`);
  }
  const unknown = rejectUnknownFlags(subcommand, raw);
  if (unknown) { throw new Error(unknown); }
  if (raw.missing.length > 0) {
    throw new Error(`missing value for --${raw.missing[0]}`);
  }
  const common = {
    ...(stringFlag(raw, 'base-url') !== undefined ? { baseUrl: stringFlag(raw, 'base-url') } : {}),
    ...(stringFlag(raw, 'api-token') !== undefined ? { apiToken: stringFlag(raw, 'api-token') } : {}),
  };
  if (subcommand === 'start') {
    const interval = stringFlag(raw, 'interval');
    if (interval !== undefined) {
      const seconds = Number(interval);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('--interval must be a positive number of seconds');
      }
      return { kind: 'start', intervalSec: seconds, ...common };
    }
    return { kind: 'start', ...common };
  }
  if (subcommand === 'stop' || subcommand === 'status') {
    return { kind: subcommand, ...common };
  }
  const docToken = stringFlag(raw, 'doc');
  if (!docToken) { throw new Error(`${subcommand} requires --doc <docToken>`); }
  if (subcommand === 'remove') {
    return { kind: 'remove', docToken, ...common };
  }
  const chatId = stringFlag(raw, 'chat');
  if (!chatId) { throw new Error('add requires --chat <chatId>'); }
  const identity = stringFlag(raw, 'as');
  if (identity !== undefined && identity !== 'user' && identity !== 'bot') {
    throw new Error('--as must be user or bot');
  }
  return {
    kind: 'add',
    docToken,
    chatId,
    ...(stringFlag(raw, 'type') !== undefined ? { docType: stringFlag(raw, 'type') } : {}),
    ...(stringFlag(raw, 'project') !== undefined ? { projectName: stringFlag(raw, 'project') } : {}),
    ...(identity !== undefined ? { identity } : {}),
    ...common,
  };
}

/** Transport/output injection point for tests. */
export interface ResearchWatchCliIo {
  fetchImpl?: typeof fetch;
  /** Default `process.stdout.write`. */
  write(line: string): void;
  env?: NodeJS.ProcessEnv;
  now?(): number;
}

interface WatchRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

function requestFor(command: ResearchWatchCommand): WatchRequest | undefined {
  switch (command.kind) {
    case 'start':
      return {
        method: 'POST',
        path: '/api/research/watch/start',
        ...(command.intervalSec !== undefined ? { body: { intervalSec: command.intervalSec } } : {}),
      };
    case 'stop':
      return { method: 'POST', path: '/api/research/watch/stop', body: {} };
    case 'status':
      return { method: 'GET', path: '/api/research/watch/status' };
    case 'add':
      return {
        method: 'POST',
        path: '/api/research/watch/register',
        body: {
          docToken: command.docToken,
          chatId: command.chatId,
          ...(command.docType !== undefined ? { docType: command.docType } : {}),
          ...(command.projectName !== undefined ? { projectName: command.projectName } : {}),
          ...(command.identity !== undefined ? { identity: command.identity } : {}),
        },
      };
    case 'remove':
      return { method: 'POST', path: '/api/research/watch/unregister', body: { docToken: command.docToken } };
    default:
      return undefined;
  }
}

/**
 * Run one watch subcommand against the running disclaude service. Prints
 * exactly one JSON line and resolves with the process exit code (0 success,
 * 1 failure).
 */
export async function runResearchWatchCommand(
  command: ResearchWatchCommand,
  io: ResearchWatchCliIo,
): Promise<number> {
  if (command.kind === 'help') {
    io.write(`${RESEARCH_WATCH_HELP}\n`);
    return 0;
  }
  const env = io.env ?? {};
  const rawBaseUrl = command.baseUrl ?? env.DISCLAUDE_API_BASE_URL ?? '';
  const apiToken = (command.apiToken ?? env.DISCLAUDE_API_TOKEN ?? '').trim() || undefined;
  let baseUrl: string;
  try {
    baseUrl = normalizeChannelApiBaseUrl(rawBaseUrl);
  } catch (error) {
    emitFailure(io, command.kind, error instanceof Error ? error.message : String(error),
      'pass --base-url or set DISCLAUDE_API_BASE_URL to the running disclaude service API address');
    return 1;
  }
  const request = requestFor(command);
  if (!request) {
    emitFailure(io, command.kind, 'unhandled subcommand');
    return 1;
  }
  const fetchImpl = io.fetchImpl ?? fetch;
  let response: Response;
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (request.body !== undefined) { headers['content-type'] = 'application/json'; }
    if (apiToken) { headers.authorization = `Bearer ${apiToken}`; }
    response = await fetchImpl(`${baseUrl}${request.path}`, {
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? `request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS / 1000}s`
      : error instanceof Error ? error.message : String(error);
    emitFailure(io, command.kind, `cannot reach the disclaude service: ${reason}`,
      'the service must be running with its HTTP API (--api-port); managed agents inherit DISCLAUDE_API_BASE_URL');
    return 1;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    emitFailure(io, command.kind, `service responded with HTTP ${response.status} and a non-JSON body`);
    return 1;
  }
  if (response.ok && isOkObject(payload)) {
    // Forward the server payload verbatim (watch status, registration, …).
    io.write(`${JSON.stringify({ ok: true, ...payload })}\n`);
    return 0;
  }
  const message = isOkObject(payload) && typeof payload.message === 'string'
    ? payload.message
    : `service responded with HTTP ${response.status}`;
  const hint = response.status === 401
    ? 'the service requires its API token: pass --api-token or set DISCLAUDE_API_TOKEN'
    : undefined;
  emitFailure(io, command.kind, message, hint);
  return 1;
}

function isOkObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emitFailure(io: ResearchWatchCliIo, command: string, error: string, hint?: string): void {
  const result: Record<string, unknown> = { ok: false, command: `research watch ${command}`, error };
  if (hint) { result.hint = hint; }
  io.write(`${JSON.stringify(result)}\n`);
}

/**
 * Entry used by cli-main.ts: parse `args` (everything after `disclaude
 * research`) and run the subcommand. Never throws — parse errors become the
 * failure JSON line.
 */
export async function runResearchWatchCli(args: string[]): Promise<number> {
  const io: ResearchWatchCliIo = {
    write: line => { process.stdout.write(line); },
    env: process.env,
  };
  let command: ResearchWatchCommand;
  try {
    command = parseResearchWatchArgs(args);
  } catch (error) {
    const sub = args[0] === 'watch' ? args[1] : args[0];
    emitFailure(io, ['start', 'stop', 'status', 'add', 'remove'].includes(sub ?? '') ? sub : 'watch',
      error instanceof Error ? error.message : String(error),
      'run `disclaude research watch --help` for usage');
    return 1;
  }
  return await runResearchWatchCommand(command, io);
}
