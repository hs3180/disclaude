/**
 * mini-swe-agent subprocess runner (Issue #5006).
 *
 * Owns everything process-shaped so the provider only deals in text:
 * - spawn `mini -y --exit-immediately -o <trajectory> [-m <model>] -t <prompt>`
 *   with stdin ignored (an open-but-silent stdin would let the CLI block on a
 *   prompt it can never receive headlessly — same contract as codex exec)
 * - stdout parsed line-by-line and forwarded to the caller (mini renders its
 *   run as human-oriented text; there is no JSON event stream to adapt)
 * - per-run wall-clock timeout (0 = disabled): SIGTERM → grace → SIGKILL
 * - stderr forwarded chunk-wise to the caller (Issue #2920 seam) and kept as
 *   a rolling tail for exit-code error mapping
 * - per-run trajectory file (`-o`) so concurrent runs never touch mini's
 *   shared default `last_mini_run.traj.json`
 *
 * Tests drive this against REAL subprocesses: a fake `mini` shell script on an
 * injected PATH exercises the actual spawn/readline/timer/kill machinery.
 *
 * Runtime fidelity note: the argv contract (`-y`, `--exit-immediately`, `-o`,
 * `-m`, `-t`) follows the documented `mini` CLI (mini-swe-agent docs, usage
 * and global-configuration pages). No real mini-swe-agent runtime exists on
 * this host; end-to-end behavior is UNVERIFIED and marked unknown.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../utils/logger.js';
import { browserAgentEnv } from '../../../utils/browser-env.js';
/** Rolling stderr tail kept for error mapping (bounded). */
const STDERR_TAIL_BYTES = 8 * 1024;
/** Rolling stdout tail kept as the final-answer fallback (bounded). */
const STDOUT_TAIL_BYTES = 8 * 1024;
/** Grace between SIGTERM and SIGKILL on timeout/abort. */
const KILL_GRACE_MS = 5_000;
/**
 * Prompt argv guard (codex-runner parity): argv single-argument limits are
 * ~128KB (Linux MAX_ARG_STRLEN) / ~256KB (macOS); beyond that spawn fails
 * with a cryptic E2BIG. Reject earlier with an actionable message instead.
 */
const MAX_PROMPT_CHARS = 120_000;
export class MiniSweRunner {
    binary;
    defaultTimeoutMs;
    /**
     * @param options.binary - absolute (or PATH-resolvable) mini executable.
     * @param options.timeoutMs - default per-run timeout (0 disables).
     */
    constructor(options = {}) {
        this.binary = options.binary ?? 'mini';
        this.defaultTimeoutMs = options.timeoutMs ?? 0;
    }
    /**
     * Run one `mini` invocation (one headless agent run).
     *
     * `onStdoutLine` is invoked synchronously per line so the caller's queueing
     * cannot drop lines between consumer await-points (same contract as the
     * codex exec JSONL bridge). Non-empty trimmed lines only.
     */
    run(options, onStdoutLine) {
        const logger = createLogger('MiniSweRunner', options.correlation ?? { runId: randomUUID() });
        if (options.prompt.length > MAX_PROMPT_CHARS) {
            const tooLong = new Error(`prompt too long for argv: ${options.prompt.length} chars ` +
                `(max ${MAX_PROMPT_CHARS}) — reduce the message/context size`);
            return {
                promise: Promise.resolve({
                    exitCode: null,
                    timedOut: false,
                    aborted: false,
                    spawnError: tooLong,
                    stderrTail: '',
                    stdoutTail: '',
                    durationMs: 0,
                }),
                handle: { abort: () => { }, inspectLiveness: () => Promise.resolve({ state: 'exited' }) },
            };
        }
        // `-y` (yolo): headless runs have no approver for proposed commands.
        // `--exit-immediately`: finish without the interactive exit confirmation.
        // `-o`: per-run trajectory — mini's default path is one shared
        // `last_mini_run.traj.json` in its global config dir, which concurrent
        // runs would clobber.
        const args = [
            '-y',
            '--exit-immediately',
            '-o', options.trajectoryPath,
            ...(options.model ? ['-m', options.model] : []),
            '-t', options.prompt,
        ];
        const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
        let child = null;
        let settled = false;
        let timedOut = false;
        let aborted = false;
        const stderrTail = createRollingTail(STDERR_TAIL_BYTES);
        const stdoutTail = createRollingTail(STDOUT_TAIL_BYTES);
        const startedAt = Date.now();
        let stdoutLineCount = 0;
        let stderrByteCount = 0;
        let timeoutTimer = null;
        let killTimer = null;
        /** SIGTERM now, SIGKILL after the grace if the child ignores it. */
        const killWithEscalation = (target) => {
            if (target.exitCode !== null || target.signalCode !== null) {
                // Descendants can hold these pipes after the owned child exits.
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
        const promise = new Promise((resolve) => {
            try {
                child = spawn(this.binary, args, {
                    cwd: options.cwd,
                    // stdin MUST be ignored — an open stdin makes the CLI wait for an
                    // interactive task/approval prompt that can never arrive headlessly.
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: browserAgentEnv(options.env),
                });
                logger.info({
                    pid: child.pid,
                    binary: this.binary,
                    cwd: options.cwd,
                    model: options.model ?? null,
                }, 'mini process spawned');
            }
            catch (error) {
                logger.error({ err: error, binary: this.binary, cwd: options.cwd, durationMs: Date.now() - startedAt }, 'mini process failed to spawn');
                resolve({
                    exitCode: null,
                    timedOut: false,
                    aborted: false,
                    spawnError: error,
                    stderrTail: '',
                    stdoutTail: '',
                    durationMs: Date.now() - startedAt,
                });
                return;
            }
            const currentChild = child;
            // ── stdout: line-by-line narration + rolling tail ──────────────────
            if (currentChild.stdout) {
                let pending = '';
                currentChild.stdout.on('data', (chunk) => {
                    pending += chunk.toString();
                    const lines = pending.split('\n');
                    pending = lines.pop() ?? '';
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) {
                            continue;
                        }
                        stdoutLineCount += 1;
                        stdoutTail.append(`${trimmed}\n`);
                        try {
                            onStdoutLine(trimmed);
                        }
                        catch {
                            logger.debug({ pid: currentChild.pid }, 'mini stdout observer failed');
                        }
                    }
                });
                currentChild.stdout.on('end', () => {
                    const rest = pending.trim();
                    if (rest) {
                        stdoutLineCount += 1;
                        stdoutTail.append(`${rest}\n`);
                        try {
                            onStdoutLine(rest);
                        }
                        catch {
                            logger.debug({ pid: currentChild.pid }, 'mini stdout observer failed');
                        }
                    }
                });
            }
            // ── stderr: forward + rolling tail ─────────────────────────────────
            currentChild.stderr?.on('data', (chunk) => {
                const text = chunk.toString();
                stderrByteCount += Buffer.byteLength(text);
                stderrTail.append(text);
                options.stderr?.(text);
                logger.debug({ pid: currentChild.pid, source: 'stderr', chunkLength: text.length }, 'mini stderr chunk');
            });
            // ── spawn failure (ENOENT etc.) ────────────────────────────────────
            currentChild.on('error', (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimers();
                logger.error({ err: error, pid: currentChild.pid, durationMs: Date.now() - startedAt, stdoutLineCount, stderrByteCount }, 'mini process error');
                resolve({
                    exitCode: null,
                    timedOut: false,
                    aborted: false,
                    spawnError: error,
                    stderrTail: stderrTail.text(),
                    stdoutTail: stdoutTail.text(),
                    durationMs: Date.now() - startedAt,
                });
            });
            // ── exit ───────────────────────────────────────────────────────────
            currentChild.on('close', (code) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimers();
                const fields = {
                    pid: currentChild.pid,
                    exitCode: code,
                    timedOut,
                    aborted,
                    durationMs: Date.now() - startedAt,
                    stdoutLineCount,
                    stderrByteCount,
                };
                if (code !== 0 || timedOut || aborted) {
                    logger.warn(fields, 'mini process closed with non-success state');
                }
                else {
                    logger.info(fields, 'mini process closed');
                }
                resolve({
                    exitCode: code,
                    timedOut,
                    aborted,
                    spawnError: undefined,
                    stderrTail: stderrTail.text(),
                    stdoutTail: stdoutTail.text(),
                    durationMs: Date.now() - startedAt,
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
