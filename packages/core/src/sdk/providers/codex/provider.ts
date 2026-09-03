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
 *
 * S4 (#4631): permission gate → sandbox mapping. codex exec is headless
 * (no approval axis), so the disclaude permission policy maps onto the one
 * available axis — sandbox_mode — via sandbox-policy.ts: bypassPermissions
 * → workspace-write, 'default' (ask) → read-only (fail closed), explicit
 * `agent.codexSandbox` override honored, mutation denylist entries cap at
 * read-only, and policies codex cannot honor (WebSearch deny) throw with a
 * clear error instead of silently violating policy.
 *
 * S5 (#4632): quota observability + limit degrade. Every turn.completed
 * usage lands in one structured info log (per-turn + process-wide
 * cumulative, getQuotaStats()); usage-limit failures (isCodexUsageLimit)
 * degrade to a friendly window-reset notice instead of raw exit noise, and
 * the failed turn latches nothing — the anchor survives, so the next
 * message after the window reset resumes the same conversation, no restart.
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { createLogger } from '../../../utils/logger.js';
import { Config } from '../../../config/index.js';
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
import { resolveCodexSandboxPolicy, type CodexSandboxLevel } from './sandbox-policy.js';
import { CodexSessionGovernor } from './session-governor.js';
import {
  adaptCodexEvent,
  classifyCodexEvent,
  isCodexAuthFailure,
  isCodexResumeTargetMissing,
  isCodexUsageLimit,
  userInputText,
  type CodexThreadEvent,
} from './exec-adapter.js';
import {
  discoverBuiltinResources,
  formatCodexBuiltinContext,
  mergeBuiltinResources,
} from './builtin-adapter.js';

const logger = createLogger('CodexAgentProvider');

/** Start a fresh thread before the next turn after a resume reaches this size. */
export const DEFAULT_MAX_RESUME_INPUT_TOKENS = 100_000;

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

/**
 * Friendly usage-limit degrade (#4632, S5): the ChatGPT plan's rolling
 * window (5h + weekly) is spent. Recovers WITHOUT a restart — the failed
 * turn latches nothing, the conversation anchor survives, and the next
 * message after the window reset resumes the same session.
 */
/**
 * Eviction notice (S7, #4634): LRU-governed teardown, delivered as a
 * result with terminatedReason 'evicted' so ChatAgent finishes cleanly and
 * does NOT auto-restart (the evicted chat re-registers lazily on its next
 * message and resumes the stashed thread).
 */
const USAGE_LIMIT_NOTICE =
  '📊 Codex 用量已达上限（ChatGPT 订阅的 5 小时/周滚动窗口限额）。无需重启——窗口重置后直接重发消息即可自动恢复，当前对话上下文会保留。';

/**
 * Process-wide cumulative quota counters (Issue #4632, S5). The provider is
 * a cached singleton per process (factory), so these aggregate across every
 * chatId/stream — the searchable, `/status`-ready view of consumption.
 */
export interface CodexQuotaStats {
  /** Completed turns that carried a usage payload (turn.completed WITH usage). */
  turnsCompleted: number;
  /** Cumulative input tokens (includes the cached portion). */
  inputTokens: number;
  /** Cumulative cached input tokens (cache hits — free-ish on subscription). */
  cachedInputTokens: number;
  /** Cumulative output tokens. */
  outputTokens: number;
  /** Cumulative reasoning output tokens (subset of output). */
  reasoningOutputTokens: number;
}

/** Actionable binary-missing error (thrown synchronously by queryStream). */
const BINARY_MISSING = (pathValue: string): string =>
  `CodexAgentProvider: codex CLI binary not found on PATH "${pathValue}" — install it first: ` +
  '`npm install -g @openai/codex`, then complete `codex login` (Sign in with ChatGPT).';

/** The ChatGPT endpoint rejects this legacy API-style model alias. */
function codexModelForChatGpt(model: string | undefined): string | undefined {
  return model?.trim().toLowerCase() === 'gpt-5.1-codex' ? undefined : model;
}

/**
 * Constructor options — dependency injection seams for tests.
 *
 * `env` controls PATH (binary lookup) and CODEX_HOME (auth lookup); tests
 * inject a fake env pointing at temp fixtures instead of mocking fs/spawn.
 */
export interface CodexAgentProviderOptions {
  /** Environment used for resolution + child spawn. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Per-run codex exec timeout; zero/undefined disables the wall-clock cap. */
  execTimeoutMs?: number;
  /**
   * Explicit sandbox override from `agent.codexSandbox` (Issue #4631, S4).
   * Wins over permissionMode inference; the denylist mutation cap still
   * outranks it (security policy > convenience preference).
   */
  sandboxOverride?: CodexSandboxLevel;
  /** Explicit Codex workspace network policy. Defaults to enabled. */
  networkAccess?: boolean;
  /** Maximum input-token size permitted for a resumed Codex turn. */
  maxResumeInputTokens?: number;
  /**
   * Concurrency governance caps (Issue #4634, S7): max concurrently-alive
   * sessions (queryStreams) and max simultaneously-executing codex exec
   * children per process. Defaults in session-governor.ts (3 / 2).
   */
  maxActiveSessions?: number;
  maxConcurrentRuns?: number;
  /** Override builtin resource root for tests/embedded deployments. */
  builtinsDir?: string;
}

/** The file Codex CLI writes after a successful `codex login` (OAuth). */
const AUTH_FILE = 'auth.json';

export class CodexAgentProvider implements IAgentSDKProvider {
  readonly name = 'codex';
  readonly version = '0.6.0-forget-session';

  private readonly env: Record<string, string | undefined>;
  private readonly execTimeoutMs: number | undefined;
  private readonly sandboxOverride: CodexSandboxLevel | undefined;
  private readonly networkAccess: boolean;
  private readonly maxResumeInputTokens: number;
  private readonly builtinRoot: string;
  /** Cumulative quota counters (S5, #4632) — see CodexQuotaStats. */
  private readonly quota: CodexQuotaStats = {
    turnsCompleted: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  /**
   * Process-wide session/run governor (S7, #4634). The provider is a cached
   * singleton per process (factory), so its caps bound the whole process.
   */
  private readonly governor: CodexSessionGovernor;
  /**
   * Evicted-session thread stash (S7): sessionKey → thread_id, written ONLY
   * by the eviction hook. An evicted chat's next queryStream resumes its
   * codex conversation instead of losing context. Normal teardown (user
   * /reset, idle GC) deliberately does NOT stash — reset means reset.
   */
  private readonly threadStash = new Map<string, string>();
  /** Anonymous-stream key counter (queryStream without options.sessionKey). */
  private anonSessionCounter = 0;

  private disposed = false;

  constructor(options: CodexAgentProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.execTimeoutMs = options.execTimeoutMs;
    this.sandboxOverride = options.sandboxOverride;
    this.networkAccess = options.networkAccess ?? true;
    this.maxResumeInputTokens = options.maxResumeInputTokens ?? DEFAULT_MAX_RESUME_INPUT_TOKENS;
    this.builtinRoot = options.builtinsDir ?? Config.getBuiltinsDir();
    this.governor = new CodexSessionGovernor({
      maxActiveSessions: options.maxActiveSessions,
      maxConcurrentRuns: options.maxConcurrentRuns,
    });
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
        'codex CLI binary not found on PATH — install it first: `npm install -g @openai/codex` (https://developers.openai.com/codex/cli)'
      );
    }
    if (!this.hasAuth()) {
      problems.push(
        'Codex auth missing (OAuth not completed) — run `codex login` (Sign in with ChatGPT); set CODEX_HOME if it is installed elsewhere'
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

  /**
   * Cumulative quota counters for this process (Issue #4632, S5) —
   * turn/token consumption across every chatId, ready for /status wiring.
   * Returns a copy; the caller cannot mutate provider state.
   */
  getQuotaStats(): Readonly<CodexQuotaStats> {
    return { ...this.quota };
  }

  /**
   * Session/run governance snapshot for this process (Issue #4634, S7):
   * active sessions, running/queued exec children, eviction count, caps.
   * /status-ready; also the runtime admin surface via setGovernanceLimits.
   */
  getGovernanceStats() {
    return this.governor.getStats();
  }

  /** Runtime cap change (admin/test surface, Issue #4634). */
  setGovernanceLimits(limits: { maxActiveSessions?: number; maxConcurrentRuns?: number }): void {
    this.governor.setLimits(limits);
  }

  /**
   * Forget a chat's provider-side session state (Issue #4644) — the optional
   * capability ChatAgent / the agent pool invoke on /reset.
   *
   * Clears BOTH:
   * - the governor registration, so the session can never be LRU-evicted
   *   later (the eviction hook would re-stash the anchor AFTER this clear —
   *   resurrecting the reset-away conversation, the #4644 window);
   * - the evicted-thread stash, so the chat's next stream starts a fresh
   *   codex conversation even when no stream was alive at reset time (the
   *   stream-teardown stash-clear only covers non-evicted streams).
   *
   * Idempotent; unknown keys are a no-op.
   */
  forgetSession(sessionKey: string): void {
    const hadRegistration = this.governor.forgetSession(sessionKey);
    const hadStash = this.threadStash.delete(sessionKey);
    if (hadRegistration || hadStash) {
      logger.info(
        { sessionKey, hadRegistration, hadStash },
        'codex session forgotten on reset — governor registration + evicted-thread stash cleared (Issue #4644)'
      );
    }
  }

  // --------------------------------------------------------------------------
  // Query — Issue #4630 (S2): codex exec subprocess bridge
  // --------------------------------------------------------------------------

  queryStream(input: AsyncGenerator<UserInput>, options: AgentQueryOptions): StreamQueryResult {
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

    // Permission gate → sandbox level (Issue #4631, S4): resolved once per
    // stream (options are constant across turns); throws synchronously with
    // an actionable message when the policy cannot be honored headlessly
    // (e.g. a WebSearch denylist entry) — same fail-fast contract as the
    // binary check above.
    const sandboxDecision = resolveCodexSandboxPolicy(options, this.sandboxOverride);
    logger.info(
      {
        sandbox: sandboxDecision.sandbox,
        reasons: sandboxDecision.reasons,
      },
      'codex sandbox policy resolved (Issue #4631): permission gate → codex exec sandbox'
    );

    const runner = new CodexExecRunner({
      binary,
      timeoutMs: this.execTimeoutMs,
      networkAccess: this.networkAccess,
    });
    const codexModel = codexModelForChatGpt(options.model);
    if (options.model && codexModel === undefined) {
      logger.warn(
        { configuredModel: options.model },
        'ignoring legacy gpt-5.1-codex model for ChatGPT-backed Codex; using the CLI default'
      );
    }
    // Captured at queryStream call time — the constructor-injected env the
    // binary was resolved from (tests: PATH fixtures; prod: process.env).
    const providerEnv = this.env;
    // Codex has no Claude local-plugin option. Pass a compact, capability-
    // aware builtin index in the prompt; the actual Markdown remains on disk
    // and is read only when the model chooses a resource.
    // Test/one-shot callers without a workspace do not have a safe base from
    // which Codex can read the referenced files; normal agent calls always
    // provide cwd through BaseAgent.
    // The provider is cached across chats, so the request cwd is the source of
    // truth for project-local skills. Include the packaged index as well; the
    // merge keeps the common case (cwd == builtinRoot) free of duplicates.
    const thisBuiltinContext = options.cwd
      ? formatCodexBuiltinContext(
          mergeBuiltinResources(
            discoverBuiltinResources(resolve(options.cwd)),
            // Claude Code projects conventionally keep local resources under
            // `.claude/skills` and `.claude/agents`; treat that directory as a
            // second workspace root while retaining the existing root-level
            // `skills/` and `agents/` layout.
            discoverBuiltinResources(join(resolve(options.cwd), '.claude')),
            discoverBuiltinResources(this.builtinRoot)
          )
        )
      : '';
    // Instance-level quota sink (S5, #4632): the bridge closures below are
    // `this: void`, so they aggregate through this captured reference.
    const quotaSink = this.quota;
    const resumeBudgetSink = {
      maxResumeInputTokens: this.maxResumeInputTokens,
      resumeFreshNextTurn: false,
    };
    // Same capture for the S7 governor + stash (this: void closures below).
    const governorSink = this.governor;
    const stashSink = this.threadStash;
    const timeoutLabel =
      this.execTimeoutMs && this.execTimeoutMs > 0
        ? `${this.execTimeoutMs}ms`
        : 'disabled (default)';

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
    // S7 exception: an EVICTED session's anchor is stashed (see below) so
    // the same chat resumes its conversation after eviction.
    let resumeThreadId: string | undefined;

    // ── Session governance (S7, #4634) ──────────────────────────────────
    // One queryStream = one codex session. Anonymous streams (no
    // options.sessionKey) get a unique key so they still count toward the
    // cap — only their LRU identity is unknown. The eviction hook runs in
    // the VICTIM's closure: stash its conversation anchor (consumed by this
    // chat's next queryStream) and abort via the same path as user cancel.
    const sessionKey = options.sessionKey ?? `anon-${++this.anonSessionCounter}`;
    // Anonymous streams (no options.sessionKey — one-shot runOnce queries)
    // never resume, so stashing their anchor would leak the map forever.
    const stashable = options.sessionKey !== undefined;
    let wasEvicted = false;
    const stashedThread = stashable ? this.threadStash.get(sessionKey) : undefined;
    this.threadStash.delete(sessionKey); // consume-on-read: /reset after an eviction-resume must not resurrect the old thread later
    resumeThreadId = stashedThread;
    const registration = this.governor.registerSession(sessionKey, {
      evict: () => {
        wasEvicted = true;
        if (resumeThreadId && stashable) {
          this.threadStash.set(sessionKey, resumeThreadId);
        }
        logger.warn(
          { sessionKey, stashed: Boolean(resumeThreadId && stashable) },
          'codex session evicted (session cap reached) — thread anchor stashed; the chat resumes its conversation on the next message (Issue #4634)'
        );
        requestAbort();
      },
    });
    if (registration.evictedKey) {
      logger.info(
        { evictedKey: registration.evictedKey, sessionKey },
        'codex session cap reached — evicted the idlest session (LRU, #4634)'
      );
    }

    const adaptIterator = async function* (this: void): AsyncGenerator<AgentMessage> {
      // ── Event bridge state (pi #4386 part 3 pattern) ──────────────────
      const queue: AgentMessage[] = [];
      // Codex normally emits one completed event per item, but retries or
      // reconnects can replay a completed item. Do not send duplicate
      // assistant/tool content to the channel.
      const deliveredEventKeys = new Set<string>();
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
        const parsed = Number.parseInt(process.env.DISCLAUDE_STALL_TIMEOUT_MS ?? '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000;
      })();
      const STALL_FORCE_CLOSE_GRACE_MS = (() => {
        const parsed = Number.parseInt(process.env.DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS ?? '', 10);
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
      let runFailureText = '';
      const armTimer = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
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
            'killing the codex process (Issue #4630, cf. #3706)'
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
        if (event.type === 'turn.started') {
          // Item IDs are scoped to a Codex turn; a resumed turn may reuse
          // the same fixture/runtime ID, so dedupe only within one turn.
          deliveredEventKeys.clear();
        }
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
        } else if (event.type === 'turn.completed' || event.type === 'turn.failed') {
          sawTurnTerminator = true;
          if (event.type === 'turn.completed') {
            sawTurnCompleted = true;
            if (event.usage) {
              // ── Quota observability (S5, #4632) ───────────────────────
              // Accumulate + log AT the event (no cross-closure state):
              // one structured info line per completed turn with per-turn
              // and process-wide cumulative fields (full-content logging
              // guideline). No USD — a subscription has no per-call price.
              const { usage } = event;
              quotaSink.turnsCompleted += 1;
              quotaSink.inputTokens += usage.input_tokens ?? 0;
              quotaSink.cachedInputTokens += usage.cached_input_tokens ?? 0;
              quotaSink.outputTokens += usage.output_tokens ?? 0;
              quotaSink.reasoningOutputTokens += usage.reasoning_output_tokens ?? 0;
              logger.info(
                {
                  threadId: latestSessionId,
                  resumed: resumeThreadId !== undefined,
                  inputTokens: usage.input_tokens,
                  cachedInputTokens: usage.cached_input_tokens,
                  outputTokens: usage.output_tokens,
                  reasoningOutputTokens: usage.reasoning_output_tokens,
                  cumulative: { ...quotaSink },
                },
                'codex quota usage (turn.completed)'
              );
              if (
                event.usage.input_tokens !== undefined &&
                event.usage.input_tokens >= resumeBudgetSink.maxResumeInputTokens
              ) {
                resumeBudgetSink.resumeFreshNextTurn = true;
                logger.warn(
                  {
                    inputTokens: event.usage.input_tokens,
                    maxResumeInputTokens: resumeBudgetSink.maxResumeInputTokens,
                    threadId: latestSessionId,
                  },
                  'codex resume input budget reached — next turn will start a fresh session'
                );
              }
            }
          } else {
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
          runFailureText += `\n${event.error?.message ?? ''}`;
        }
        touchStallWatchdog();
        const presentation = classifyCodexEvent(event);
        logger.debug({ eventType: event.type, presentation }, 'codex JSONL event classified');
        const adapted = adaptCodexEvent(event);
        if (adapted) {
          const messageId = adapted.metadata?.messageId;
          const eventKey = messageId ? `${adapted.type}:${messageId}` : undefined;
          if (eventKey && deliveredEventKeys.has(eventKey)) {
            logger.debug({ eventKey }, 'skipping duplicate Codex event');
            wakeAll();
            return;
          }
          if (eventKey) {
            deliveredEventKeys.add(eventKey);
          }
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
      // S7 (#4634): each run holds a global lease — at most
      // maxConcurrentRuns codex exec children process-wide; excess turns
      // queue FIFO across chats with a backpressure notice.
      const runInput = async (prompt: string): Promise<void> => {
        // Item IDs are scoped to one exec invocation. Clear before every
        // run because older Codex versions (and test doubles) may omit
        // `turn.started` on resumed executions.
        deliveredEventKeys.clear();
        const resumeTarget = resumeBudgetSink.resumeFreshNextTurn ? undefined : resumeThreadId;
        if (resumeThreadId !== undefined && resumeTarget === undefined) {
          resumeBudgetSink.resumeFreshNextTurn = false;
          logger.info(
            {
              previousThreadId: resumeThreadId,
              maxResumeInputTokens: resumeBudgetSink.maxResumeInputTokens,
            },
            'starting fresh codex session after resume input budget was reached'
          );
        }
        governorSink.touchSession(sessionKey);
        // Backpressure UX (#4634): announce the wait BEFORE it happens —
        // never silence. (Also announce when merely joining the queue.)
        const pre = governorSink.getStats();
        if (pre.runningRuns >= pre.maxConcurrentRuns || pre.queuedRuns > 0) {
          pushSynthetic({
            type: 'status',
            content:
              `⏳ Codex 并发已满（${pre.runningRuns}/${pre.maxConcurrentRuns} 运行中）` +
              `——排队等候，前面还有 ${pre.queuedRuns} 个任务…`,
            role: 'assistant',
          });
        }
        const lease = await governorSink.acquireRun();
        if (aborted || terminated) {
          // Cancelled/finished while queued — don't spawn a zombie run.
          lease.release();
          return;
        }
        runActive = true;
        sawTurnTerminator = false;
        sawTurnFailed = false;
        sawTurnCompleted = false;
        runFailureText = '';
        touchStallWatchdog();
        const { promise, handle } = runner.run(
          {
            prompt: thisBuiltinContext
              ? `${thisBuiltinContext}\n\nUser request:\n${prompt}`
              : prompt,
            resumeSessionId: resumeTarget,
            sandboxMode: sandboxDecision.sandbox,
            cwd: options.cwd,
            model: codexModel,
            env: { ...providerEnv, ...options.env },
            stderr: options.stderr,
          },
          enqueue
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
          // Failure-signature detection (#4628/#4632, review hardened):
          // - gated on runFailed — a SUCCESSFUL turn (exit 0 + terminator)
          //   must never be followed by a spurious 401/limit notice just
          //   because stderr carries unrelated text (e.g. an MCP server's
          //   own 401 noise, or retry-and-recover 429 lines codex leaves
          //   on stderr);
          // - per-surface: a conjunction must hit WITHIN the raw-events
          //   text OR within stderr, not across the splice of the two.
          const runFailed =
            Boolean(result.spawnError) ||
            result.timedOut ||
            result.exitCode !== 0 ||
            !sawTurnTerminator;
          const authFailed =
            runFailed &&
            (isCodexAuthFailure(runFailureText) || isCodexAuthFailure(result.stderrTail));
          const usageLimited =
            runFailed &&
            (isCodexUsageLimit(runFailureText) || isCodexUsageLimit(result.stderrTail));
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
          } else if (usageLimited) {
            // Friendly degrade (#4632): quote codex's own reset hint when
            // present. Anchored to `try again (at|in)` — a bare "try
            // again later" from unrelated stderr must not displace the
            // real timestamp, and `[^.\n]+` after (at|in) tolerates
            // decimals ("in 2.5 hours"). The failed turn latches nothing,
            // so the conversation anchor survives into the next window —
            // recovery needs no restart, only a resend after the reset.
            const resetHint =
              /try again (?:at|in) [^.\n]+/i.exec(runFailureText)?.[0] ??
              /try again (?:at|in) [^.\n]+/i.exec(result.stderrTail)?.[0];
            pushSynthetic({
              type: 'error',
              content: resetHint
                ? `${USAGE_LIMIT_NOTICE}\n上游提示: ${resetHint}`
                : USAGE_LIMIT_NOTICE,
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
              'codex resume target missing (no rollout found); cleared — next turn starts a fresh session (Issue #4628)'
            );
            pushSynthetic({
              type: 'error',
              content: RESUME_TARGET_GONE_NOTICE,
              role: 'assistant',
            });
          } else if (result.exitCode !== 0) {
            pushSynthetic({
              type: 'error',
              content: `codex exec exited with code ${result.exitCode}${
                result.stderrTail ? `: ${result.stderrTail.trim().slice(-500)}` : ''
              }`,
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
            'codex turn boundary (exec run finished)'
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
          // Release the run lease FIRST so the longest-queued run starts
          // before this turn's post-processing finishes; touch AFTER so a
          // session finishing a long run is never LRU-evicted as "idlest"
          // based on its stale start timestamp (S7 review).
          lease.release();
          governorSink.touchSession(sessionKey);
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
        if (wasEvicted) {
          // Governance teardown, not an error: a clean terminator with
          // terminatedReason 'evicted' tells ChatAgent to finish WITHOUT
          // auto-restarting — the victim re-registers on its next message
          // (and resumes the stashed thread). Without this, the restart
          // loop re-registered the SAME sessionKey while still at cap and
          // cascaded evictions into the circuit breaker (S7 review high).
          // The termination marker is intentionally content-free: LRU
          // eviction is an internal lifecycle event, not user-facing
          // progress. ChatAgent still receives the marker and can resolve
          // the turn without restarting it.
          yield {
            type: 'result',
            content: '',
            role: 'system',
            metadata: { terminatedReason: 'evicted' },
          };
          return;
        }
      } finally {
        // Teardown: kill any in-flight run; later inputs become no-ops.
        // Normal teardown unregisters the session WITHOUT stashing its
        // anchor — /reset means reset (stash happens only on eviction).
        terminated = true;
        currentRun?.abort();
        clearStallTimers();
        registration.unregister();
        if (!wasEvicted && stashable) {
          // Normal teardown (user /reset, idle GC, stream end): drop any
          // stash residue for this key so a later stream for the same
          // chat never resumes a conversation the user reset away
          // (S7 review — the eviction-window /reset hole).
          stashSink.delete(sessionKey);
        }
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
      'CodexAgentProvider: tools/MCP mapping is not supported yet — tracked as an open question on #4627.'
    );
  }

  createMcpServer(_config: McpServerConfig): unknown {
    throw new Error(
      'CodexAgentProvider: tools/MCP mapping is not supported yet — tracked as an open question on #4627.'
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
