#!/usr/bin/env node
/** Typed, distributable entry point for the channel CLI. */
import { existsSync, readFileSync } from 'node:fs';
import type { ActionPromptMap, InteractiveOption } from './tools/types.js';

const DEFAULT_REST_BASE_URL = 'http://localhost:19200';
const CHAT_ID_PATTERNS = [
  { prefix: 'oc_', label: 'Feishu group chat', minLength: 35 },
  { prefix: 'ou_', label: 'Feishu user (p2p chat)', minLength: 35 },
  { prefix: 'cli-', label: 'CLI session', minLength: 5 },
];

export const HELP = `channel Skill / Disclaude channel CLI

Usage:
  disclaude channel <command> [options]
  disclaude-channel <command> [options]

Commands:
  send_text        Send plain text (--text, --text-file, or stdin).
  send_file        Send a file (--file).
  send_card        Send a display-only card (--card, --card-file, or stdin).
  push_to_agent    Push an instruction to a chat agent.
  send_interactive Send an interactive card with clickable buttons.
  help             Show this help message.

Common options:
  --chat <id>      Target chat ID (oc_..., ou_..., or cli-...).
  --parent <id>   Optional parent message ID.
  --base-url <url> PrimaryNode REST URL (default: http://localhost:19200).

Output: one JSON result object on stdout; diagnostics are written to stderr.`;

type Args = { _: string[]; [key: string]: string | string[] | undefined };
type ToolResult = { success?: boolean; error?: string; message?: string };
let emitted = false;

function emitOk(payload: Record<string, unknown>): void {
  if (!emitted) { emitted = true; process.stdout.write(`${JSON.stringify({ ok: true, ...payload })}\n`); }
}
function emitFail(command: string, error: string, hint?: string): void {
  if (emitted) {return;}
  emitted = true;
  const result: Record<string, unknown> = { ok: false, command, error };
  if (hint) {result.hint = hint;}
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {args.help = 'true';}
    else if (arg.startsWith('--')) { args[arg.slice(2)] = argv[i + 1]; i += 1; }
    else {args._.push(arg);}
  }
  return args;
}
function arg(args: Args, key: string): string | undefined { return typeof args[key] === 'string' ? args[key] as string : undefined; }
function readStdin(): string | undefined {
  if (process.stdin.isTTY) {return undefined;}
  try { return readFileSync(0, 'utf8'); } catch { return undefined; }
}
function readInput(args: Args, valueKey: string, fileKey: string): string | undefined {
  const value = arg(args, valueKey);
  if (value !== undefined) {return value;}
  const file = arg(args, fileKey);
  if (file !== undefined) {
    try { return file === '-' ? readStdin() : readFileSync(file, 'utf8'); }
    catch (error) { throw new Error(`Cannot read --${fileKey} ${file}: ${errorMessage(error)}`); }
  }
  return readStdin();
}
function resolveChat(args: Args): string | undefined {
  const explicit = arg(args, 'chat');
  if (explicit !== undefined) {return explicit;}
  if (process.env.FEISHU_CLI_CHAT_ID) {return process.env.FEISHU_CLI_CHAT_ID;}
  const configPath = process.env.DISCLAUDE_CONFIG_PATH || ['disclaude.config.yaml', 'disclaude.config.yml'].find(existsSync);
  if (!configPath) {return undefined;}
  try {
    const text = readFileSync(configPath, 'utf8');
    return text.match(/^\s*cliChatId:\s*["']?([^"'\s#]+)["']?\s*$/m)?.[1];
  } catch { return undefined; }
}
function validateChat(command: string, args: Args): string | undefined {
  const id = resolveChat(args);
  if (!id) { emitFail(command, 'Missing required option --chat <id>', 'pass --chat oc_xxx'); return undefined; }
  const valid = id === id.trim() && CHAT_ID_PATTERNS.some((p) => id.startsWith(p.prefix) && id.length >= p.minLength);
  if (!valid) {
    const formats = CHAT_ID_PATTERNS.map((p) => `- \`${p.prefix}...\` (${p.label})`).join('\n');
    const shown = id.length > 20 ? `${id.slice(0, 20)}...` : id;
    emitFail(command, `Invalid chatId: Invalid chatId format: "${shown}"\nExpected one of the following formats:\n${formats}`);
    return undefined;
  }
  return id;
}
function parseJson<T>(raw: string | undefined, name: string): T | undefined {
  if (!raw) {return undefined;}
  try { return JSON.parse(raw) as T; } catch (error) { throw new Error(`Invalid --${name} JSON: ${errorMessage(error)}`); }
}
function parseMentions(raw: string | undefined): Array<{ openId: string; name?: string }> | undefined {
  const value = parseJson<unknown>(raw, 'mentions');
  if (value === undefined) {return undefined;}
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || typeof (item as { openId?: unknown }).openId !== 'string')) {throw new Error('Invalid --mentions JSON: mentions must be an array of objects with an `openId` string');}
  return value as Array<{ openId: string; name?: string }>;
}
function parseOptions(raw: string | undefined): InteractiveOption[] {
  if (!raw) {throw new Error('Missing required option --options <json-array>');}
  const value = parseJson<unknown>(raw, 'options');
  if (!Array.isArray(value) || value.length === 0) {throw new Error('options must be a non-empty array');}
  for (const [index, item] of value.entries()) {
    const option = item as Partial<InteractiveOption>;
    if (!option || typeof option.text !== 'string' || !option.text.trim()) {throw new Error(`options[${index}].text must be a non-empty string`);}
    if (typeof option.value !== 'string' || !option.value.trim()) {throw new Error(`options[${index}].value must be a non-empty string`);}
    if (option.type !== undefined && !['primary', 'default', 'danger'].includes(option.type)) {throw new Error(`options[${index}].type must be one of: primary, default, danger`);}
  }
  return value as InteractiveOption[];
}
function parseActionPrompts(raw: string | undefined): ActionPromptMap | undefined {
  const value = parseJson<unknown>(raw, 'action-prompts');
  if (value === undefined) {return undefined;}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((item) => typeof item !== 'string' || !item)) {throw new Error('action-prompts must be a JSON object mapping option value -> prompt string');}
  return value as ActionPromptMap;
}
function setupRest(args: Args): string {
  const baseUrl = arg(args, 'base-url') || process.env.DISCLAUDE_REST_IPC_BASE_URL || DEFAULT_REST_BASE_URL;
  process.env.DISCLAUDE_REST_IPC_ENABLED = 'true';
  process.env.DISCLAUDE_REST_IPC_BASE_URL = baseUrl;
  return baseUrl;
}
function withLogsRedirected<T>(fn: () => Promise<T>): Promise<T> {
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => process.stderr.write(chunk, encoding, callback)) as typeof process.stdout.write;
  return fn().finally(() => { process.stdout.write = originalWrite; });
}
function restHint(baseUrl: string): string { return `PrimaryNode REST ${baseUrl} unreachable — start the main service (disclaude-primary start --api-port <port>) or pass --base-url / DISCLAIMED_REST_IPC_BASE_URL`.replace('DISCLAUDED', 'DISCLAUDE'); }
async function restIsReachable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ping`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
async function failureHint(baseUrl: string, error: string): Promise<string | undefined> {
  if (/IPC|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(error)) {return restHint(baseUrl);}
  return await restIsReachable(baseUrl) ? undefined : restHint(baseUrl);
}

async function execute(command: string, args: Args, chatId: string, baseUrl: string): Promise<number> {
  // Parse all user-provided structured input before loading the runtime package.
  // This keeps malformed CLI input deterministic and avoids logger teardown
  // noise on fast-failure paths.
  let text: string | undefined;
  let message: string | undefined;
  let question: string | undefined;
  let filePath: string | undefined;
  let card: Record<string, unknown> | undefined;
  let parsedMentions: Array<{ openId: string; name?: string }> | undefined;
  let parsedOptions: InteractiveOption[] | undefined;
  let parsedActionPrompts: ActionPromptMap | undefined;
  try {
    if (command === 'send_text') {
      text = readInput(args, 'text', 'text-file');
      parsedMentions = parseMentions(arg(args, 'mentions'));
      if (!text) { emitFail(command, 'Missing text content', 'pass --text <string>, --text-file <path>, or pipe content on stdin'); return 1; }
    } else if (command === 'send_file') {
      filePath = arg(args, 'file');
      if (!filePath) { emitFail(command, 'Missing required option --file <path>', 'pass --file <path>'); return 1; }
    } else if (command === 'send_card') {
      const raw = readInput(args, 'card', 'card-file');
      if (!raw) { emitFail(command, 'Missing card content', 'pass --card <json>, --card-file <path>, or pipe card JSON on stdin'); return 1; }
      card = parseJson<Record<string, unknown>>(raw, 'card');
      if (!card || Array.isArray(card) || typeof card !== 'object') { emitFail(command, 'Card must be an object'); return 1; }
    } else if (command === 'push_to_agent') {
      message = readInput(args, 'message', 'message-file');
      if (!message) { emitFail(command, 'Missing message content', 'pass --message <string>, --message-file <path>, or pipe content on stdin'); return 1; }
    } else {
      question = readInput(args, 'question', 'question-file');
      if (!question || !question.trim()) { emitFail(command, 'Missing question content', 'pass --question <string>, --question-file <path>, or pipe content on stdin'); return 1; }
      parsedOptions = parseOptions(arg(args, 'options'));
      parsedActionPrompts = parseActionPrompts(arg(args, 'action-prompts'));
    }
  } catch (error) {
    const messageText = errorMessage(error);
    emitFail(command, command === 'send_card' && messageText.startsWith('Invalid --card JSON') ? messageText.replace('Invalid --card JSON', 'Invalid card JSON') : messageText);
    return 1;
  }
  let mod: typeof import('./index.js');
  try { mod = await withLogsRedirected(() => import('./index.js')); }
  catch (error) { emitFail(command, `Failed to load channel implementation: ${errorMessage(error)}`, 'run npm run build before using the packaged CLI'); return 1; }
  const parentMessageId = arg(args, 'parent');
  let result: ToolResult;
  try {
    if (command === 'send_text') {
      result = await withLogsRedirected(() => mod.send_text({ text: text as string, chatId, parentMessageId, mentions: parsedMentions }));
    } else if (command === 'send_file') {
      result = await withLogsRedirected(() => mod.send_file({ filePath: filePath as string, chatId, parentMessageId }));
    } else if (command === 'send_card') {
      const transformed = mod.transformCardTables(card as Record<string, unknown>);
      const resolved = await mod.resolveCardImages(transformed);
      result = await withLogsRedirected(() => mod.send_card({ card: resolved.card, chatId, parentMessageId }));
    } else if (command === 'push_to_agent') {
      result = await withLogsRedirected(() => mod.push_to_agent({ chatId, message: message as string }));
    } else {
      result = await withLogsRedirected(() => mod.send_interactive({ question: question as string, options: parsedOptions as InteractiveOption[], title: arg(args, 'title'), context: arg(args, 'context'), actionPrompts: parsedActionPrompts, chatId, parentMessageId }));
    }
  } catch (error) {
    const errorText = `${command} failed: ${errorMessage(error)}`;
    emitFail(command, errorText, await failureHint(baseUrl, errorText));
    return 1;
  }
  if (result.success) { emitOk({ command, chatId, result: result.message || 'sent', durationMs: 0 }); return 0; }
  const resultError = result.error || result.message || `${command} returned without success`;
  emitFail(command, resultError, await failureHint(baseUrl, resultError));
  return 1;
}

export async function run(argv: string[]): Promise<number> {
  await Promise.resolve();
  emitted = false;
  const [command] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') { process.stdout.write(`${HELP}\n`); return 0; }
  const args = parseArgs(argv.slice(1));
  const commands = ['send_text', 'send_file', 'send_card', 'push_to_agent', 'send_interactive'];
  if (!commands.includes(command)) { process.stderr.write(`Unknown command: ${command}\n`); process.stdout.write(`${HELP}\n`); return 1; }
  const chat = validateChat(command, args);
  if (!chat) {return 1;}
  return execute(command, args, chat, setupRest(args));
}

if (process.argv[1]?.endsWith('/cli.js')) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`channel CLI crashed: ${errorMessage(error)}\n`); emitFail('channel', `CLI crashed: ${errorMessage(error)}`); process.exitCode = 1; });
}
