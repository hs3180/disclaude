/**
 * mini-swe-agent Provider (Issue #5006, parent of the optional-provider gap).
 *
 * Bridges disclaude's unified agent stream onto the open-source mini-swe-agent
 * headless CLI (LiteLLM / OpenAI-compatible model backends), following the
 * codex exec bridge architecture (#4630): one user input → one `mini` subprocess
 * whose stdout narration is adapted onto the unified AgentMessage stream, with
 * a queue+wake consumer loop, a detached input pump, an early-cancel latch and
 * the shared no-progress stall watchdog seam (liveness-probing, #4550 pattern).
 *
 * Scope and unknowns (kept honest):
 * - Execution environment policy is explicit and local-only: the child runs in
 *   the disclaude-managed workspace cwd (`options.cwd`) and its per-run
 *   trajectory file lives in a private temp dir that is removed on teardown.
 *   mini's docker / singularity / SWE-ReX environment classes are OUT OF
 *   SCOPE for this adapter (config rejects them with that message).
 * - The CLI has no session-resume flag, so multi-turn chats replay a bounded
 *   transcript of prior final answers as prompt context; every turn is a
 *   fresh native run.
 * - Credentials never appear in argv, YAML literals or provider state: the
 *   bound `llms.<name>.api` reference is resolved by the host and reaches the
 *   child only through the managed environment (OPENAI_/ANTHROPIC_ key+base
 *   URL projection in buildSdkEnv). Emitted chat/log text is additionally
 *   scrubbed against the registered secret values.
 * - No real mini-swe-agent runtime exists on this host; argv/trajectory
 *   fidelity is UNVERIFIED (unknown) and tested only against fake executables.
 */
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../../../utils/logger.js';
import { knownSecretValues } from '../../../config/channel-credentials.js';
import { sanitizeDiagnosticText } from '../../../utils/diagnostic-text.js';
import { assertToolOptions } from '../../tools.js';
import { readStallPolicy } from '../stall-policy.js';
import { MiniSweRunner } from './runner.js';
const logger = createLogger('MiniSweAgentProvider');
/** Default executable; the `mini-swe-agent` alias is probed as a fallback. */
export const MINI_DEFAULT_BINARY = 'mini';
const MINI_ALIAS_BINARY = 'mini-swe-agent';
/** Default per-run wall-clock timeout. Zero disables (stall watchdog still applies). */
export const MINI_DEFAULT_TIMEOUT_MS = 0;
/** Bounded per-line progress content forwarded to the channel/debug group. */
const MAX_PROGRESS_LINE_CHARS = 2_000;
/** Bounded final-answer fallback when the trajectory yields no message. */
const MAX_FINAL_FALLBACK_CHARS = 4_000;
/** Conversation replay budget: mini has no native resume, so prior final
 * answers are replayed as prompt context (bounded to keep argv sane). */
const MAX_TRANSCRIPT_TURNS = 6;
const MAX_TRANSCRIPT_CHARS = 16_000;
/** Actionable binary-missing error (thrown synchronously by queryStream). */
const BINARY_MISSING = (names, pathValue) => `MiniSweAgentProvider: mini-swe-agent executable not found (looked for ${names.map(name => `"${name}"`).join(', ')} on PATH "${pathValue}") — ` +
    'install it first: `pipx install mini-swe-agent` (or `pip install mini-swe-agent`; the `mini` command must be on PATH), ' +
    'or set agents.<name>.miniswe.binary to an absolute path. Real mini-swe-agent execution is unverified in this deployment.';
/** Ask-mode cannot be honored: the local environment executes without an approver. */
const ASK_MODE_UNSUPPORTED = 'MiniSweAgentProvider: permissionMode "default" (ask) cannot be honored headlessly — the mini local environment executes commands without an approval axis. ' +
    'Use permissionMode: bypassPermissions (the bot default) or a different backend.';
export class MiniSweAgentProvider {
    name = 'miniswe';
    version = '0.6.0-miniswe-adapter';
    env;
    binarySetting;
    executionEnvironment;
    defaultTimeoutMs;
    disposed = false;
    /** Anonymous-stream key counter (queryStream without options.sessionKey). */
    anonSessionCounter = 0;
    constructor(options = {}) {
        this.env = options.env ?? process.env;
        this.binarySetting = options.binary;
        this.executionEnvironment = options.executionEnvironment ?? 'local';
        this.defaultTimeoutMs = options.timeoutMs ?? MINI_DEFAULT_TIMEOUT_MS;
    }
    // --------------------------------------------------------------------------
    // Provider information
    // --------------------------------------------------------------------------
    getInfo(target) {
        if (this.disposed) {
            return {
                name: this.name,
                version: this.version,
                available: false,
                unavailableReason: 'Provider has been disposed',
            };
        }
        const problems = [];
        if (!this.findMiniBinary()) {
            problems.push('mini-swe-agent executable not found — install it first: `pipx install mini-swe-agent` (the `mini` command must be on PATH), or set agents.<name>.miniswe.binary');
        }
        if (target && !target.apiKey?.trim()) {
            // The bound llms.<name>.api credential reference resolves empty; the
            // generic preflight reports the field path, this keeps the hint local.
            problems.push('check the selected LLM API credential (llms.<name>.api.apiKey reference) and endpoint');
        }
        const info = {
            name: this.name,
            version: this.version,
            available: problems.length === 0,
        };
        if (problems.length > 0) {
            info.unavailableReason = problems.join('; ');
        }
        return info;
    }
    /** Binary present (never throws) — actionable detail lives in getInfo(). */
    validateConfig() {
        if (this.disposed) {
            return false;
        }
        return this.findMiniBinary() !== undefined;
    }
    dispose() {
        this.disposed = true;
    }
    // --------------------------------------------------------------------------
    // Query — one headless `mini` run per user input
    // --------------------------------------------------------------------------
    queryStream(input, options) {
        assertToolOptions(options);
        if (this.disposed) {
            throw new Error('Provider has been disposed');
        }
        // Fail fast with an actionable message (codex BINARY_MISSING contract):
        // the environment problem is knowable at call time, so it must not
        // surface as a cryptic mid-stream ENOENT.
        const binary = this.findMiniBinary();
        if (!binary) {
            throw new Error(BINARY_MISSING(this.binaryCandidates(), this.env.PATH ?? ''));
        }
        if (this.executionEnvironment !== 'local') {
            throw new Error(`MiniSweAgentProvider: execution environment "${this.executionEnvironment}" is out of scope for this adapter — only 'local' subprocess execution is implemented (docker/SWE-ReX remain native mini-swe-agent workflows).`);
        }
        // Permission gate (fail closed, codex #4631 contract): mini's local
        // environment executes commands with no approval axis, so ask-mode cannot
        // degrade safely — refuse instead of silently widening.
        if (options.permissionMode === 'default') {
            throw new Error(ASK_MODE_UNSUPPORTED);
        }
        if (options.permissionMode !== undefined && options.permissionMode !== 'bypassPermissions') {
            throw new Error(`MiniSweAgentProvider: unknown permissionMode "${String(options.permissionMode)}" — refusing to start a run (fail closed).`);
        }
        if (options.tools?.length) {
            throw new Error('MiniSweAgentProvider: host tools are unsupported; the mini subprocess CLI cannot dispatch host tool definitions.');
        }
        const queryModel = options.model?.trim() || undefined;
        logger.info({
            model: queryModel ?? 'mini-config-default',
            modelSource: options.model?.trim() ? 'AgentQueryOptions.model' : 'mini MSWEA_MODEL_NAME default',
            executionEnvironment: this.executionEnvironment,
        }, 'resolved mini-swe-agent run settings');
        const runner = new MiniSweRunner({ binary, timeoutMs: this.defaultTimeoutMs });
        const providerEnv = this.env;
        // Captured at queryStream call time — the effective runner timeout the
        // closures below report in the timeout error message.
        const { defaultTimeoutMs } = this;
        const sessionKey = options.sessionKey ?? `anon-mini-${++this.anonSessionCounter}`;
        const { timeoutMs: STALL_TIMEOUT_MS, graceMs: STALL_FORCE_CLOSE_GRACE_MS } = readStallPolicy({
            ...process.env, ...providerEnv, ...options.env,
        });
        // Abort plumbing (codex parity: early-cancel latch + late onAbort wake).
        let currentRun = null;
        let cancelRequested = false;
        let onAbort = null;
        const requestAbort = () => {
            if (currentRun) {
                currentRun.abort();
            }
            else {
                cancelRequested = true;
            }
            onAbort?.();
        };
        // Conversation replay state: the CLI has no resume, so prior final
        // answers are replayed as bounded prompt context. Closure-scoped — the
        // stream ending (/reset, idle GC) drops it for free, like codex's
        // chatId→thread map.
        const transcript = [];
        const adaptIterator = async function* () {
            // Per-stream trajectory dir: never touch mini's shared default
            // `last_mini_run.traj.json`; removed on teardown so transcripts (which
            // may contain echoed secrets) never persist.
            const runDir = mkdtempSync(join(tmpdir(), 'disclaude-miniswe-'));
            let turnCounter = 0;
            const queue = [];
            const notify = [];
            let inputDone = false;
            let runActive = false;
            let aborted = false;
            let terminated = false;
            const wakeAll = () => {
                for (const wake of notify.splice(0)) {
                    wake();
                }
            };
            // ── Stall watchdog (codex #4630 pattern reusing the #4550 seam) ────
            // Silence schedules an owned-process probe, never an unconditional
            // kill: a live mini child waiting on a long model call survives; a
            // confirmed stopped/exited child receives one terminal failure with the
            // original input correlation.
            let stalled = false;
            let stallDetail;
            let stallWatchdog = null;
            let stallForceCloseTimer = null;
            let lastEventAt = Date.now();
            let lastEventType = 'run.started';
            let eventRevision = 0;
            let activeCorrelation;
            let probingRun;
            const armTimer = (fn, ms) => {
                const t = setTimeout(fn, ms);
                t.unref?.();
                return t;
            };
            const clearStallTimers = () => {
                if (stallWatchdog) {
                    clearTimeout(stallWatchdog);
                    stallWatchdog = null;
                }
                if (stallForceCloseTimer) {
                    clearTimeout(stallForceCloseTimer);
                    stallForceCloseTimer = null;
                }
            };
            const fireStallWatchdog = async () => {
                stallWatchdog = null;
                const inspectedRun = currentRun;
                if (!runActive || stalled || aborted || !inspectedRun) {
                    return;
                }
                if (probingRun === inspectedRun) {
                    stallWatchdog = armTimer(() => { void fireStallWatchdog(); }, STALL_TIMEOUT_MS);
                    return;
                }
                const observedRevision = eventRevision;
                probingRun = inspectedRun;
                const liveness = await inspectedRun.inspectLiveness();
                if (probingRun === inspectedRun) {
                    probingRun = undefined;
                }
                if (currentRun !== inspectedRun || !runActive || stalled || aborted
                    || eventRevision !== observedRevision) {
                    return;
                }
                const evidence = {
                    sessionKey, ...activeCorrelation,
                    lastEventAt, lastEventType, quietMs: Date.now() - lastEventAt,
                    stallTimeoutMs: STALL_TIMEOUT_MS,
                    childPid: liveness.pid, liveness: liveness.state,
                };
                if (liveness.state === 'alive' || liveness.state === 'unknown') {
                    // A live process can be waiting on a model or tool call; a failed ps
                    // observation is not evidence of death either.
                    logger.info(evidence, 'mini quiet; liveness does not justify termination');
                    stallWatchdog = armTimer(() => { void fireStallWatchdog(); }, STALL_TIMEOUT_MS);
                    return;
                }
                stalled = true;
                stallDetail = `mini process is ${liveness.state}; ${JSON.stringify(evidence)}`;
                logger.error(evidence, 'mini liveness failure; terminating the owned run');
                inspectedRun.abort();
                stallForceCloseTimer = armTimer(() => {
                    stallForceCloseTimer = null;
                    onAbort?.();
                }, STALL_FORCE_CLOSE_GRACE_MS);
            };
            const touchStallWatchdog = () => {
                if (!runActive || stalled) {
                    return;
                }
                clearStallTimers();
                stallWatchdog = armTimer(() => { void fireStallWatchdog(); }, STALL_TIMEOUT_MS);
            };
            /** Push a bridge-synthesized message (post-run failure mapping). */
            const pushSynthetic = (message) => {
                if (stalled) {
                    return;
                }
                queue.push(message);
                wakeAll();
            };
            const observeEvent = (type) => {
                try {
                    options.onActivity?.(`miniswe:${type}`);
                }
                catch {
                    logger.debug({ sessionKey, eventType: type }, 'Host activity observer failed');
                }
                lastEventAt = Date.now();
                lastEventType = type;
                eventRevision++;
                touchStallWatchdog();
            };
            onAbort = () => {
                aborted = true;
                wakeAll();
            };
            // ── Turn runner: one user input → one mini run ─────────────────────
            const runInput = async (prompt, correlation, continuationContext) => {
                if (stalled || aborted || terminated) {
                    return;
                }
                const replay = transcript.length
                    ? `Previous conversation turns (mini-swe-agent has no native session resume; final answers replayed as context, oldest first):\n${transcript.join('\n---\n')}\n\n`
                    : '';
                const contextualPrompt = `${continuationContext ? `${continuationContext}\n` : ''}${replay}User request:\n${prompt}`;
                turnCounter += 1;
                const trajectoryPath = join(runDir, `turn-${turnCounter}.traj.json`);
                runActive = true;
                activeCorrelation = correlation;
                lastEventAt = Date.now();
                lastEventType = 'run.started';
                eventRevision++;
                touchStallWatchdog();
                let stdoutLines = 0;
                let trajectoryParsed = false;
                let finalText = '';
                const { promise, handle } = runner.run({
                    prompt: contextualPrompt,
                    correlation,
                    cwd: options.cwd,
                    model: queryModel,
                    trajectoryPath,
                    env: buildMiniChildEnv(providerEnv, options.env),
                    stderr: (chunk) => {
                        observeEvent('stderr');
                        options.stderr?.(chunk);
                    },
                }, (line) => {
                    stdoutLines += 1;
                    observeEvent('stdout');
                    // Progress lines are host-observable, never ordinary chat: the
                    // transientStatus marker keeps them out of the user chat (debug
                    // group + logs still see them, sanitized).
                    pushSynthetic({
                        type: 'status',
                        role: 'system',
                        content: redactSecretValues(line).slice(0, MAX_PROGRESS_LINE_CHARS),
                        metadata: { transientStatus: true },
                    });
                });
                currentRun = handle;
                if (cancelRequested) {
                    // cancel()/close() arrived before this run started (early latch).
                    handle.abort();
                }
                try {
                    const result = await promise;
                    if (stalled || result.aborted) {
                        logger.info({ sessionKey, ...correlation, exitCode: result.exitCode, durationMs: result.durationMs }, 'mini run aborted; late events suppressed');
                        return;
                    }
                    const runFailed = Boolean(result.spawnError) || result.timedOut || result.exitCode !== 0;
                    if (result.exitCode === 0 && !result.timedOut) {
                        const fromTrajectory = readFinalAssistantMessage(trajectoryPath);
                        if (fromTrajectory !== undefined) {
                            trajectoryParsed = true;
                            finalText = redactSecretValues(fromTrajectory);
                        }
                        else if (result.stdoutTail.trim()) {
                            finalText = redactSecretValues(result.stdoutTail.trim().slice(-MAX_FINAL_FALLBACK_CHARS));
                        }
                    }
                    logger.info({
                        sessionKey, ...correlation,
                        exitCode: result.exitCode,
                        timedOut: result.timedOut,
                        durationMs: result.durationMs,
                        stdoutLines,
                        trajectoryParsed,
                        finalAnswerChars: finalText.length,
                    }, 'mini run finished');
                    if (result.spawnError) {
                        pushSynthetic({
                            type: 'error',
                            content: `mini failed to spawn (${sanitizeDiagnosticText(result.spawnError.message)}). ` +
                                'Is mini-swe-agent installed and on PATH?',
                            role: 'assistant',
                        });
                    }
                    else if (result.timedOut) {
                        pushSynthetic({
                            type: 'error',
                            content: `mini run was terminated by the runner timeout policy (${defaultTimeoutMs}ms; configure agents.<name>.miniswe.timeoutMs).`,
                            role: 'assistant',
                        });
                    }
                    else if (result.exitCode !== 0) {
                        const detail = sanitizeDiagnosticText(result.stderrTail.trim().slice(-500));
                        pushSynthetic({
                            type: 'error',
                            content: `mini exited with code ${result.exitCode}${detail ? `: ${detail}` : ''}` +
                                `${isAuthFailureText(result.stderrTail)
                                    ? ' — the model backend rejected the credential; check llms.<name>.api.apiKey (external reference) and baseUrl for the bound LLM.'
                                    : ''}`,
                            role: 'assistant',
                        });
                    }
                    else if (finalText) {
                        pushSynthetic({ type: 'text', role: 'assistant', content: finalText });
                    }
                    if (finalText) {
                        transcript.push(finalText.slice(0, MAX_TRANSCRIPT_CHARS));
                        while (transcript.length > MAX_TRANSCRIPT_TURNS || joinLength(transcript) > MAX_TRANSCRIPT_CHARS) {
                            transcript.shift();
                        }
                    }
                    // Every finished attempt ends the TURN so ChatAgent's accounting
                    // completes (codex #4630 review parity): failures carry
                    // terminatedReason 'turn_failed' so the run is recorded as a
                    // failure, never a masked success.
                    if (runFailed) {
                        pushSynthetic({
                            type: 'result',
                            content: '',
                            role: 'assistant',
                            metadata: {
                                terminatedReason: 'turn_failed',
                                terminationDetail: `mini run: exit=${String(result.exitCode)} timedOut=${String(result.timedOut)}${result.spawnError ? ` spawnError=${result.spawnError.message}` : ''}`,
                            },
                        });
                    }
                    else {
                        pushSynthetic({ type: 'result', content: '', role: 'assistant' });
                    }
                    return;
                }
                finally {
                    currentRun = null;
                    runActive = false;
                    clearStallTimers();
                    wakeAll();
                }
            };
            // Early-cancel window (codex S2 review parity): handle.cancel()/close()
            // called between queryStream() returning and the first next() sees
            // onAbort === null — without this check the consumer would park forever.
            if (cancelRequested) {
                aborted = true;
                rmSync(runDir, { recursive: true, force: true });
                return;
            }
            // ── Input pump: user inputs arrive over the session lifetime ──────
            const inputIterator = input[Symbol.asyncIterator]();
            void (async () => {
                try {
                    while (true) {
                        const { value, done } = await inputIterator.next();
                        if (done || terminated) {
                            return;
                        }
                        await runInput(userInputText(value), value.correlation, value.continuationContext);
                        if (stalled || aborted) {
                            return;
                        }
                    }
                }
                finally {
                    inputDone = true;
                    wakeAll();
                }
            })().catch(() => {
                // Producer error in the input generator — end the session the same
                // way; never surface an unhandled rejection from the detached pump.
            });
            try {
                while (true) {
                    if (stalled && (aborted || !runActive)) {
                        break;
                    }
                    if (queue.length === 0) {
                        if (aborted || (inputDone && !runActive)) {
                            break;
                        }
                        await new Promise((resolve) => notify.push(resolve));
                        continue;
                    }
                    const message = queue.shift();
                    // Post-stall output from the dying process must not reach the
                    // consumer ahead of the stall terminator (pi part-5 review).
                    if (stalled) {
                        continue;
                    }
                    yield message;
                }
                if (stalled) {
                    yield {
                        type: 'result',
                        content: '⚠️ mini 进程已停止或退出，本轮已中断。请先检查已有结果，再发送消息继续。',
                        role: 'system',
                        metadata: { terminatedReason: 'stall', terminationDetail: stallDetail },
                    };
                    return;
                }
            }
            finally {
                // Teardown: kill any in-flight run; later inputs become no-ops; the
                // private trajectory dir (possible echoed secrets) never persists.
                terminated = true;
                currentRun?.abort();
                clearStallTimers();
                rmSync(runDir, { recursive: true, force: true });
            }
        };
        return {
            handle: {
                close: () => {
                    requestAbort();
                },
                cancel: () => {
                    requestAbort();
                },
                sessionId: undefined,
            },
            iterator: adaptIterator(),
        };
    }
    // --------------------------------------------------------------------------
    // Internals
    // --------------------------------------------------------------------------
    binaryCandidates() {
        const name = (this.binarySetting ?? MINI_DEFAULT_BINARY).trim();
        const withExt = process.platform === 'win32' && !/\.[^.]+$/.test(name) ? `${name}.exe` : name;
        // An explicit path (or any name with a separator) is taken as-is; only
        // the default name additionally probes the packaged `mini-swe-agent`
        // alias so a default-config install is found either way.
        if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
            return [withExt];
        }
        return withExt === MINI_DEFAULT_BINARY || withExt === `${MINI_DEFAULT_BINARY}.exe`
            ? [withExt, process.platform === 'win32' ? `${MINI_ALIAS_BINARY}.exe` : MINI_ALIAS_BINARY]
            : [withExt];
    }
    /**
     * Resolve the mini executable. An explicit path is checked directly; a bare
     * name is scanned on PATH (sync fs scan, never executing the binary — the
     * boolean contract is sync; execution happens in the runner where failures
     * map onto stream errors).
     */
    findMiniBinary() {
        const candidates = this.binaryCandidates();
        const [first] = candidates;
        if (isAbsolute(first) || first.includes('/') || first.includes('\\')) {
            return isExecutable(first) ? first : undefined;
        }
        const pathValue = this.env.PATH ?? '';
        for (const dir of pathValue.split(delimiter)) {
            if (!dir) {
                continue;
            }
            for (const candidate of candidates) {
                const full = join(dir, candidate);
                if (isExecutable(full)) {
                    return full;
                }
            }
        }
        return undefined;
    }
}
/** True when `p` exists and is executable (access throws otherwise). */
function isExecutable(p) {
    try {
        accessSync(p, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Child environment for one mini run.
 *
 * The credential projection (OPENAI_/ANTHROPIC_ key + base URL from the bound
 * llms.<name>.api reference) arrives via `options.env` from the host's
 * buildSdkEnv and is passed through untouched — values are never logged.
 * Additions here are limited to the two headless-safe pieces:
 * - `MSWEA_CONFIGURED`: mini's first-run interactive setup wizard must never
 *   trigger in a headless child (it would block on a prompt forever); the
 *   host supplies the model/credential, so the wizard is unwanted.
 * - the protocol base URL mirrored onto LiteLLM's legacy env name, covering
 *   litellm versions that read `OPENAI_API_BASE`/`ANTHROPIC_API_BASE` instead
 *   of the current spelling.
 */
function buildMiniChildEnv(providerEnv, queryEnv) {
    const env = { ...providerEnv, ...queryEnv };
    env.MSWEA_CONFIGURED ??= 'true';
    if (queryEnv?.OPENAI_BASE_URL && !env.OPENAI_API_BASE) {
        env.OPENAI_API_BASE = queryEnv.OPENAI_BASE_URL;
    }
    if (queryEnv?.ANTHROPIC_BASE_URL && !env.ANTHROPIC_API_BASE) {
        env.ANTHROPIC_API_BASE = queryEnv.ANTHROPIC_BASE_URL;
    }
    return env;
}
/** LiteLLM auth failures in mini's own diagnostics (stderr), bounded text only. */
function isAuthFailureText(text) {
    return /\b401\b|unauthorized|authentication\s*error|invalid\s*api\s*key|incorrect\s*api\s*key|api\s*key\s*(?:not\s*valid|invalid|missing)/i.test(text);
}
/**
 * Redact registered secret values from text emitted toward chat/logs.
 *
 * The central logger redacts serialized lines (redactChannelSecrets), but
 * chat messages and per-line status forwards bypass that path — the provider
 * boundary scrubs known secret values (the bound LLM credential and any
 * service-registered channel/model secret) before anything leaves the bridge.
 */
function redactSecretValues(text) {
    const values = knownSecretValues().filter(value => value.length >= 4)
        .sort((a, b) => b.length - a.length);
    let out = text;
    for (const value of values) {
        for (const form of [value, encodeURIComponent(value)]) {
            if (out.includes(form)) {
                out = out.split(form).join('[REDACTED]');
            }
        }
    }
    return out;
}
/**
 * Extract the final assistant message from a mini trajectory file.
 *
 * The trajectory JSON carries the run's message history (`trajectory` in the
 * documented format; `messages`/`history` accepted defensively for version
 * drift). Bounded read; any parse failure returns undefined so the caller
 * falls back to the stdout tail. Format fidelity against a real mini runtime
 * is UNVERIFIED (unknown) — fixtures drive the tests.
 */
function readFinalAssistantMessage(trajectoryPath) {
    let raw;
    try {
        raw = readFileSync(trajectoryPath, 'utf8');
    }
    catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        const list = parsed.trajectory ?? parsed.messages ?? parsed.history;
        if (!Array.isArray(list)) {
            return undefined;
        }
        for (let i = list.length - 1; i >= 0; i--) {
            const entry = list[i];
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const record = entry;
            if (record.role !== 'assistant') {
                continue;
            }
            const { content } = record;
            const text = typeof content === 'string'
                ? content
                : Array.isArray(content)
                    ? content
                        .map(block => block && typeof block === 'object' && typeof block.text === 'string'
                        ? block.text
                        : '')
                        .join('')
                    : '';
            if (text.trim()) {
                return text;
            }
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
/** Total character length of the replay transcript (bounded-shift guard). */
function joinLength(entries) {
    return entries.reduce((total, entry) => total + entry.length, 0);
}
/** Extract the plain-text content of a disclaude UserInput (pi/codex parity). */
function userInputText(input) {
    if (typeof input.content === 'string') {
        return input.content;
    }
    return input.content
        .map((block) => (block.type === 'text' ? block.text : JSON.stringify(block)))
        .join('\n');
}
