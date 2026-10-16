import { browserAgentEnv } from '../../../utils/browser-env.js';
import { CODEX_BROWSER_DISABLE_ARGS } from './browser-policy.js';
/**
 * codex exec subprocess runner — spawn / JSONL parse / lifecycle (Issue #4630, S2 of #4627).
 *
 * Owns everything process-shaped so the provider only deals in events:
 * - spawn `codex exec --json … <prompt>` with **stdin ignored** (verified
 *   live against 0.132.0: an open-but-silent stdin makes codex print
 *   "Reading additional input from stdin..." and block forever — the runner
 *   must never inherit a piped stdin)
 * - parse stdout line-by-line as JSONL ThreadEvents (blank / non-JSON lines
 *   are tolerated and logged — schema resilience, cf. exec-adapter.ts)
 * - per-run timeout: SIGTERM → grace → SIGKILL, resolving `timedOut`
 * - stderr: forwarded chunk-wise to the caller (Issue #2920 seam) and kept
 *   as a rolling tail for exit-code error mapping
 * - exit-code / spawn-error mapping left to the caller via the run result
 *
 * Tests drive this against REAL subprocesses: a fake `codex` shell script on
 * an injected PATH exercises the actual spawn/readline/timer/kill machinery.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createLogger } from '../../../utils/logger.js';
/** Rolling stderr tail kept for error mapping (bounded). */
const STDERR_TAIL_BYTES = 8 * 1024;
/** Grace between SIGTERM and SIGKILL on timeout/abort. */
const KILL_GRACE_MS = 5_000;
/** Default per-run timeout. Zero disables the runner wall-clock timeout. */
export const DEFAULT_TIMEOUT_MS = 0;
/**
 * Prompt argv guard (S2 review): argv single-argument limits are ~128KB
 * (Linux MAX_ARG_STRLEN) / ~256KB (macOS); beyond that spawn fails with a
 * cryptic E2BIG. Reject earlier with an actionable message instead.
 */
const MAX_PROMPT_CHARS = 120_000;
/**
 * Legacy Codex exec configuration only exposes a network override for
 * workspace-write. Read-only runs retain Codex's native policy: sending a
 * made-up sandbox_read_only table does not enable networking and produces
 * duplicate non-fatal configuration warnings in current native CLI output.
 * A custom read-only/network policy requires Codex permission profiles,
 * rather than an unsupported override or a broader filesystem sandbox.
 */
function networkAccessConfigKey(sandboxMode) {
    return sandboxMode === 'read-only'
        ? undefined
        : 'sandbox_workspace_write.network_access';
}
export class CodexExecRunner {
    binary;
    defaultTimeoutMs;
    defaultNetworkAccess;
    /**
     * @param options.binary - absolute (or PATH-resolvable) codex binary.
     * @param options.timeoutMs - default per-run timeout.
     */
    constructor(options = {}) {
        this.binary = options.binary ?? 'codex';
        this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.defaultNetworkAccess = options.networkAccess;
    }
    /**
     * Run one `codex exec` invocation.
     *
     * `onEvent` is invoked synchronously per parsed JSONL line so the caller's
     * queueing cannot drop events between consumer await-points (same contract
     * as pi's subscribe/enqueue, #4386 part 3).
     *
     * Session persistence (S3, #4628): runs are NOT `--ephemeral` — turn 1
     * must write a rollout file under codex's own session storage (~/.codex/
     * sessions) so follow-up turns can `exec resume <thread_id>` into the same
     * conversation. disclaude only passes the id through; it never reads or
     * GCs codex's session files (codex owns that storage, same as auth.json).
     */
    run(options, onEvent) {
        const logger = createLogger('CodexExecRunner', options.correlation ?? { runId: randomUUID() });
        if (options.prompt.length > MAX_PROMPT_CHARS) {
            // Fail with a clear message instead of a cryptic spawn E2BIG.
            const tooLong = new Error(`prompt too long for argv: ${options.prompt.length} chars ` +
                `(max ${MAX_PROMPT_CHARS}) — reduce the message/context size`);
            return {
                promise: Promise.resolve({
                    exitCode: null,
                    timedOut: false,
                    aborted: false,
                    spawnError: tooLong,
                    stderrTail: '',
                    durationMs: 0,
                }),
                handle: { abort: () => { }, inspectLiveness: () => Promise.resolve({ state: 'exited' }) },
            };
        }
        // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` (0.132.0): the
        // session id is the FIRST positional, the prompt the second; `--` keeps
        // a leading-dash prompt positional. Flags are shared with plain exec
        // (--json / -m / --skip-git-repo-check all verified on resume's help),
        // EXCEPT sandbox: fresh exec has the dedicated -s flag, while resume only
        // accepts the config override form (codex-cli 0.151.0).
        const networkAccess = options.networkAccess ?? this.defaultNetworkAccess;
        const networkConfigKey = networkAccessConfigKey(options.sandboxMode);
        const networkArgs = networkAccess !== undefined && networkConfigKey !== undefined
            ? ['-c', `${networkConfigKey}=${networkAccess}`]
            : [];
        const args = options.resumeSessionId
            ? [
                'exec',
                'resume',
                '--json',
                '--skip-git-repo-check',
                ...CODEX_BROWSER_DISABLE_ARGS,
                ...(options.fullAccess ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
                ...(options.model ? ['-m', options.model] : []),
                ...(options.reasoningEffort ? ['-c', `model_reasoning_effort="${options.reasoningEffort}"`] : []),
                ...(options.sandboxMode ? ['-c', `sandbox_mode=${options.sandboxMode}`] : []),
                ...networkArgs,
                options.resumeSessionId,
                '--',
                options.prompt,
            ]
            : [
                'exec',
                '--json',
                '--skip-git-repo-check',
                ...CODEX_BROWSER_DISABLE_ARGS,
                ...(options.fullAccess ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
                ...(options.model ? ['-m', options.model] : []),
                ...(options.reasoningEffort ? ['-c', `model_reasoning_effort="${options.reasoningEffort}"`] : []),
                ...(options.sandboxMode ? ['-s', options.sandboxMode] : []),
                ...networkArgs,
                '--',
                options.prompt,
            ];
        const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
        let child = null;
        let settled = false;
        let timedOut = false;
        let aborted = false;
        let abortRequestedAt;
        // Two independent timers (S2 review): the run timeout and the
        // SIGTERM→SIGKILL escalation grace. Sharing one slot let abort()'s
        // escalation timer overwrite the pending timeout timer's handle (the
        // timeout then fired mid-abort and mislabeled timedOut, and its handle
        // was unclerachable).
        let timeoutTimer = null;
        let killTimer = null;
        const stderrTail = createRollingTail(STDERR_TAIL_BYTES);
        const startedAt = Date.now();
        let stdoutLineCount = 0;
        let stderrByteCount = 0;
        /** SIGTERM now, SIGKILL after the grace if the child ignores it. */
        const killWithEscalation = (target) => {
            if (target.exitCode !== null || target.signalCode !== null) {
                // Descendants can hold these pipes after the owned child exits.
                // Close our readers; do not signal a reparented or reused PID.
                target.stdout?.destroy();
                target.stderr?.destroy();
                return;
            }
            if (killTimer) {
                return;
            }
            try {
                target.kill('SIGTERM');
            }
            catch {
                /* already gone */
            }
            killTimer = setTimeout(() => {
                if (settled || target.exitCode !== null || target.signalCode !== null) {
                    return;
                }
                try {
                    target.kill('SIGKILL');
                }
                catch {
                    /* already gone */
                }
            }, KILL_GRACE_MS);
            killTimer.unref?.();
        };
        const clearTimers = () => {
            if (killTimer) {
                clearTimeout(killTimer);
                killTimer = null;
            }
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
            }
        };
        const clearKillTimer = clearTimers;
        const promise = new Promise((resolve) => {
            try {
                child = spawn(this.binary, args, {
                    cwd: options.cwd,
                    // stdin MUST be ignored — an open stdin makes codex exec block on
                    // "Reading additional input from stdin..." (verified, 0.132.0).
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: browserAgentEnv(options.env),
                });
                logger.info({
                    pid: child.pid,
                    binary: this.binary,
                    cwd: options.cwd,
                    resumed: Boolean(options.resumeSessionId),
                }, 'codex exec process spawned');
            }
            catch (error) {
                logger.error({ err: error, binary: this.binary, cwd: options.cwd, durationMs: Date.now() - startedAt }, 'codex exec process failed to spawn');
                resolve({
                    exitCode: null,
                    timedOut: false,
                    aborted: false,
                    spawnError: error,
                    stderrTail: '',
                    durationMs: Date.now() - startedAt,
                });
                return;
            }
            const currentChild = child;
            // ── stdout: JSONL → ThreadEvents ───────────────────────────────────
            // stdio is ['ignore', 'pipe', 'pipe'], so stdout is always present at
            // runtime; the guard satisfies the Readable | null spawn typing.
            if (currentChild.stdout) {
                const readline = createInterface({ input: currentChild.stdout });
                readline.on('line', (line) => {
                    const trimmed = line.trim();
                    if (!trimmed) {
                        return;
                    }
                    stdoutLineCount += 1;
                    try {
                        const event = JSON.parse(trimmed);
                        logger.debug({ pid: currentChild.pid, source: 'stdout', eventType: event.type }, 'codex exec event');
                        onEvent(event);
                    }
                    catch {
                        // Non-JSON line (banner, stray output): tolerate, never fatal.
                        logger.debug({ pid: currentChild.pid, source: 'stdout', lineLength: trimmed.length }, 'codex exec stdout line');
                    }
                });
            }
            // ── stderr: forward + rolling tail ─────────────────────────────────
            currentChild.stderr?.on('data', (chunk) => {
                const text = chunk.toString();
                stderrByteCount += Buffer.byteLength(text);
                stderrTail.append(text);
                options.stderr?.(text);
                logger.debug({ pid: currentChild.pid, source: 'stderr', chunkLength: text.length }, 'codex exec stderr chunk');
            });
            // ── spawn failure (ENOENT etc.) ────────────────────────────────────
            currentChild.on('error', (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearKillTimer();
                logger.error({
                    err: error,
                    pid: currentChild.pid,
                    durationMs: Date.now() - startedAt,
                    stdoutLineCount,
                    stderrByteCount,
                    stderrTail: stderrTail.text(),
                }, 'codex exec process error');
                resolve({
                    exitCode: null,
                    timedOut: false,
                    aborted: false,
                    spawnError: error,
                    stderrTail: stderrTail.text(),
                    durationMs: Date.now() - startedAt,
                    ...(abortRequestedAt !== undefined
                        ? { abortExitLatencyMs: Date.now() - abortRequestedAt }
                        : {}),
                });
            });
            // ── exit ───────────────────────────────────────────────────────────
            currentChild.on('close', (code) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearKillTimer();
                const fields = {
                    pid: currentChild.pid,
                    exitCode: code,
                    timedOut,
                    aborted,
                    durationMs: Date.now() - startedAt,
                    stdoutLineCount,
                    stderrByteCount,
                    stderrTail: stderrTail.text() || undefined,
                };
                if (code !== 0 || timedOut || aborted) {
                    logger.warn(fields, 'codex exec process closed with non-success state');
                }
                else {
                    logger.info(fields, 'codex exec process closed');
                }
                resolve({
                    exitCode: code,
                    timedOut,
                    aborted,
                    spawnError: undefined,
                    stderrTail: stderrTail.text(),
                    durationMs: Date.now() - startedAt,
                    ...(abortRequestedAt !== undefined
                        ? { abortExitLatencyMs: Date.now() - abortRequestedAt }
                        : {}),
                });
            });
            // ── per-run timeout ────────────────────────────────────────────────
            if (timeoutMs > 0) {
                timeoutTimer = setTimeout(() => {
                    if (settled) {
                        return;
                    }
                    timedOut = true;
                    killWithEscalation(currentChild);
                }, timeoutMs);
                timeoutTimer.unref?.();
            }
        });
        const handle = {
            inspectLiveness: async () => {
                const target = child;
                const pid = target?.pid;
                const exited = () => !target || settled || target.exitCode !== null || target.signalCode !== null;
                if (exited()) {
                    return { state: 'exited', pid };
                }
                if (!pid || process.platform === 'win32') {
                    return { state: 'unknown', pid };
                }
                try {
                    // No argv or environment columns. Bound both the probe and its output.
                    const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'stat='], {
                        timeout: 1000, maxBuffer: 1024, encoding: 'utf8',
                    });
                    if (exited()) {
                        return { state: 'exited', pid };
                    }
                    const status = stdout.trim();
                    if (status.includes('T')) {
                        return { state: 'stopped', pid };
                    }
                    if (status.startsWith('Z')) {
                        return { state: 'exited', pid };
                    }
                    return { state: /^[RSIDW]/.test(status) ? 'alive' : 'unknown', pid };
                }
                catch {
                    if (exited()) {
                        return { state: 'exited', pid };
                    }
                    try {
                        process.kill(pid, 0);
                    }
                    catch (error) {
                        if (error.code === 'ESRCH') {
                            return { state: 'exited', pid };
                        }
                    }
                    return { state: 'unknown', pid };
                }
            },
            abort: () => {
                if (settled || !child) {
                    return;
                }
                aborted = true;
                abortRequestedAt ??= Date.now();
                killWithEscalation(child);
            },
        };
        return { promise, handle };
    }
}
/** Bounded append-only buffer (keeps the LAST bytes). */
function createRollingTail(capacity) {
    let buf = '';
    return {
        append(text) {
            buf += text;
            if (buf.length > capacity) {
                buf = buf.slice(buf.length - capacity);
            }
        },
        text() {
            return buf;
        },
    };
}
