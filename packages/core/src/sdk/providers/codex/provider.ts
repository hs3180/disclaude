/**
 * Codex CLI Agent Provider (Issue #4629 skeleton + #4630 exec bridge +
 * #4628 sessions & auth).
 *
 * S1 (#4629): registry/config/validation — fail-fast environment checks
 * (binary on PATH, OAuth auth.json under CODEX_HOME).
 * S2 (#4630): queryStream — each user input spawns one `codex exec --json`
 * subprocess (codex-runner.ts) whose JSONL ThreadEvents are adapted
 * (exec-adapter.ts) onto the unified AgentMessage stream. The bridge mirrors
 * the pi queryStream architecture (#4386 part 3/5): queue+wake consumer
 * loop, detached input pump, and the shared no-content-progress stall
 * watchdog seam (#4550 pattern, env-tunable DISCLAUDE_STALL_TIMEOUT_MS).
 * S3 (#4628): multi-turn continuity + auth lifecycle. Session semantics:
 * ChatAgent keeps ONE queryStream per chatId and `/reset` closes its input
 * generator, so the chatId→session map IS this queryStream's closure state —
 * the thread_id of the last SUCCESSFUL turn (`resumeThreadId`) is replayed
 * as `codex exec resume <id>` on every follow-up turn; tearing the stream
 * down (reset, idle GC via ChatAgent's per-chatId agent cleanup) drops it,
 * and the next queryStream starts a fresh session. Rollout files live in
 * codex's own storage (~/.codex/sessions) — disclaude passes the id through
 * and never reads/GCs them. If codex reports the rollout gone
 * (isCodexResumeTargetMissing), the target is cleared so the next turn
 * self-heals into a fresh session instead of bricking the chat until /reset.
 *
 * Auth: codex owns credentials entirely (auth.json under CODEX_HOME, written
 * by the one-time interactive `codex login`) — disclaude stores nothing and
 * only detects failure signatures (isCodexAuthFailure: stdout error events +
 * stderr 401/token-expired) to tell the user to re-run `codex login`.
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { createLogger } from '../../../utils/logger.js';
import type { IAgentSDKProvider } from '../../interface.js';
import type {
  AgentMessage,
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  ProviderInfo,
  StreamQueryResult,
  UserInput,
} from '../../types.js';
import {
  CodexExecRunner,
  DEFAULT_TIMEOUT_MS,
  type CodexExecRunHandle,
  type CodexExecRunResult,
} from './codex-runner.js';
import {
  adaptCodexEvent,
  isCodexAuthFailure,
  isCodexResumeTargetMissing,
  userInputText,
  type CodexThreadEvent,
} from './exec-adapter.js';

const logger = createLogger('CodexAgentProvider');

/**
 * Same user-facing stall notice the Claude (#3706) and pi (#4386 part 5)
 * bridges yield, so all three backends read identically in chat and logs.
 */
const STALL_TERMINATE_NOTICE =
  '⚠️ 上游模型响应超时（疑似 stall），已自动取消本次响应。请稍后重试。';

/**
 * Actionable re-auth notice (#4628): codex's ChatGPT login expired/revoked —
 * only a human re-running the interactive `codex login` can fix it, so the
 * message says exactly that (disclaude never touches credentials itself).
 */
const REAUTH_NOTICE =
  '🔴 Codex 登录已失效（401 / 令牌过期）——请在运行 disclaude 的机器上执行 `codex login` 重新完成 Sign in with ChatGPT 授权，然后重发消息即可（当前消息未被处理）。';

/**
 * Notice when the resume target vanished on codex's side (#4628): the bridge
 * drops the dead thread id and the NEXT turn starts a fresh session.
 */
const RESUME_TARGET_GONE_NOTICE =
  '⚠️ Codex 会话记录已不存在（可能被清理），已自动切换新会话——请重发你的问题，将从全新上下文开始（无此前对话内容）。';

/** Actionable binary-missing error (thrown synchronously by queryStream). */
const BINARY_MISSING = (pathValue: string): string =>
  `CodexAgentProvider: codex CLI binary not found on PATH "${pathValue}" — install it first: ` +
  '`npm install -g @openai/codex`, then complete `codex login` (Sign in with ChatGPT).';

/**
 * Constructor options — dependency injection seams for tests.
 *
 * `env` controls PATH (binary lookup) and CODEX_HOME (auth lookup); tests
 * inject a fake env pointing at temp fixtures instead of mocking fs/spawn.
 */
export interface CodexAgentProviderOptions {
  /** Environment used for resolution + child spawn. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Per-run codex exec timeout (default 600s). */
  execTimeoutMs?: number;
}

/** The file Codex CLI writes after a successful `codex login` (OAuth). */
const AUTH_FILE = 'auth.json';

export class CodexAgentProvider implements IAgentSDKProvider {
  readonly name = 'codex';
  readonly version = '0.2.0-sessions-auth';

  private readonly env: Record<string, string | undefined>;
  private readonly execTimeoutMs: number | undefined;

  private disposed = false;

  constructor(options: CodexAgentProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.execTimeoutMs = options.execTimeoutMs;
  }

  // --------------------------------------------------------------------------
  // Provider information
  // --------------------------------------------------------------------------

  getInfo(): ProviderInfo {
    if (this.disposed) {
      return {
        name: this.name,
        version: this.version,
        available: false,
        unavailableReason: 'Provider has been disposed',
      };
    }

    const problems: string[] = [];
    if (!this.findCodexBinary()) {
      problems.push(
        'codex CLI binary not found on PATH — install it first: `npm install -g @openai/codex` (https://developers.openai.com/codex/cli)',
      );
    }
    if (!this.hasAuth()) {
      problems.push(
        'Codex auth missing (OAuth not completed) — run `codex login` (Sign in with ChatGPT); set CODEX_HOME if it is installed elsewhere',
      );
    }

    const info: ProviderInfo = {
      name: this.name,
      version: this.version,
      available: problems.length === 0,
    };
    if (problems.length > 0) {
      info.unavailableReason = problems.join('; ');
    }
    return info;
  }

  // --------------------------------------------------------------------------
  // Query — Issue #4630 (S2): codex exec subprocess bridge
  // --------------------------------------------------------------------------

  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions,
  ): StreamQueryResult {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }
    // Fail fast with an actionable message — same contract as pi's missing
    // streamFn check (#4386 part 3): the environment problem is knowable at
    // call time, so it must not surface as a cryptic mid-stream ENOENT.
    const binary = this.findCodexBinary();
    if (!binary) {
      throw new Error(BINARY_MISSING(this.env.PATH ?? ''));
    }

    const runner = new CodexExecRunner({
      binary,
      timeoutMs: this.execTimeoutMs,
    });
    // Captured at queryStream call time — the constructor-injected env the
    // binary was resolved from (tests: PATH fixtures; prod: process.env).
    const providerEnv = this.env;
    const timeoutLabel = this.execTimeoutMs
      ? `${this.execTimeoutMs}ms`
      : `${DEFAULT_TIMEOUT_MS}ms (default)`;

    // Abort plumbing (mirrors pi: early-cancel latch + late onAbort wake).
    let currentRun: CodexExecRunHandle | null = null;
    let cancelRequested = false;
    let onAbort: (() => void) | null = null;
    const requestAbort = (): void => {
      if (currentRun) {
        currentRun.abort();
      } else {
        cancelRequested = true;
      }
      onAbort?.();
    };

    // thread.started → handle.sessionId (observed thread id, even on failed
    // runs). resumeThreadId below is the stricter S3 notion: the anchor of
    // the conversation, latched ONLY from a completed turn.
    let latestSessionId: string | undefined;
    // S3 (#4628): the thread_id the NEXT turn resumes into. This closure IS
    // the chatId→session map — ChatAgent owns one queryStream per chatId, so
    // tearing it down (/reset, idle GC) drops the map entry for free.
    let resumeThreadId: string | undefined;

    const adaptIterator =
      async function* (this: void): AsyncGenerator<AgentMessage> {
        // ── Event bridge state (pi #4386 part 3 pattern) ──────────────────
        const queue: AgentMessage[] = [];
        const notify: (() => void)[] = [];
        let inputDone = false;
        let runActive = false;
        let aborted = false;
        const wakeAll = (): void => {
          for (const wake of notify.splice(0)) {
            wake();
          }
        };

        // ── Stall watchdog (#4630, reusing the #4550/#3706 seam) ──────────
        // Armed for the whole run, re-armed on EVERY stdout event (any JSONL
        // line is progress), exempt while a tool item is open (started
        // without completed — a long build/test legitimately stays silent).
        // Env knob DISCLAUDE_STALL_TIMEOUT_MS matches the Claude/pi bridges.
        const STALL_TIMEOUT_MS = (() => {
          const parsed = Number.parseInt(
            process.env.DISCLAUDE_STALL_TIMEOUT_MS ?? '',
            10,
          );
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000;
        })();
        const STALL_FORCE_CLOSE_GRACE_MS = (() => {
          const parsed = Number.parseInt(
            process.env.DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS ?? '',
            10,
          );
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 5_000;
        })();
        let stalled = false;
        let stallWatchdog: ReturnType<typeof setTimeout> | null = null;
        let stallForceCloseTimer: ReturnType<typeof setTimeout> | null = null;
        let openToolItems = 0;
        let sawTurnTerminator = false;
        let sawTurnFailed = false;
        // S3 (#4628): completed-turn marker (vs. sawTurnTerminator, which
        // turn.failed also sets) + raw failure text for the detectors. The
        // adapter downgrades transient "Reconnecting..." errors to status,
        // so signature detection must read the RAW event text, not adapted
        // messages.
        let sawTurnCompleted = false;
        let runFailureText = '';        const armTimer = (
          fn: () => void,
          ms: number,
        ): ReturnType<typeof setTimeout> => {
          const t = setTimeout(fn, ms);
          t.unref?.();
          return t;
        };
        const clearStallTimers = (): void => {
          if (stallWatchdog) {
            clearTimeout(stallWatchdog);
            stallWatchdog = null;
          }
          if (stallForceCloseTimer) {
            clearTimeout(stallForceCloseTimer);
            stallForceCloseTimer = null;
          }
        };
        const fireStallWatchdog = (): void => {
          stallWatchdog = null;
          if (!runActive || stalled) {
            return;
          }
          if (openToolItems > 0) {
            // Silence belongs to the running tool, not the stream — re-arm.
            stallWatchdog = armTimer(fireStallWatchdog, STALL_TIMEOUT_MS);
            return;
          }
          stalled = true;
          logger.error(
            { stallTimeoutMs: STALL_TIMEOUT_MS },
            `codex stall: no exec events for ${STALL_TIMEOUT_MS}ms during an active run; ` +
              'killing the codex process (Issue #4630, cf. #3706)',
          );
          currentRun?.abort();
          stallForceCloseTimer = armTimer(() => {
            stallForceCloseTimer = null;
            onAbort?.();
          }, STALL_FORCE_CLOSE_GRACE_MS);
        };
        const touchStallWatchdog = (): void => {
          if (!runActive || stalled) {
            return;
          }
          clearStallTimers();
          stallWatchdog = armTimer(fireStallWatchdog, STALL_TIMEOUT_MS);
        };

        /** Push a bridge-synthesized message (post-run failure mapping). */
        const pushSynthetic = (message: AgentMessage): void => {
          if (stalled) {
            return;
          }
          queue.push(message);
          wakeAll();
        };

        const enqueue = (event: CodexThreadEvent): void => {
          if (event.type === 'thread.started') {
            latestSessionId = event.thread_id;
          }
          // Open-tool tracking for the watchdog exemption (cf. pi #4568 dir 2).
          if (event.type === 'item.started') {
            const t = event.item?.type;
            if (t === 'command_execution' || t === 'mcp_tool_call') {
              openToolItems++;
            }
          } else if (event.type === 'item.completed') {
            const t = event.item?.type;
            if (t === 'command_execution' || t === 'mcp_tool_call') {
              openToolItems = Math.max(0, openToolItems - 1);
            }
          } else if (
            event.type === 'turn.completed' ||
            event.type === 'turn.failed'
          ) {
            sawTurnTerminator = true;
            if (event.type === 'turn.completed') {
              sawTurnCompleted = true;
            } else if (event.type === 'turn.failed') {
              // turn.failed is a terminator for bookkeeping, but the TURN
              // still needs a synthetic result (see runInput) — the adapter
              // emits only an error for it, and ChatAgent resolves a turn
              // exclusively on type==='result' (cf. #4378 error_max_* pitfall).
              sawTurnFailed = true;
            }
          } else if (event.type === 'error') {
            runFailureText += `\n${event.message}`;
          }
          if (event.type === 'turn.failed') {
            runFailureText += `\n${event.error?.message ?? ''}`;          }
          touchStallWatchdog();
          const adapted = adaptCodexEvent(event);
          if (adapted) {
            queue.push(adapted);
          }
          wakeAll();
        };
        onAbort = (): void => {
          aborted = true;
          wakeAll();
        };

        // ── Turn runner: one user input → one codex exec run ──────────────
        // First turn runs `codex exec … -- <prompt>`; every follow-up runs
        // `codex exec resume <thread_id> … -- <prompt>` (S3, #4628).
        const runInput = async (prompt: string): Promise<void> => {
          runActive = true;
          sawTurnTerminator = false;
          sawTurnFailed = false;
          sawTurnCompleted = false;
          runFailureText = '';
          const resumeTarget = resumeThreadId;          touchStallWatchdog();
          const { promise, handle } = runner.run(
            {
              prompt,
              resumeSessionId: resumeTarget,
              cwd: options.cwd,
              model: options.model,
              env: { ...providerEnv, ...options.env },
              stderr: options.stderr,
            },
            enqueue,
          );
          currentRun = handle;
          if (cancelRequested) {
            // cancel()/close() arrived before this run started (early latch).
            handle.abort();
          }
          try {
            const result: CodexExecRunResult = await promise;
            if (stalled || result.aborted) {
              // Stall terminator is synthesized by the consumer loop; a user
              // abort ends the stream without a turn terminator (pi parity).
              return;
            }
            // Failure-signature detection (#4628, S3 review hardened):
            // - gated on runFailed — a SUCCESSFUL turn (exit 0 + terminator)
            //   must never be followed by a spurious 401/limit notice just
            //   because stderr carries unrelated text (e.g. an MCP server's
            //   own 401 noise that codex forwarded);
            // - per-surface: the conjunction (401 + unauthorized) must hit
            //   WITHIN one surface, not across the raw-events/stderr splice.
            const runFailed =
              Boolean(result.spawnError) ||
              result.timedOut ||
              result.exitCode !== 0 ||
              !sawTurnTerminator;
            const authFailed =
              runFailed &&
              (isCodexAuthFailure(runFailureText) || isCodexAuthFailure(result.stderrTail));
            const resumeTargetGone =
              runFailed &&
              resumeTarget !== undefined &&
              (isCodexResumeTargetMissing(runFailureText) ||
                isCodexResumeTargetMissing(result.stderrTail));
            if (authFailed) {
              // Most actionable diagnosis wins: exit-code noise around a 401
              // would bury the one thing the user can actually do.
              pushSynthetic({
                type: 'error',
                content: REAUTH_NOTICE,
                role: 'assistant',
              });
            } else if (result.spawnError) {
              pushSynthetic({
                type: 'error',
                content:
                  `codex exec failed to spawn (${result.spawnError.message}). ` +
                  'Is the codex CLI installed and on PATH?',
                role: 'assistant',
              });
            } else if (result.timedOut) {
              pushSynthetic({
                type: 'error',
                content:
                  `codex exec timed out after ${timeoutLabel} and was killed — ` +
                  'try a smaller task or raise the timeout.',
                role: 'assistant',
              });
            } else if (resumeTargetGone) {
              // Self-heal (#4628): the rollout vanished on codex's side —
              // drop the dead id so the NEXT turn starts fresh instead of
              // bricking this chat until /reset.
              resumeThreadId = undefined;
              logger.warn(
                { threadId: resumeTarget },
                'codex resume target missing (no rollout found); cleared — next turn starts a fresh session (Issue #4628)',
              );
              pushSynthetic({
                type: 'error',
                content: RESUME_TARGET_GONE_NOTICE,
                role: 'assistant',
              });
            } else if (result.exitCode !== 0) {
              pushSynthetic({
                type: 'error',
                content:
                  `codex exec exited with code ${result.exitCode}${
                  result.stderrTail
                    ? `: ${result.stderrTail.trim().slice(-500)}`
                    : ''}`,
                role: 'assistant',
              });
            } else if (!sawTurnTerminator) {
              pushSynthetic({
                type: 'error',
                content:
                  'codex exec exited 0 without completing a turn (no turn.completed event) — ' +
                  'possibly a CLI version mismatch; see exec-adapter.ts notes.',
                role: 'assistant',
              });
            }
            // Latch the resume anchor ONLY off a completed turn: thread.started
            // fires even on a 401-failed run (verified 0.132.0), so a failed
            // first turn must not become the conversation anchor; an already-
            // latched conversation survives transient failures (retry after a
            // timeout resumes where it left off). turn.completed may carry a
            // NEW thread_id if codex forks the thread on resume — latching
            // latestSessionId handles both shapes.
            if (sawTurnCompleted && latestSessionId) {
              resumeThreadId = latestSessionId;
            }
            logger.debug(
              {
                resumed: resumeTarget !== undefined,
                threadId: resumeThreadId,
                authFailed,
                resumeTargetGone,
                exitCode: result.exitCode,
              },
              'codex turn boundary (exec run finished)',
            );
            // A failed run still ends the TURN so ChatAgent's turn accounting
            // completes (synthetic result mirrors turn.completed) — and the
            // result carries terminatedReason:'turn_failed' so ChatAgent
            // records FAILURE (like 'stall'), never a masked success; this
            // also covers turn.failed, whose adapter output is error-only
            // and would otherwise leave the turn unresolved forever (#4378
            // error_max_* pitfall, flagged in the S2 review).
            if (!sawTurnTerminator || sawTurnFailed) {
              pushSynthetic({
                type: 'result',
                content: '',
                role: 'assistant',
                ...(runFailed || sawTurnFailed
                  ? { metadata: { terminatedReason: 'turn_failed' } }
                  : {}),
              });
            }
          } finally {
            currentRun = null;
            runActive = false;
            openToolItems = 0;
            clearStallTimers();
            wakeAll();
          }
        };

        // Early-cancel window (S2 review): handle.cancel()/close() called
        // between queryStream() returning and the first next() sees onAbort
        // === null — without this check the consumer would park forever
        // (pi parity: its bridge returns immediately for the same window).
        if (cancelRequested) {
          aborted = true;
          return;
        }

        // ── Input pump: user inputs arrive over the session lifetime ──────
        // Between turns it parks in inputIterator.next(); the input
        // generator ending (chat-agent closes its channel on /reset etc.) is
        // what winds the bridge down.
        let terminated = false;
        const inputIterator = input[Symbol.asyncIterator]();
        void (async () => {
          try {
            while (true) {
              const { value, done } = await inputIterator.next();
              if (done || terminated) {
                return;
              }
              await runInput(userInputText(value));
            }
          } finally {
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
              await new Promise<void>((resolve) => notify.push(resolve));
              continue;
            }
            const message = queue.shift() as AgentMessage;
            // Post-stall events from the dying process must not reach the
            // consumer ahead of the stall terminator (pi part-5 review).
            if (stalled) {
              continue;
            }
            yield message;
          }
          if (stalled) {
            yield {
              type: 'result',
              content: STALL_TERMINATE_NOTICE,
              role: 'system',
              metadata: { terminatedReason: 'stall' },
            };
            return;
          }
        } finally {
          // Teardown: kill any in-flight run; later inputs become no-ops.
          terminated = true;
          currentRun?.abort();
          clearStallTimers();
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
        get sessionId(): string | undefined {
          return latestSessionId;
        },
      },
      iterator: adaptIterator(),
    };
  }

  createInlineTool(_definition: InlineToolDefinition): unknown {
    // Tools/MCP mapping is an open question on #4627 (codex has its own MCP
    // config surface) — deliberately not stubbed half-way.
    throw new Error(
      'CodexAgentProvider: tools/MCP mapping is not supported yet — tracked as an open question on #4627.',
    );
  }

  createMcpServer(_config: McpServerConfig): unknown {
    throw new Error(
      'CodexAgentProvider: tools/MCP mapping is not supported yet — tracked as an open question on #4627.',
    );
  }

  // --------------------------------------------------------------------------
  // Environment checks (S1 fail-fast) + lifecycle
  // --------------------------------------------------------------------------

  /**
   * Check whether the codex CLI binary is on PATH and auth is present.
   * Returns `false` (never throws) — actionable detail in getInfo().
   */
  validateConfig(): boolean {
    if (this.disposed) {
      return false;
    }
    return this.findCodexBinary() !== undefined && this.hasAuth();
  }

  dispose(): void {
    this.disposed = true;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Resolve `codex` on PATH (first executable wins). Sync fs scan instead of
   * `codex --version` — the boolean contract is sync; executing the binary
   * happens in the S2 bridge where failures map onto stream errors.
   */
  private findCodexBinary(): string | undefined {
    const pathValue = this.env.PATH ?? '';
    for (const dir of pathValue.split(delimiter)) {
      if (!dir) {
        continue;
      }
      const candidate = join(dir, this.binaryName());
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  /** Windows needs the .cmd shim; everywhere else the bare name. */
  private binaryName(): string {
    return process.platform === 'win32' ? 'codex.cmd' : 'codex';
  }

  /**
   * Codex home directory: CODEX_HOME if set, else ~/.codex — mirroring the
   * CLI's own resolution so the check agrees with what codex exec reads.
   */
  private codexHome(): string {
    return this.env.CODEX_HOME || join(homedir(), '.codex');
  }

  /** OAuth completed ⇔ auth.json exists under the codex home. */
  private hasAuth(): boolean {
    return existsSync(join(this.codexHome(), AUTH_FILE));
  }
}

/** True when `p` exists and is executable (access throws otherwise). */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
