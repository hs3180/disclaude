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

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { createLogger } from '../../../utils/logger.js';
import type { CodexSandboxLevel } from './sandbox-policy.js';
import type { CodexThreadEvent } from './exec-adapter.js';

const logger = createLogger('CodexExecRunner');

/** Rolling stderr tail kept for error mapping (bounded). */
const STDERR_TAIL_BYTES = 8 * 1024;
/** Grace between SIGTERM and SIGKILL on timeout/abort. */
const KILL_GRACE_MS = 5_000;
/** Default per-run timeout (env-tunable, constructor-overridable). */
export const DEFAULT_TIMEOUT_MS = 600_000;
/**
 * Prompt argv guard (S2 review): argv single-argument limits are ~128KB
 * (Linux MAX_ARG_STRLEN) / ~256KB (macOS); beyond that spawn fails with a
 * cryptic E2BIG. Reject earlier with an actionable message instead.
 */
const MAX_PROMPT_CHARS = 120_000;

export interface CodexExecRunOptions {
  /** The user prompt (passed as the trailing positional argument). */
  prompt: string;
  /** Working directory for the codex process. */
  cwd?: string;
  /** Model passthrough (`-m`). */
  model?: string;
  /**
   * Resume an existing codex session instead of starting a new one
   * (Issue #4628, S3): argv becomes `codex exec resume <id> -- <prompt>`.
   * The id is the thread_id captured from a prior run's thread.started.
   */
  resumeSessionId?: string;
  /**
   * Sandbox level for this run (Issue #4631, S4). Passed uniformly as
   * `-c sandbox_mode=<level>` on BOTH fresh and resume runs: `-s <level>`
   * is rejected by `codex exec resume` ("unexpected argument '-s'",
   * verified 0.132.0) while the config-override form is accepted by both
   * and enforces identically (read-only write-block verified live).
   */
  sandboxMode?: CodexSandboxLevel;
  /** Environment for the child (merged over the provider env). */
  env?: Record<string, string | undefined>;
  /** Per-call timeout override (ms). */
  timeoutMs?: number;
  /** stderr chunk callback (Issue #2920 seam, forwarded from AgentQueryOptions). */
  stderr?: (data: string) => void;
}

export interface CodexExecRunResult {
  /** Process exit code; null when the process was killed or failed to spawn. */
  exitCode: number | null;
  /** True when the run was ended by the timeout (SIGTERM/SIGKILL). */
  timedOut: boolean;
  /** True when the run was ended by an explicit abort() (cancel/close). */
  aborted: boolean;
  /** Set when the process could not be spawned (ENOENT → actionable hint). */
  spawnError?: Error;
  /** Rolling tail of stderr for actionable error messages. */
  stderrTail: string;
}

/** Handle for aborting an in-flight run (maps onto QueryHandle cancel/close). */
export interface CodexExecRunHandle {
  abort(): void;
}

export class CodexExecRunner {
  private readonly binary: string;
  private readonly defaultTimeoutMs: number;

  /**
   * @param options.binary - absolute (or PATH-resolvable) codex binary.
   * @param options.timeoutMs - default per-run timeout.
   */
  constructor(options: { binary?: string; timeoutMs?: number } = {}) {
    this.binary = options.binary ?? 'codex';
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  run(
    options: CodexExecRunOptions,
    onEvent: (event: CodexThreadEvent) => void,
  ): { promise: Promise<CodexExecRunResult>; handle: CodexExecRunHandle } {
    if (options.prompt.length > MAX_PROMPT_CHARS) {
      // Fail with a clear message instead of a cryptic spawn E2BIG.
      const tooLong = new Error(
        `prompt too long for argv: ${options.prompt.length} chars ` +
        `(max ${MAX_PROMPT_CHARS}) — reduce the message/context size`,
      );
      return {
        promise: Promise.resolve({
          exitCode: null,
          timedOut: false,
          aborted: false,
          spawnError: tooLong,
          stderrTail: '',
        }),
        handle: { abort: (): void => {} },
      };
    }

    // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` (0.132.0): the
    // session id is the FIRST positional, the prompt the second; `--` keeps
    // a leading-dash prompt positional. Flags are shared with plain exec
    // (--json / -m / --skip-git-repo-check all verified on resume's help),
    // EXCEPT -s (sandbox) which resume rejects — hence the -c form below.
    const args: string[] = options.resumeSessionId
      ? [
          'exec',
          'resume',
          '--json',
          '--skip-git-repo-check',
          ...(options.model ? ['-m', options.model] : []),
          ...(options.sandboxMode ? ['-c', `sandbox_mode=${options.sandboxMode}`] : []),
          options.resumeSessionId,
          '--',
          options.prompt,
        ]
      : [
          'exec',
          '--json',
          '--skip-git-repo-check',
          ...(options.model ? ['-m', options.model] : []),
          ...(options.sandboxMode ? ['-c', `sandbox_mode=${options.sandboxMode}`] : []),
          '--',
          options.prompt,
        ];
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    let child: ReturnType<typeof spawn> | null = null;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    // Two independent timers (S2 review): the run timeout and the
    // SIGTERM→SIGKILL escalation grace. Sharing one slot let abort()'s
    // escalation timer overwrite the pending timeout timer's handle (the
    // timeout then fired mid-abort and mislabeled timedOut, and its handle
    // was unclerachable).
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const stderrTail = createRollingTail(STDERR_TAIL_BYTES);

    /** SIGTERM now, SIGKILL after the grace if the child ignores it. */
    const killWithEscalation = (target: NonNullable<typeof child>): void => {
      if (target.killed || target.exitCode !== null) {
        return;
      }
      try {
        target.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          target.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const clearTimers = (): void => {
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

    const promise = new Promise<CodexExecRunResult>((resolve) => {
      try {
        child = spawn(this.binary, args, {
          cwd: options.cwd,
          // stdin MUST be ignored — an open stdin makes codex exec block on
          // "Reading additional input from stdin..." (verified, 0.132.0).
          stdio: ['ignore', 'pipe', 'pipe'],
          env: options.env,
        });
      } catch (error) {
        resolve({
          exitCode: null,
          timedOut: false,
          aborted: false,
          spawnError: error as Error,
          stderrTail: '',
        });
        return;
      }

      const currentChild = child;

      // ── stdout: JSONL → ThreadEvents ───────────────────────────────────
      // stdio is ['ignore', 'pipe', 'pipe'], so stdout is always present at
      // runtime; the guard satisfies the Readable | null spawn typing.
      if (currentChild.stdout) {
        const readline = createInterface({ input: currentChild.stdout });
        readline.on('line', (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) {
            return;
          }
          try {
            onEvent(JSON.parse(trimmed) as CodexThreadEvent);
          } catch {
            // Non-JSON line (banner, stray output): tolerate, never fatal.
            logger.debug({ line: trimmed.slice(0, 200) }, 'codex exec: non-JSON stdout line skipped');
          }
        });
      }

      // ── stderr: forward + rolling tail ─────────────────────────────────
      currentChild.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrTail.append(text);
        options.stderr?.(text);
      });

      // ── spawn failure (ENOENT etc.) ────────────────────────────────────
      currentChild.on('error', (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearKillTimer();
        resolve({
          exitCode: null,
          timedOut: false,
          aborted: false,
          spawnError: error,
          stderrTail: stderrTail.text(),
        });
      });

      // ── exit ───────────────────────────────────────────────────────────
      currentChild.on('close', (code: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearKillTimer();
        resolve({
          exitCode: code,
          timedOut,
          aborted,
          spawnError: undefined,
          stderrTail: stderrTail.text(),
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

    const handle: CodexExecRunHandle = {
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
function createRollingTail(capacity: number): {
  append(text: string): void;
  text(): string;
} {
  let buf = '';
  return {
    append(text: string): void {
      buf += text;
      if (buf.length > capacity) {
        buf = buf.slice(buf.length - capacity);
      }
    },
    text(): string {
      return buf;
    },
  };
}
