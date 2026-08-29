/**
 * Codex CLI Agent Provider (Issue #4629 skeleton + #4630 exec bridge).
 *
 * S1 (#4629): registry/config/validation — fail-fast environment checks
 * (binary on PATH, OAuth auth.json under CODEX_HOME).
 * S2 (#4630): queryStream — each user input spawns one `codex exec --json`
 * subprocess (codex-runner.ts) whose JSONL ThreadEvents are adapted
 * (exec-adapter.ts) onto the unified AgentMessage stream. The bridge mirrors
 * the pi queryStream architecture (#4386 part 3/5): queue+wake consumer
 * loop, detached input pump, and the shared no-content-progress stall
 * watchdog seam (#4550 pattern, env-tunable DISCLAUDE_STALL_TIMEOUT_MS).
 *
 * Session semantics: S2 runs are STATELESS per turn (`--ephemeral`) —
 * multi-turn continuity via `codex exec resume` lands in S3 (#4628), which
 * will also consume the thread_id captured from thread.started onto
 * handle.sessionId here.
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
  type CodexExecRunHandle,
  type CodexExecRunResult,
} from './codex-runner.js';
import {
  adaptCodexEvent,
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
  readonly version = '0.1.0-exec-bridge';

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
      : 'the default timeout';

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

    // thread.started → handle.sessionId (consumed by S3 resume, #4628).
    let latestSessionId: string | undefined;

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
        const armTimer = (
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
          }
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
        const runInput = async (prompt: string): Promise<void> => {
          runActive = true;
          sawTurnTerminator = false;
          touchStallWatchdog();
          const { promise, handle } = runner.run(
            {
              prompt,
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
            if (result.spawnError) {
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
            // A failed run still ends the TURN so ChatAgent's turn accounting
            // completes (synthetic result mirrors turn.completed).
            if (!sawTurnTerminator) {
              pushSynthetic({ type: 'result', content: '', role: 'assistant' });
            }
          } finally {
            currentRun = null;
            runActive = false;
            openToolItems = 0;
            clearStallTimers();
            wakeAll();
          }
        };

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
