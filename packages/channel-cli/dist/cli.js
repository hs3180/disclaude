#!/usr/bin/env node
/** Typed, distributable entry point for the channel CLI. */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL_CLI_HELP, getChannelCliCommandHelp, normalizeChannelApiBaseUrl, isSyntheticMessageId } from "../../core/dist/index.js";
import { getChatIdValidationError } from './utils/chat-id-validator.js';
import { assertReadableInteractiveText } from './utils/interactive-text.js';
import { getCardValidationError, isValidFeishuCard } from './utils/card-validator.js';
// Issue #4788 (second root cause): parseArgs used to store every `--foo` it saw
// and silently consume the next argv entry as its value. A misspelled or invented
// flag therefore ate a real argument and surfaced as a confusing downstream error
// (`--payload '{...}'` swallowed the payload, then failed with "Missing question
// content"). These lists let the CLI name the bad flag instead.
const COMMON_FLAGS = ['chat', 'parent', 'base-url', 'api-token', 'dry-run'];
const COMMAND_FLAGS = {
    request_private_input: ['actor', 'source', 'workflow', 'workflow-file'],
    send_text: ['text', 'text-file', 'mentions'],
    send_file: ['file'],
    send_card: ['card', 'card-file'],
    push_to_agent: ['message', 'message-file'],
    send_interactive: ['question', 'question-file', 'options', 'options-file', 'action-prompts', 'action-prompts-file', 'title', 'context', 'thread-root', 'idempotency-key'],
};
// Issue #4705: single source of truth shared with the message builder's
// in-prompt channel CLI guidance (CHANNEL_CLI_HELP in @disclaude/core), so the
// CLI's `help` output and the agent prompt can't drift apart.
export const HELP = CHANNEL_CLI_HELP;
let emitted = false;
let autoRunOutput;
function writeResult(value) {
    (autoRunOutput ?? process.stdout.write).call(process.stdout, value);
}
function emitOk(payload) {
    if (!emitted) {
        emitted = true;
        writeResult(`${JSON.stringify({ ok: true, ...payload })}\n`);
    }
}
function emitFail(command, error, hint) {
    if (emitted) {
        return;
    }
    emitted = true;
    const result = { ok: false, command, error };
    if (hint) {
        result.hint = hint;
    }
    writeResult(`${JSON.stringify(result)}\n`);
}
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            args.help = 'true';
        }
        else if (arg === '--dry-run') {
            args['dry-run'] = 'true';
        }
        else if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--') || value === '-h') {
                args[key] = undefined;
                const missing = (args._missing ??= []);
                missing.push(key);
            }
            else {
                args[key] = value;
                i += 1;
            }
        }
        else {
            args._.push(arg);
        }
    }
    return args;
}
function arg(args, key) { return typeof args[key] === 'string' ? args[key] : undefined; }
/**
 * Reject flags the command does not read, so a typo fails at the flag instead of
 * at the argument it silently swallowed (issue #4788, step 1 of the repro chain).
 * Returns true when the caller should stop; the failure is already emitted.
 */
function rejectUnknownFlags(command, args) {
    const allowed = new Set([...COMMON_FLAGS, ...(COMMAND_FLAGS[command] ?? [])]);
    const unknown = Object.keys(args).filter((key) => !['_', '_missing', 'help'].includes(key) && !allowed.has(key));
    if (unknown.length === 0) {
        return false;
    }
    const listed = unknown.map((key) => `--${key}`).join(', ');
    const valid = [...allowed].sort().map((key) => `--${key}`).join(', ');
    emitFail(command, `Unknown option${unknown.length > 1 ? 's' : ''}: ${listed}`, `${command} accepts: ${valid}`);
    return true;
}
function readStdin() {
    if (process.stdin.isTTY) {
        return undefined;
    }
    try {
        return readFileSync(0, 'utf8');
    }
    catch {
        return undefined;
    }
}
function readInput(args, valueKey, fileKey, defaultStdin = true) {
    const value = arg(args, valueKey);
    if (value !== undefined) {
        return value;
    }
    const file = arg(args, fileKey);
    if (file !== undefined) {
        try {
            return file === '-' ? readStdin() : readFileSync(file, 'utf8');
        }
        catch (error) {
            throw new Error(`Cannot read --${fileKey} ${file}: ${errorMessage(error)}`);
        }
    }
    return defaultStdin ? readStdin() : undefined;
}
function validateInputSources(command, args) {
    const pairs = {
        send_text: [['text', 'text-file', true]], send_card: [['card', 'card-file', true]],
        push_to_agent: [['message', 'message-file', true]], request_private_input: [['workflow', 'workflow-file', true]],
        send_interactive: [['question', 'question-file', true], ['options', 'options-file', false],
            ['action-prompts', 'action-prompts-file', false]],
    };
    const stdin = [];
    for (const [valueKey, fileKey, fallback] of pairs[command] ?? []) {
        const value = arg(args, valueKey);
        const file = arg(args, fileKey);
        if (value !== undefined && file !== undefined) {
            throw new Error(`Use only one of --${valueKey} and --${fileKey}`);
        }
        if (file === '-' || (value === undefined && file === undefined && fallback)) {
            stdin.push(valueKey);
        }
    }
    if (stdin.length > 1) {
        throw new Error(`stdin can supply only one input, requested by: ${stdin.join(', ')}. Supply the other inputs explicitly or through files.`);
    }
}
function resolveChat(args) {
    const explicit = arg(args, 'chat');
    if (explicit !== undefined) {
        return explicit;
    }
    if (process.env.FEISHU_CLI_CHAT_ID) {
        return process.env.FEISHU_CLI_CHAT_ID;
    }
    const configPath = process.env.DISCLAUDE_CONFIG_PATH || [
        join(homedir(), '.disclaude', 'disclaude.config.yaml'),
        join(homedir(), '.disclaude', 'disclaude.config.yml'),
        // Legacy migration fallback.
        'disclaude.config.yaml',
        'disclaude.config.yml',
    ].find(existsSync);
    if (!configPath) {
        return undefined;
    }
    try {
        const text = readFileSync(configPath, 'utf8');
        return text.match(/^\s*cliChatId:\s*["']?([^"'\s#]+)["']?\s*$/m)?.[1];
    }
    catch {
        return undefined;
    }
}
function validateChat(command, args) {
    const id = resolveChat(args);
    if (!id) {
        emitFail(command, 'Missing required option --chat <id>', 'pass --chat oc_xxx');
        return undefined;
    }
    const validationError = getChatIdValidationError(id);
    if (validationError) {
        emitFail(command, `Invalid chatId: ${validationError}`);
        return undefined;
    }
    return id;
}
function parseJson(raw, name) {
    if (!raw) {
        return undefined;
    }
    try {
        return JSON.parse(raw.replace(/^\uFEFF/, ''));
    }
    catch (error) {
        throw new Error(`Invalid --${name} JSON (${raw.length} UTF-16 units, ${Buffer.byteLength(raw, 'utf8')} UTF-8 bytes): ${errorMessage(error)}`);
    }
}
function parseMentions(raw) {
    const value = parseJson(raw, 'mentions');
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || typeof item.openId !== 'string')) {
        throw new Error('Invalid --mentions JSON: mentions must be an array of objects with an `openId` string');
    }
    return value;
}
function parseOptions(raw) {
    if (!raw) {
        throw new Error('Missing required option --options <json-array>');
    }
    const value = parseJson(raw, 'options');
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('options must be a non-empty array');
    }
    for (const [index, item] of value.entries()) {
        const option = item;
        if (!option || typeof option.text !== 'string' || !option.text.trim()) {
            throw new Error(`options[${index}].text must be a non-empty string`);
        }
        if (typeof option.value !== 'string' || !option.value.trim()) {
            throw new Error(`options[${index}].value must be a non-empty string`);
        }
        if (option.type !== undefined && !['primary', 'default', 'danger'].includes(option.type)) {
            throw new Error(`options[${index}].type must be one of: primary, default, danger`);
        }
    }
    return value;
}
function parseActionPrompts(raw) {
    const value = parseJson(raw, 'action-prompts');
    if (value === undefined) {
        return undefined;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((item) => typeof item !== 'string' || !item)) {
        throw new Error('action-prompts must be a JSON object mapping option value -> prompt string');
    }
    return value;
}
function setupRest(args) {
    const configured = arg(args, 'base-url') ?? process.env.DISCLAUDE_API_BASE_URL;
    const baseUrl = normalizeChannelApiBaseUrl(configured ?? '');
    process.env.DISCLAUDE_API_BASE_URL = baseUrl;
    // Issue #4801: mirror the DisclaudeService --api-token into the env the REST
    // client reads, so authenticated writes attach the bearer header. Without
    // this, a token-enabled service 401s every channel POST while the probe
    // still reports "available".
    const apiToken = arg(args, 'api-token');
    if (apiToken !== undefined) {
        process.env.DISCLAUDE_API_TOKEN = apiToken;
    }
    return baseUrl;
}
function withLogsRedirected(fn) {
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback));
    return fn().finally(() => { process.stdout.write = originalWrite; });
}
function restHint(baseUrl) { return `DisclaudeService REST ${baseUrl} unreachable — start the main service (disclaude start --api-port <port>) or pass --base-url / DISCLAUDE_API_BASE_URL`; }
async function restIsReachable(baseUrl) {
    try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ping`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
        });
        return response.ok;
    }
    catch {
        return false;
    }
}
async function failureHint(baseUrl, error) {
    if (/CHANNEL_API_REQUEST_FAILED/.test(error)) {
        return undefined;
    }
    if (/CHANNEL_API_TIMEOUT/.test(error)) {
        return 'DisclaudeService REST request timed out; verify delivery before retrying.';
    }
    if (/CHANNEL_API_NOT_AVAILABLE|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(error)) {
        return restHint(baseUrl);
    }
    return await restIsReachable(baseUrl) ? undefined : restHint(baseUrl);
}
async function execute(command, args, chatId, baseUrl) {
    // Parse all user-provided structured input before loading the runtime package.
    // This keeps malformed CLI input deterministic and avoids logger teardown
    // noise on fast-failure paths.
    let text;
    let message;
    let question;
    let filePath;
    let card;
    let workflow;
    let parsedMentions;
    let parsedOptions;
    let parsedActionPrompts;
    try {
        validateInputSources(command, args);
        if (command === 'send_text') {
            text = readInput(args, 'text', 'text-file');
            parsedMentions = parseMentions(arg(args, 'mentions'));
            if (!text) {
                emitFail(command, 'Missing text content', 'pass --text <string>, --text-file <path>, or pipe content on stdin');
                return 1;
            }
        }
        else if (command === 'send_file') {
            filePath = arg(args, 'file');
            if (!filePath) {
                emitFail(command, 'Missing required option --file <path>', 'pass --file <path>');
                return 1;
            }
        }
        else if (command === 'send_card') {
            const raw = readInput(args, 'card', 'card-file');
            if (!raw) {
                emitFail(command, 'Missing card content', 'pass --card <json>, --card-file <path>, or pipe card JSON on stdin');
                return 1;
            }
            card = parseJson(raw, 'card');
            if (!card || Array.isArray(card) || typeof card !== 'object') {
                emitFail(command, 'Card must be an object');
                return 1;
            }
        }
        else if (command === 'request_private_input') {
            if (!arg(args, 'actor')?.trim() || !arg(args, 'source')?.trim()) {
                emitFail(command, 'Missing --actor <open-id> or --source <message-id>');
                return 1;
            }
            const raw = readInput(args, 'workflow', 'workflow-file');
            if (!raw) {
                emitFail(command, 'Missing workflow definition', 'pass --workflow-file <path>, --workflow <json>, or pipe workflow JSON on stdin');
                return 1;
            }
            workflow = parseJson(raw, 'workflow');
            if (!workflow || Array.isArray(workflow) || typeof workflow !== 'object' ||
                ['command', 'title', 'description'].some(key => typeof workflow?.[key] !== 'string' || !(workflow?.[key]).trim())) {
                emitFail(command, 'Workflow must be an object with command, title and description');
                return 1;
            }
        }
        else if (command === 'push_to_agent') {
            message = readInput(args, 'message', 'message-file');
            if (!message) {
                emitFail(command, 'Missing message content', 'pass --message <string>, --message-file <path>, or pipe content on stdin');
                return 1;
            }
        }
        else {
            question = readInput(args, 'question', 'question-file');
            if (!question || !question.trim()) {
                emitFail(command, 'Missing question content', 'pass --question <string>, --question-file <path>, or pipe content on stdin');
                return 1;
            }
            parsedOptions = parseOptions(readInput(args, 'options', 'options-file', false));
            parsedActionPrompts = parseActionPrompts(readInput(args, 'action-prompts', 'action-prompts-file', false));
            const values = parsedOptions.map(option => option.value);
            if (new Set(values).size !== values.length) {
                throw new Error('options[].value must be unique for unambiguous action routing');
            }
            const prompts = parsedActionPrompts;
            if (prompts && values.some(value => !Object.hasOwn(prompts, value) || !prompts[value].trim())) {
                throw new Error('action-prompts must map every option value to a non-empty prompt');
            }
            assertReadableInteractiveText(parsedOptions, parsedActionPrompts);
        }
    }
    catch (error) {
        const messageText = errorMessage(error);
        emitFail(command, command === 'send_card' && messageText.startsWith('Invalid --card JSON') ? messageText.replace('Invalid --card JSON', 'Invalid card JSON') : messageText);
        return 1;
    }
    const idempotencyKey = arg(args, 'idempotency-key');
    if (idempotencyKey !== undefined && !idempotencyKey.trim()) {
        emitFail(command, '--idempotency-key must be a non-empty key');
        return 1;
    }
    if (idempotencyKey !== undefined && (!parsedActionPrompts || Object.keys(parsedActionPrompts).length === 0)) {
        emitFail(command, '--idempotency-key requires --action-prompts for safe button routing');
        return 1;
    }
    const parentMessageId = arg(args, 'parent');
    const threadRootId = arg(args, 'thread-root');
    if ([parentMessageId, threadRootId].some(id => id && isSyntheticMessageId(id))) {
        emitFail(command, 'Reply IDs must be real platform message IDs. Internal tracking IDs cannot be used with --parent or --thread-root; omit them when no reply root exists.');
        return 1;
    }
    if (threadRootId !== undefined && !threadRootId.trim()) {
        emitFail(command, '--thread-root must be a non-empty thread root ID');
        return 1;
    }
    const decodedPreview = command === 'send_interactive' ? {
        options: parsedOptions?.map(option => ({ value: option.value, text: option.text.slice(0, 80), truncated: option.text.length > 80 })),
        actionPrompts: parsedActionPrompts && Object.fromEntries(Object.entries(parsedActionPrompts).map(([value, prompt]) => [value, { text: prompt.slice(0, 120), truncated: prompt.length > 120 }])),
    } : undefined;
    if (arg(args, 'dry-run') === 'true') {
        try {
            if (card && !isValidFeishuCard(card)) {
                throw new Error(getCardValidationError(card));
            }
            if (filePath) {
                if (!statSync(filePath).isFile()) {
                    throw new Error('--file must refer to a regular file');
                }
                accessSync(filePath, constants.R_OK);
            }
        }
        catch (error) {
            emitFail(command, errorMessage(error));
            return 1;
        }
        const common = { chatId, parentMessageId };
        const payload = command === 'send_text' ? { ...common, text, mentions: parsedMentions }
            : command === 'send_file' ? { ...common, filePath }
                : command === 'send_card' ? { ...common, card }
                    : command === 'push_to_agent' ? { chatId, message }
                        : command === 'request_private_input' ? { chatId, actorId: arg(args, 'actor'), sourceMessageId: arg(args, 'source'), workflow }
                            : { ...common, question, options: parsedOptions, actionPrompts: parsedActionPrompts, title: arg(args, 'title'),
                                context: arg(args, 'context'), threadRootId, idempotencyKey };
        emitOk({ command, chatId, dryRun: true, validation: 'local-input', payload, ...(decodedPreview ? { decodedPreview } : {}) });
        return 0;
    }
    let mod;
    try {
        mod = await withLogsRedirected(() => import('./index.js'));
    }
    catch (error) {
        emitFail(command, `Failed to load channel implementation: ${errorMessage(error)}`, 'run pnpm run build before using the packaged CLI');
        return 1;
    }
    let result;
    try {
        if (command === 'send_text') {
            result = await withLogsRedirected(() => mod.send_text({ text: text, chatId, parentMessageId, mentions: parsedMentions }));
        }
        else if (command === 'send_file') {
            result = await withLogsRedirected(() => mod.send_file({ filePath: filePath, chatId, parentMessageId }));
        }
        else if (command === 'send_card') {
            const transformed = mod.transformCardTables(card);
            const resolved = await mod.resolveCardImages(transformed);
            result = await withLogsRedirected(() => mod.send_card({ card: resolved.card, chatId, parentMessageId }));
        }
        else if (command === 'request_private_input') {
            result = await withLogsRedirected(() => mod.request_private_input({ chatId, actorId: arg(args, 'actor'),
                sourceMessageId: arg(args, 'source'), workflow: workflow }));
        }
        else if (command === 'push_to_agent') {
            result = await withLogsRedirected(() => mod.push_to_agent({ chatId, message: message }));
        }
        else {
            result = await withLogsRedirected(() => mod.send_interactive({ question: question, options: parsedOptions, title: arg(args, 'title'), context: arg(args, 'context'), actionPrompts: parsedActionPrompts, chatId, parentMessageId, threadRootId, idempotencyKey }));
        }
    }
    catch (error) {
        const errorText = `${command} failed: ${errorMessage(error)}`;
        emitFail(command, errorText, await failureHint(baseUrl, errorText));
        return 1;
    }
    if (result.success) {
        emitOk({ command, chatId, result: result.message || 'sent', durationMs: 0, ...(result.actionId ? { actionId: result.actionId } : {}), ...(decodedPreview ? { decodedPreview } : {}) });
        return 0;
    }
    const resultError = result.error || result.message || `${command} returned without success`;
    emitFail(command, resultError, await failureHint(baseUrl, resultError));
    return 1;
}
export async function run(argv) {
    await Promise.resolve();
    emitted = false;
    const [invokedAs] = argv;
    if (!invokedAs || invokedAs === 'help' || invokedAs === '--help' || invokedAs === '-h') {
        writeResult(`${HELP}\n`);
        return 0;
    }
    // `push` is the agent-facing spelling; `push_to_agent` stays as the canonical
    // command name so the stdout JSON contract (`command` field) is unchanged.
    const command = invokedAs === 'push' ? 'push_to_agent' : invokedAs;
    if (argv.slice(1).some(value => value === '--help' || value === '-h')) {
        const help = getChannelCliCommandHelp(command);
        if (help) {
            writeResult(`${help}\n`);
            return 0;
        }
    }
    const args = parseArgs(argv.slice(1));
    // Derived from COMMAND_FLAGS so a new command cannot be routable yet have no
    // flag whitelist (which would reject every one of its own options).
    const commands = Object.keys(COMMAND_FLAGS);
    if (!commands.includes(command)) {
        process.stderr.write(`Unknown command: ${invokedAs}\n`);
        writeResult(`${HELP}\n`);
        return 1;
    }
    // Before chat validation: a mistyped `--chat` shows up as an unknown flag, and
    // naming it beats the generic "Missing required option --chat" it would cause.
    if (rejectUnknownFlags(command, args)) {
        return 1;
    }
    if (Array.isArray(args._missing) && args._missing.length) {
        emitFail(command, `Missing value for ${args._missing.map(name => `--${name}`).join(', ')}`, `run disclaude channel ${invokedAs} --help`);
        return 1;
    }
    const chat = validateChat(command, args);
    if (!chat) {
        return 1;
    }
    let baseUrl;
    try {
        if (arg(args, 'dry-run') === 'true') {
            const explicit = arg(args, 'base-url');
            if (explicit !== undefined) {
                normalizeChannelApiBaseUrl(explicit);
            }
            baseUrl = '';
        }
        else {
            baseUrl = setupRest(args);
        }
    }
    catch (error) {
        emitFail(command, errorMessage(error));
        return 1;
    }
    return execute(command, args, chat, baseUrl);
}
// Only auto-run when executed as a script (the `disclaude channel` router spawns
// this dist file directly, so argv[1] always ends with "/cli.js"). Issue #4794's
// `includes('disclaude-channel')` clause is gone with the bin it guarded: a
// substring match would also fire when a *test* imports this module from a repo
// checkout whose path happens to contain "disclaude".
if (process.argv[1]?.endsWith('/cli.js')) {
    autoRunOutput = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback));
    run(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`channel CLI crashed: ${errorMessage(error)}\n`); emitFail('channel', `CLI crashed: ${errorMessage(error)}`); process.exitCode = 1; });
}
