/**
 * ChatAgent - Platform-agnostic direct chat abstraction with Streaming Input.
 *
 * Issue #644: Refactored to ensure complete isolation between chat sessions.
 * Each ChatAgent instance is bound to a single chatId at construction time.
 *
 * Issue #697: Extracted types and message builder to separate modules.
 *
 * Key Features:
 * - Streaming Input Mode: Uses SDK's streamInput() for real-time message delivery
 * - Single chatId binding: Each ChatAgent serves exactly one chatId
 * - Persistent Context: Session context persists until manual reset (/reset) or shutdown
 *
 * Architecture (Issue #644):
 * ```
 * AgentPool
 *     └── Map<chatId, ChatAgent>
 *             └── Each ChatAgent handles ONE chatId only
 *                     └── Single Query + Channel pair
 * ```
 *
 * Separation of Concerns:
 * - ConversationOrchestrator: Thread root and context tracking
 * - RestartManager: Restart policy and circuit breaker
 * - MessageBuilder: Enhanced content building (Issue #697)
 * - ChatAgent: Orchestration, callbacks, and main logic flow
 *
 * Extends BaseAgent to inherit:
 * - SDK configuration building
 * - Iterator timeout handling
 * - GLM logging
 * - Error handling
 *
 * Issue #2717: Migrated from @disclaude/worker-node to @disclaude/service.
 * Agents live with the service that owns their lifecycle.
 */

import {
  BaseAgent,
  MessageBuilder,
  MessageChannel,
  RestartManager,
  ConversationOrchestrator,
  EmptyTurnRetryPolicy,
  getErrorStderr,
  isStartupFailure,
  tagErrorCategory,
  StreamingReplyDriver,
  TurnSupersededError,
  type StreamingUserMessage,
  type QueryHandle,
  type ChatAgent as ChatAgentInterface,
  type AgentUserInput,
  type AgentMessage,
  type IteratorYieldResult,
  type UserMessageParams,
  type CwdResolution,
} from '@disclaude/core';
import { getDebugGroupService } from '../services/debug-group-service.js';
import type { ChatAgentCallbacks, ChatAgentConfig } from './types.js';
import { buildDisallowedTools } from './disallowed-tools.js';
import { HistoryManager } from './history-manager.js';
import crypto from 'node:crypto';

// Type alias for backward compatibility within this module
type UserInput = AgentUserInput;

function sanitizeLifecycleReason(reason: unknown): string {
  return String(reason).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 240);
}

// Re-export types for backward compatibility
export type { ChatAgentCallbacks, ChatAgentConfig, MessageData } from './types.js';

/**
 * Issue #4626: consecutive user-visible send failures tolerated before the
 * per-session delivery circuit opens. Transient channel trouble (5xx / network)
 * gets a small retry budget; 4xx opens the circuit immediately (see
 * {@link extractSendHttpStatus}).
 */
const MAX_CONSECUTIVE_SEND_FAILURES = 3;

/**
 * Issue #4626: best-effort HTTP status extraction from a channel send error.
 *
 * The Feishu/lark SDK surfaces axios-style errors where the status lives on
 * `.response.status` (see extractFeishuApiError in feishu-channel.ts for the
 * full body-shape normalization); other channels may set `.status` directly.
 * `undefined` means no status is known (network error / bare Error) — callers
 * treat that as transient.
 */
function extractSendHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }
  const e = err as { response?: { status?: unknown }; status?: unknown };
  const status = e.response?.status ?? e.status;
  return typeof status === 'number' ? status : undefined;
}

/** Feishu business error 230025 means content size, not an invalid target. */
function isOversizedFeishuMessageError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { response?: { data?: { code?: unknown } }; code?: unknown };
  return Number(e.response?.data?.code ?? e.code) === 230025;
}

/**
 * Issue #4649 (review ③): one turn-completion entry per accepted channel
 * push. `settle` resolves on no error / rejects with one; `settled` gates
 * settlement to exactly once and lets resolveTurn skip already-finished
 * entries that linger for late awaiters (see turnCompleteFor).
 */
interface TurnCompletionEntry {
  promise: Promise<void>;
  settle: (error?: Error) => void;
  settled: boolean;
}

/**
 * Issue #4649 (review ③): bound on the turn-completion registry, mirroring
 * the pendingTurnAnchors bound — a parked/dead session with no iterator
 * draining must not grow either structure unboundedly.
 */
const MAX_TURN_COMPLETIONS = 50;

// 2026-09-08: mid-stream 中断自动续跑(诊断见 ./docs 之外 —— ES 双侧证据:agent「同一
// tool use 后中断」= 续写调用在 200 已锁后静默,proxy 只能补「看似成功」的收尾)。
// MIDSTREAM_MARKER —— proxy(litellm custom_callbacks._MIDSTREAM_INTERRUPT_MARKER)在
// mid-stream 恢复补发的正文里带的标记;两端必须逐字节一致。下游收到它 = 本 turn 实际被
// 上游截断,而非一次正常完成的 turn(stop_reason 不可靠:SDK 在 tool_use→stall 双 turn
// 聚合后不回传 proxy 补发的 end_turn)。标记原样成为 assistant 正文到达本层。
const MIDSTREAM_MARKER = '[proxy:midstream-interrupted]';
// 续跑 nudge 的投递延迟:须大于该 deployment 的冷却 TTL(proxy 对 IdleWatchdog 死亡冷却
// deployment 180s 且 enable_pre_call_checks 会让冷却期内新请求直接失败),否则 nudge 撞在
// 冷却路上立刻报错。默认 200s ≈ cooldown 180s + margin。env 可调(运行时读取,测试可控)。
function midstreamRetryDelayMs(): number {
  const v = Number.parseInt(process.env.DISCLAUDE_MIDSTREAM_RETRY_DELAY_MS ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 200_000;
}

/**
 * ChatAgent - Platform-agnostic direct chat abstraction with Streaming Input.
 *
 * Issue #644: Each ChatAgent instance is bound to a single chatId.
 * No session management needed - each ChatAgent = one chatId.
 */
export class ChatAgent extends BaseAgent implements ChatAgentInterface {
  /** Agent type identifier (Issue #282) */
  readonly type = 'chat' as const;

  /** Agent name for logging */
  readonly name = 'ChatAgent';

  /** The chatId this ChatAgent is bound to (Issue #644) */
  private readonly boundChatId: string;
  private readonly sdkSessionKey: string;

  /**
   * Callbacks for sending responses to the channel.
   * Updated per-message to support multi-channel routing (Issue #3776).
   */
  private callbacks: ChatAgentCallbacks;

  // Issue #1916: Dynamic cwd resolution for project-scoped Agent context switching
  private readonly cwdProvider?: (chatId: string) => string | undefined;

  // Issue #4448 (direction #1): structured cwd resolution — same inputs as
  // cwdProvider but distinguishes unbound from bound-missing, so the workspace
  // fallback can be surfaced to the user instead of only logger.warn.
  private readonly cwdResolver?: (chatId: string) => CwdResolution;

  // Issue #4448 (nit): the bound-missing target already warned to this chat
  // (per agent instance), so restart cycles don't re-announce the same missing
  // directory. Cleared when the binding resolves cleanly again.
  private warnedMissingWorkingDir?: string;

  // Single Query and Channel for this chatId (Issue #644: no longer using SessionManager)
  private queryHandle?: QueryHandle;
  private channel?: MessageChannel;
  private isSessionActive = false;

  // Issue #3985: Track whether the agent is actively processing a user message.
  // Unlike isSessionActive (which stays true as long as the agent loop is open),
  // this flag is true only between receiving a user message and receiving the
  // corresponding `result` from the SDK. This allows the scheduler to distinguish
  // between "session exists but idle" and "actively processing a message".
  private isProcessingMessage = false;

  // Issue #4620: When the current turn started (ms epoch), set at the same
  // moment isProcessingMessage flips true. Lets the pool's busy-turn cap
  // measure the CURRENT turn, not the accumulated wall-clock of many
  // back-to-back turns (the observation-based busySince marker survived
  // turn boundaries whenever every sweep tick landed mid-turn).
  private turnStartedAtMsPrivate = 0;
  /** Message identity of the turn currently consumed by the persistent iterator. */
  private activeTurnMessageId?: string;

  // Issue #3706 (GLM stall): set when the provider's no-content-progress watchdog
  // terminated the stream. Checked at the iterator-end/restart decision point to
  // suppress the auto-restart (would immediately re-stall) while keeping context.
  private stalledTerminated = false;

  // Issue #4442 (part 3): set when the provider terminated the stream with the
  // synthetic empty-stream result (200-OK-zero-content after in-request retries
  // exhausted). Same interception role as stalledTerminated: suppress the
  // unexpected-end auto-restart while keeping context — the failure is already
  // accounted via recordFailure('empty-stream') in the result branch.
  private emptyStreamTerminated = false;

  // Issue #4391 (part 2 review): ChatAgent's own disposed marker. BaseAgent's
  // `initialized` is never set to true on any production path (only test mocks
  // force it), so a `!this.initialized` disposed-check would be dead in
  // production. Set synchronously at the top of dispose() so a replay timer
  // racing an in-flight dispose sees it.
  private disposed = false;

  // Issue #4391 (part 2 review): bumped on every startAgentLoop() and reset().
  // Lets a processIterator invocation detect that its session was torn down
  // and superseded mid-flight (empty-turn reset+replay) — see the interception
  // next to the stalledTerminated check in processIterator.
  private sessionGeneration = 0;
  private readonly stoppedQueryGenerations = new Set<number>();

  // Issue #4626: user-visible delivery isolation state. A channel sendMessage
  // failure (invalid receive_id → 400, transient 5xx, network blip) used to
  // propagate out of the for-await loop in processIterator → "Iterator error"
  // → "Agent loop error" → session teardown, killing healthy in-flight work
  // (a scheduled audit ran 38 days silently dead on one typo'd chatId).
  // Both fields are session-scoped: reset on every startAgentLoop().
  private consecutiveSendFailures = 0;
  private sendCircuitOpen = false;
  private activeLifecycleContext?: NonNullable<StreamingUserMessage['correlation']>;
  private pendingLifecycleContexts: Array<NonNullable<StreamingUserMessage['correlation']>> = [];
  private didDeliverUserVisibleThisTurn = false;

  // Issue #4391 (#4194 follow-up ②): empty-turn session-reset + bounded replay.
  // The policy locks eligibility (real-user messages only — synthetic sched-*/push_*
  // IDs are never replayed, they are not valid reply roots) and bounding (exactly
  // one retry per chat until a successful turn resets it). See
  // packages/core/src/agents/empty-turn-retry-policy.ts (part 1) and
  // docs/designs/empty-turn-session-reset-design.md.
  private readonly emptyTurnRetryPolicy = new EmptyTurnRetryPolicy();

  // Issue #4391: the params of the most recent processMessage() call (the turn
  // currently in flight once pushed). Stashed for EVERY message — synthetic
  // included — because eligibility is decided from its messageId by the policy
  // (a synthetic turn must not replay an older stashed real message either).
  private lastTurnMessage?: UserMessageParams;

  // Issue #4391: monotonically increasing sequence stamped on each
  // processMessage() call. A scheduled replay captures the seq at schedule time
  // and is dropped if a newer message arrived in between — the replay must
  // never clobber or reorder behind the user's newer input.
  private messageSeq = 0;

  // 2026-09-08: mid-stream 上游中断的同会话自动续跑预算。语义 = 「每个健康间隙一次」:
  // recordSuccess 重新武装(置 true);本次续跑消耗后置 false → 同一健康间隙内再次中断
  // 只发 ❌ 不再续(防 ark 持续故障时空转)。once-mode(计划任务)turn 后 channel 即关,
  // 无人在看且续跑 nudge 会撞「消息未送达」噪音 → 这类一律发 ❌,由调度方决定重投。
  private midstreamAutoRetryAvailable = true;

  // Issue #2926: AbortController for immediate stop/reset of running Agent loop
  private abortController: AbortController | null = null;

  // Managers for separated concerns
  private readonly conversationOrchestrator: ConversationOrchestrator;
  private readonly restartManager: RestartManager;

  // Message builder (Issue #697)
  private readonly messageBuilder: MessageBuilder;

  // History loading (Issue #955, #1230, #3996) — extracted into HistoryManager (Issue #4125 part 2)
  private readonly historyManager: HistoryManager;

  /**
   * Chat type for the current conversation (e.g., 'p2p', 'group', 'topic').
   * Updated on each processMessage() call. Issue #3641.
   */
  private chatType?: string;

  /**
   * Issue #4587 (part 1, review fix): FIFO of reply anchors for user messages
   * pushed onto the CURRENT session's channel but not yet consumed by an SDK
   * turn. Entry order = push order; `undefined` entries (plain-group /
   * synthetic messages) keep their slot so turn↔message pairing stays aligned.
   *
   * Why a queue and not a single field: one processIterator (session) serves
   * MANY turns. processMessage(B) runs synchronously even while A's turn is
   * mid-flight (no busy-gating on the user path), so any single mutable
   * "current anchor" field is overwritten by B before A's tail outputs are
   * emitted — re-introducing exactly the cross-thread hijack part 1 set out
   * to fix (A's reply landing in B's thread). The iterator instead consumes
   * one anchor per turn at the turn's first event (see processIterator), so
   * each turn replies into its own thread even with interleaved arrivals.
   *
   * Reset on startAgentLoop (fresh session) and reset(); bounded to avoid
   * unbounded growth if turns never drain (iterator parked/dead session).
   */
  private pendingTurnAnchors: (string | undefined)[] = [];

  // Issue #4808: keep turn identity alongside the reply anchor so completion
  // settlement can target the message whose turn actually ended.
  private pendingTurnMessageIds: string[] = [];

  // Issue #3124: One-shot mode & task completion
  // When onceMode is true, processIterator closes the channel after the first
  // `result` message and resolves the completion promise, enabling blocking
  // one-shot execution via processMessage + taskComplete.
  private onceMode = false;
  private taskCompletionPromise?: Promise<void>;
  private taskCompletionResolve?: () => void;
  private taskCompletionReject?: (error: Error) => void;

  // Issue #4063 / #4649 (review ③): per-MESSAGE turn-completion registry
  // (works in persistent mode, unlike taskComplete). One entry per accepted
  // channel push, keyed by messageId, insertion-ordered. See
  // createTurnCompletion for why this is a registry and not the pre-#4649
  // single slot.
  private readonly turnCompletions = new Map<string, TurnCompletionEntry>();

  constructor(config: ChatAgentConfig) {
    super(config);

    // Issue #644: Bind chatId at construction time
    this.boundChatId = config.chatId;
    this.sdkSessionKey = config.sdkSessionKey ?? config.chatId;
    this.callbacks = config.callbacks;
    this.cwdProvider = config.cwdProvider;
    // Issue #4448 (direction #1)
    this.cwdResolver = config.cwdResolver;

    // Initialize history manager (Issue #955, #1230, #3996)
    this.historyManager = new HistoryManager({
      chatId: this.boundChatId,
      logger: this.logger,
      callbacks: this.callbacks,
    });
    // Issue #3696: skip history loading when --no-context was used
    if (config.skipHistory) {
      this.historyManager.markSkipped();
    }

    // Initialize managers
    this.conversationOrchestrator = new ConversationOrchestrator({ logger: this.logger });
    this.restartManager = new RestartManager({
      logger: this.logger,
      maxRestarts: 3,
      initialBackoffMs: 5000, // Start with 5 seconds
      maxBackoffMs: 60000, // Max 1 minute
    });

    // Initialize message builder with channel-specific options (Issue #697, #1492, #1499)
    // When messageBuilderOptions is provided (e.g., by service), use those;
    // otherwise, create a default MessageBuilder with no channel-specific extensions.
    this.messageBuilder = new MessageBuilder(config.messageBuilderOptions);

    this.logger.info(
      { chatId: this.boundChatId, skipHistory: config.skipHistory },
      'ChatAgent created for chatId'
    );
  }

  /**
   * Update the callbacks used by this agent.
   *
   * Called by ChatSessionPool when an existing agent receives a message
   * from a different channel than the one that created it. This ensures
   * responses are routed to the correct channel.
   *
   * Issue #3776: Without this, REST Channel responses go to Feishu
   * (or whichever channel created the agent first), causing HTTP timeouts.
   *
   * **Concurrency safety**: When the agent is actively processing a query
   * (taskCompletionPromise is set), the update is deferred by queueing
   * a microtask that re-applies the new callbacks once the current query
   * completes. This prevents mid-query callback switching which could
   * route partial responses to the wrong channel.
   *
   * @param callbacks - New callbacks matching the current message's channel
   * @returns true if callbacks were applied immediately, false if deferred
   */
  updateCallbacks(callbacks: ChatAgentCallbacks): boolean {
    if (!this.taskCompletionPromise) {
      // Agent is idle — safe to update immediately
      this.callbacks = callbacks;
      return true;
    }

    // Agent is busy — defer update until current query completes.
    // Use .then() to re-apply once the running task finishes, ensuring
    // the next query uses the new callbacks without disrupting the current one.
    this.logger.info(
      { chatId: this.boundChatId },
      'Agent is busy, deferring callback update until current query completes'
    );
    const pendingCallbacks = callbacks;
    void this.taskCompletionPromise
      .catch(() => {}) // Swallow rejection — we only care about completion
      .then(() => {
        // Only apply if no newer update has already been applied
        if (this.callbacks !== pendingCallbacks) {
          this.callbacks = pendingCallbacks;
          this.logger.info(
            { chatId: this.boundChatId },
            'Deferred callback update applied after query completion'
          );
        }
      });
    return false;
  }

  protected getAgentName(): string {
    return 'ChatAgent';
  }

  /**
   * Get the chatId this ChatAgent is bound to.
   */
  getChatId(): string {
    return this.boundChatId;
  }

  /**
   * Promise that resolves when the current task completes (Issue #3124).
   *
   * Set when a session is started via processMessage().
   * Resolves when the SDK returns a `result` message.
   * Rejects if an error occurs during processing.
   *
   * Consumers (e.g., ScheduleExecutor) can use this to await task completion:
   * ```typescript
   * agent.processMessage({ chatId, payload: prompt, messageId, senderOpenId: userId });
   * await agent.taskComplete;
   * ```
   */
  get taskComplete(): Promise<void> | undefined {
    return this.taskCompletionPromise;
  }

  /**
   * Per-turn completion promise (Issue #4063).
   * Unlike taskComplete, resolves after each turn in persistent mode.
   *
   * Issue #4649 (review ③): returns the NEWEST pushed message's promise.
   * Under interleaving (another message pushed while this caller's message is
   * still queued) this can be a DIFFERENT message's promise — callers that
   * can interleave (Scheduler / Loop Runner via the pool handler) must use
   * turnCompleteFor(messageId) instead.
   */
  get turnComplete(): Promise<void> | undefined {
    let newest: Promise<void> | undefined;
    for (const entry of this.turnCompletions.values()) {
      newest = entry.promise;
    }
    return newest;
  }

  /**
   * Completion promise for ONE message's own turn (Issue #4649 review ③).
   *
   * Resolved when that message's turn ends with a result; rejected when its
   * turn (or the session carrying it) dies; rejected at push time when the
   * channel refused the message. Entries stay retrievable after settling
   * (until evicted by the bounded registry), so a caller grabbing the promise
   * right after processMessage() resolves can never miss it — the pre-#4649
   * single-slot getter returned undefined once the turn finished, which made
   * "already finished" indistinguishable from "never started".
   *
   * Undefined when this message never entered a turn (no session channel) or
   * its entry was evicted — callers must treat that as a failure, not success
   * (Issue #4649 review ⑤).
   */
  turnCompleteFor(messageId: string): Promise<void> | undefined {
    return this.turnCompletions.get(messageId)?.promise;
  }

  /**
   * Register the per-message turn-completion entry for a channel push
   * (Issue #4063; per-message shape from #4649 review ③).
   *
   * Why a registry and not the pre-#4649 single slot: one processIterator
   * serves many interleaved turns, and the slot was written at PUSH time — a
   * message queued behind a running turn overwrote it. Completion settlement
   * therefore carries the current turn's messageId and targets that entry
   * directly, so every awaiter gets its OWN turn's real outcome.
   */
  private createTurnCompletion(messageId: string): TurnCompletionEntry {
    // Same-messageId re-push (the empty-turn replay re-invokes processMessage
    // with the original params): replace. Map.set on an existing key keeps
    // its old insertion position, so delete first — the replay's turn runs
    // LAST and must be ordered accordingly.
    const previous = this.turnCompletions.get(messageId);
    if (previous && !previous.settled) {
      previous.settled = true;
      previous.settle(new TurnSupersededError());
    }
    this.turnCompletions.delete(messageId);

    let settle!: (error?: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      settle = (error?: Error) => (error ? reject(error) : resolve());
    });
    const entry: TurnCompletionEntry = { promise, settle, settled: false };
    // Prevent unhandled rejection when nobody awaits (ordinary user messages)
    promise.catch(() => {});
    this.turnCompletions.set(messageId, entry);

    // Bounded like pendingTurnAnchors: a parked/dead session with no iterator
    // draining must not grow this unboundedly. Evicted entries are settled
    // with an error so a still-awaiting caller never hangs silently.
    while (this.turnCompletions.size > MAX_TURN_COMPLETIONS) {
      const oldest = this.turnCompletions.entries().next();
      if (oldest.done) {
        break;
      }
      const [oldestKey, oldestEntry] = oldest.value;
      this.turnCompletions.delete(oldestKey);
      if (!oldestEntry.settled) {
        oldestEntry.settled = true;
        oldestEntry.settle(new Error('Turn completion evicted (registry overflow)'));
      }
    }
    return entry;
  }

  /**
   * Settle the completion for the turn that ended (Issue #4808). Call at each
   * turn end (result / stall / empty-stream / evicted terminations). Settled
   * entries stay registered for late awaiters until evicted by the bound.
   */
  private resolveTurn(messageId: string | undefined): void {
    if (!messageId) {
      this.logger.warn('Cannot settle turn completion without a messageId');
      return;
    }
    const entry = this.turnCompletions.get(messageId);
    if (entry && !entry.settled) {
      entry.settled = true;
      entry.settle();
    }
  }

  /**
   * Reject every unsettled turn completion (Issue #4063; all-entries
   * semantics from #4649 review ③). Every call site is a whole-session death
   * (iterator error, startup failure, reset, dispose, session replacement):
   * queued messages' turns die with the session, so each awaiter gets the
   * error instead of hanging. A SINGLE message's failure must settle only its
   * own entry (see the channel-closed push path in processMessage).
   */
  private rejectTurn(error: Error): void {
    for (const entry of this.turnCompletions.values()) {
      if (!entry.settled) {
        entry.settled = true;
        entry.settle(error);
      }
    }
  }

  /**
   * Check if this agent is currently busy processing a message.
   * Issue #3931: Used by scheduler to skip blocking tasks when agent is busy.
   * Issue #3985: Changed from isSessionActive to isProcessingMessage to correctly
   * distinguish between "session exists but idle" and "actively processing a message".
   * Previously, isSessionActive stayed true as long as the agent loop was open,
   * causing blocking tasks to be skipped even when the agent was idle between turns.
   *
   * @returns true if the agent is actively processing a message
   */
  get isBusy(): boolean {
    return this.isProcessingMessage;
  }

  /**
   * When the most recent turn started (ms epoch), or 0 if no turn has
   * started yet.
   *
   * Issue #4620: the pool's busy-turn hard cap measures the CURRENT turn
   * from this authoritative timestamp. The previous observation-based
   * marker (set when the idle sweep first saw isBusy, cleared when a sweep
   * saw !isBusy) silently accumulated across back-to-back turns — whenever
   * every sweep tick landed mid-turn, the marker never cleared, and after
   * 90 min of session wall-clock a brand-new turn was insta-killed with a
   * misleading "running for 90 minutes" message.
   *
   * Note: the timestamp is set on turn start and never reset — once a turn
   * has run, idle agents still report that (stale) turn's start. Readers
   * must gate on `isBusy` for "is this turn live" semantics; the pool does.
   *
   * @returns ms epoch of the most recent turn's start, or 0 if no turn has
   * started.
   */
  get turnStartedAtMs(): number {
    return this.turnStartedAtMsPrivate;
  }

  /**
   * Start the agent session (ChatAgent interface).
   *
   * Called once before processing any messages. For ChatAgent, this is a no-op
   * since sessions are created on-demand via processMessage().
   *
   * @returns Promise that resolves when started
   */
  start(): Promise<void> {
    this.logger.debug(
      { chatId: this.boundChatId },
      'ChatAgent start() called - session is created on-demand'
    );
    return Promise.resolve();
  }

  /**
   * Handle streaming user input and yield responses (ChatAgent interface).
   *
   * This method provides a unified interface for processing user messages
   * from an async generator and yielding AgentMessage responses.
   *
   * @param input - AsyncGenerator yielding UserInput messages
   * @yields AgentMessage responses
   */
  async *handleInput(input: AsyncGenerator<UserInput>): AsyncGenerator<AgentMessage> {
    for await (const userInput of input) {
      const chatId = userInput.metadata?.chatId ?? 'default';
      const messageId = userInput.metadata?.parentMessageId ?? `msg-${Date.now()}`;
      const senderOpenId = userInput.metadata?.fileRefs?.[0]?.name;

      // Issue #644: Verify chatId matches bound chatId
      if (chatId !== this.boundChatId) {
        this.logger.warn(
          { boundChatId: this.boundChatId, receivedChatId: chatId },
          'Received message for different chatId, ignoring'
        );
        continue;
      }

      // Track thread root
      this.conversationOrchestrator.setThreadRoot(chatId, messageId);

      // Start session if needed
      if (!this.isSessionActive) {
        this.startAgentLoop();
      }

      // Get capabilities for message building
      const capabilities = this.callbacks.getCapabilities?.(chatId);

      // Build the user message using MessageBuilder (Issue #697)
      const enhancedContent = this.messageBuilder.buildEnhancedContent(
        {
          text: userInput.content,
          messageId,
          senderOpenId,
        },
        chatId,
        capabilities
      );

      const streamingMessage: StreamingUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: enhancedContent,
        },
        parent_tool_use_id: null,
        session_id: '',
      };

      // Push message to channel (Issue #2007)
      // Attempt delivery with one retry on failure — channel may have been closed
      // between session start and this point due to an agent loop crash.
      if (!this.tryPushMessage(streamingMessage, chatId, messageId)) {
        // Don't retry if session was intentionally closed (e.g., /reset).
        // Retrying would re-create the session the user just terminated.
        if (!this.isSessionActive) {
          this.logger.info(
            { chatId, messageId },
            'handleInput: session is not active, skipping retry'
          );
          yield {
            content: '⚠️ 当前会话已重置，请直接发送新消息。',
            role: 'assistant',
            messageType: 'text',
          };
          continue;
        }

        // Close old query to prevent orphaned processIterator from sending
        // duplicate messages while the new session starts.
        // Issue #3378: Must use close() (not cancel()) to remove the exit listener
        // registered by ProcessTransport. cancel() only stops iteration but leaves
        // the exit listener, causing leaks on repeated retries.
        if (this.queryHandle) {
          this.logger.info({ chatId }, 'handleInput: closing old queryHandle before retry');
          this.queryHandle.close();
          this.queryHandle = undefined;
        }
        if (this.channel) {
          this.logger.info({ chatId }, 'handleInput: closing old channel before retry');
          this.channel.close();
          this.channel = undefined;
        }

        this.logger.warn(
          { chatId, messageId },
          'handleInput: first push failed, attempting session restart'
        );
        try {
          this.startAgentLoop();
        } catch (restartErr) {
          this.logger.error(
            { err: restartErr, chatId, messageId },
            'handleInput: session restart failed'
          );
        }
        if (!this.tryPushMessage(streamingMessage, chatId, messageId)) {
          this.logger.error(
            { chatId, messageId },
            'handleInput: retry also failed, yielding error'
          );
          yield {
            content: '⚠️ 消息未能送达，会话已结束。请发送 /reset 重置会话后重试。',
            role: 'assistant',
            messageType: 'text',
          };
          continue;
        }
      }

      // Yield acknowledgment (internal diagnostic, not user-facing).
      // Uses 'notification' type so consumers can filter it from user messages.
      yield {
        content: '✓',
        role: 'assistant',
        messageType: 'notification',
      };
    }
  }

  /**
   * Execute a one-shot query (Issue #3124).
   *
   * This method uses the unified streaming path (processMessage + taskComplete)
   * instead of a separate code path. It:
   * 1. Enables once-mode on the agent
   * 2. Calls processMessage to start the session and push the message
   * 3. Awaits taskComplete which resolves when the SDK returns a result
   *
   * The once-mode flag causes processIterator to close the channel after
   * receiving the first `result` message, effectively making the session
   * one-shot.
   *
   * @param chatId - Platform-specific chat identifier (must match bound chatId)
   * @param text - User's message text
   * @param messageId - Unique message identifier
   * @param senderOpenId - Optional sender's open_id for @ mentions
   */
  async runOnce(
    chatId: string,
    text: string,
    messageId?: string,
    senderOpenId?: string
  ): Promise<void> {
    // Issue #644: Verify chatId matches bound chatId
    if (chatId !== this.boundChatId) {
      this.logger.error(
        { boundChatId: this.boundChatId, receivedChatId: chatId },
        'runOnce called with wrong chatId'
      );
      throw new Error(`ChatAgent bound to ${this.boundChatId} cannot execute for ${chatId}`);
    }

    this.logger.info(
      { chatId, messageId, textLength: text.length },
      'One-shot mode: executing via unified streaming path'
    );

    // Enable once-mode: processIterator will close channel after first result
    this.onceMode = true;

    try {
      // Use processMessage to push the message through the unified streaming path.
      // The processIterator running in the background will handle the SDK responses
      // and resolve/reject the taskComplete promise.
      const effectiveMessageId = messageId ?? `once-${Date.now()}`;
      await this.processMessage({
        chatId,
        payload: text,
        messageId: effectiveMessageId,
        senderOpenId,
      });

      // Wait for the task to complete via the unified streaming path
      if (this.taskCompletionPromise) {
        await this.taskCompletionPromise;
      }

      this.logger.info({ chatId }, 'One-shot task completed normally');
    } finally {
      // Clean up once-mode state
      this.onceMode = false;
    }
  }

  /**
   * Process a message with the AI agent.
   *
   * This method is non-blocking - it pushes the message to the channel and returns immediately.
   * The message will be processed by the SDK via the channel's generator.
   *
   * Issue #644: Only accepts messages for the bound chatId.
   * Issue #857: Triggers async complexity analysis for progress tracking.
   * Issue #1230: Attachs chat history on first message for new sessions.
   *
   * @param chatId - Platform-specific chat identifier (must match bound chatId)
   * @param text - User's message text
   * @param messageId - Unique message identifier
   * @param senderOpenId - Optional sender's open_id for @ mentions
   * @param attachments - Optional file attachments
   * Issue #3779: Converted to options object for type safety.
   */
  async processMessage(params: UserMessageParams): Promise<void> {
    const {
      chatId,
      payload: text,
      messageId,
      senderOpenId,
      attachments,
      chatHistoryContext,
      chatType,
      threadContext,
      threadRootId,
    } = params;
    // Issue #644: Verify chatId matches bound chatId
    if (chatId !== this.boundChatId) {
      this.logger.error(
        { boundChatId: this.boundChatId, receivedChatId: chatId },
        'processMessage called with wrong chatId - this should not happen'
      );
      return;
    }

    // S03: a message arriving during a live turn is ordinary queued input,
    // never an implicit stop/steer. Acknowledge that boundary before pushing
    // it into the existing serial channel; notification failure must not drop
    // the user's queued message.
    const queuedBehindActiveTurn = this.isBusy;

    this.logger.info(
      {
        chatId,
        messageId,
        textLength: text.length,
        hasAttachments: !!attachments,
        hasChatHistory: !!chatHistoryContext,
        hasPersistedHistory: !!this.historyManager.persistedHistoryContext,
        hasFirstMessageHistory: !!this.historyManager.firstMessageHistoryContext,
        chatType,
      },
      'processMessage called'
    );
    const lifecycleContext = Object.freeze({
      chatId,
      traceId: `${chatId}:${messageId}`,
      runId: crypto.randomUUID(),
      sourceMessageId: messageId,
    });
    this.logger.info({ event: 'agent_turn', state: 'started', ...lifecycleContext, user_visible: false }, 'agent_turn');

    // Issue #3641: Store chat type for topic group detection
    if (chatType) {
      this.chatType = chatType;
    }

    // Issue #4391: stash the params of the message being processed so an empty
    // turn can replay the exact original input against a fresh session.
    // Stashed for synthetic messages too — eligibility is decided later from
    // the messageId by EmptyTurnRetryPolicy (synthetic turns never replay).
    this.messageSeq++;
    this.lastTurnMessage = params;

    // Track thread root
    this.conversationOrchestrator.setThreadRoot(chatId, messageId);

    // Start session if needed
    if (!this.isSessionActive) {
      this.logger.info({ chatId }, 'No active session, starting agent loop');
      this.startAgentLoop();
      if (!this.isSessionActive) {
        this.logger.error(
          { chatId, messageId },
          'Message rejected because the bound project directory is unavailable'
        );
        return;
      }
    }

    // Issue #4587 (part 1, review fix): enqueue this turn's reply anchor —
    // AFTER startAgentLoop() (which clears anchors left over from the previous
    // session; clearing must never eat this message's own anchor) and BEFORE
    // the channel push below (the anchor must be queued no later than the
    // message becomes visible to the iterator). Fallback resolved NOW, not at
    // consumption time, so a later message's setThreadRoot cannot change what
    // this turn falls back to.
    this.pendingTurnAnchors.push(
      threadRootId ?? this.conversationOrchestrator.getThreadRoot(chatId)
    );
    this.pendingTurnMessageIds.push(messageId);
    this.pendingLifecycleContexts.push(lifecycleContext);
    if (!queuedBehindActiveTurn) {this.activeLifecycleContext = lifecycleContext;}
    if (this.pendingLifecycleContexts.length > 50) {this.pendingLifecycleContexts.splice(0, this.pendingLifecycleContexts.length - 50);}
    // Bounded: a dead/parked session with no iterator draining would otherwise
    // grow this unboundedly (anchors for messages the session never answers).
    if (this.pendingTurnAnchors.length > 50) {
      this.pendingTurnAnchors.splice(0, this.pendingTurnAnchors.length - 50);
    }
    if (this.pendingTurnMessageIds.length > 50) {
      this.pendingTurnMessageIds.splice(0, this.pendingTurnMessageIds.length - 50);
    }

    // Issue #1863: Wait for first message history to load before building content.
    // This fixes the race condition where processMessage() checks firstMessageHistoryContext
    // before the async loadFirstMessageHistory() in startAgentLoop() completes.
    if (!this.historyManager.firstMessageHistoryLoaded) {
      await this.historyManager.loadFirstMessageHistory();
    }

    // One bounded snapshot per instance/recovery session (#4795). Explicit
    // receive-time history wins on the first message and consumes the stash too;
    // subsequent turns retain only cheap log-path hints, not repeated snapshots.
    const effectiveChatHistoryContext = this.historyManager.consumeFirstMessageContext(chatHistoryContext);

    // Get capabilities for message building
    const capabilities = this.callbacks.getCapabilities?.(chatId);

    // Build the user message using MessageBuilder (Issue #697)
    // Issue #955: Include persisted history context for session restoration
    const enhancedContent = this.messageBuilder.buildEnhancedContent(
      {
        text,
        messageId,
        senderOpenId,
        attachments,
        chatHistoryContext: effectiveChatHistoryContext,
        chatLogFilePaths: this.historyManager.chatLogFilePaths,
        chatType: this.chatType,
        threadContext,
      },
      chatId,
      capabilities
    );

    const userMessage: StreamingUserMessage = {
      type: 'user',
      correlation: lifecycleContext,
      message: {
        role: 'user',
        content: enhancedContent,
      },
      parent_tool_use_id: null,
      session_id: '',
    };

    // Push message to channel
    if (this.channel) {
      // Issue #3985: Mark as processing when a user message is pushed to the channel.
      this.isProcessingMessage = true;
      // Issue #4620: authoritative turn-start timestamp for the pool's
      // busy-turn cap — see turnStartedAtMs getter.
      this.turnStartedAtMsPrivate = Date.now();
      // Issue #4063 / #4649 (review ③): register THIS message's completion
      // entry before the push so turnCompleteFor(messageId) can never miss
      // it. On push rejection only THIS entry is settled — rejectTurn()
      // settles ALL pending entries and would misattribute a channel close
      // to unrelated live turns' awaiters.
      const turnEntry = this.createTurnCompletion(messageId);
      const accepted = this.channel.push(userMessage);
      if (!accepted) {
        // Issue #2007: Channel is closed — message would be silently dropped.
        // Notify the user so they know the action was not processed.
        // Issue #3985: Reset isProcessingMessage since the message was not actually processed.
        // Issue #4063: Reject turn completion since message was not processed.
        this.isProcessingMessage = false;
        turnEntry.settled = true;
        turnEntry.settle(new Error('Channel closed — message not processed'));
        this.logger.warn({ chatId, messageId }, 'Message rejected: channel is closed');
        this.callbacks
          .sendMessage(chatId, '⚠️ 消息未能送达，会话可能已结束。请发送 /reset 重置会话后重试。')
          .catch((notifyErr) => {
            this.logger.error(
              { err: notifyErr, chatId },
              'Failed to send channel-closed notification'
            );
          });
        return;
      }
      if (queuedBehindActiveTurn) {
        void this.callbacks.sendMessage(
          chatId,
          '⏳ 当前回合仍在执行；这条消息已排队，将在当前回合结束后处理。使用 `/stop` 可停止当前回合；`/steer` 会报告后端的即时纠偏能力。',
          threadRootId
        ).catch((error) => {
          this.logger.warn(
            { err: error, chatId, messageId },
            'Failed to send queued-message notice'
          );
        });
      }
    } else {
      this.logger.error({ chatId, messageId }, 'No channel found after session creation');
      // Issue #1357: Notify user — message would otherwise be silently lost
      this.callbacks
        .sendMessage(chatId, '❌ 会话通道异常，请发送 /reset 重置会话后重试。')
        .catch((notifyErr) => {
          this.logger.error(
            { err: notifyErr, chatId },
            'Failed to send no-channel error notification'
          );
        });
    }
  }

  /**
   * Attempt to push a message to the channel.
   *
   * Centralizes push logic and handles both "no channel" and "channel closed" cases.
   * Returns true if the message was accepted, false otherwise.
   *
   * @param message - The streaming user message to push
   * @param chatId - Chat ID for logging
   * @param messageId - Message ID for logging
   * @returns true if message was accepted by the channel
   */
  private tryPushMessage(
    message: StreamingUserMessage,
    chatId: string,
    messageId: string
  ): boolean {
    if (!this.channel) {
      this.logger.error({ chatId, messageId }, 'tryPushMessage: no channel available');
      return false;
    }
    const accepted = this.channel.push(message);
    if (!accepted) {
      this.logger.warn({ chatId, messageId }, 'tryPushMessage: push rejected, channel is closed');
      return false;
    }
    return true;
  }

  /**
   * Start the Agent loop for this chatId.
   *
   * Creates a MessageChannel and Query, using the channel's generator for streaming input.
   * Issue #955: Triggers background loading of persisted chat history.
   * Issue #1230: Triggers background loading of chat history for first message.
   * Issue #3124: Sets up taskComplete promise.
   * Issue #4652: ChatAgent no longer creates or injects MCP servers. Channel
   * operations are exposed through the runtime-agnostic channel CLI Skill.
   */
  private startAgentLoop(): void {
    const chatId = this.boundChatId;
    const startMs = Date.now(); // Issue #3292: timing for agent startup diagnostics
    this.logger.info({ chatId, timing: 'agent:startLoop', elapsedMs: 0 });

    // Issue #3378: Close any previous query/channel before starting a new one.
    // Each SDK query registers process.on("exit", handler) via ProcessTransport.
    // If the old handle is overwritten without close(), the exit listener leaks
    // and accumulates across restart cycles, eventually triggering
    // MaxListenersExceededWarning (11 exit listeners added to [process]).
    if (this.queryHandle) {
      this.logger.info({ chatId }, 'Closing previous query handle before starting new loop');
      this.queryHandle.close();
      this.queryHandle = undefined;
    }
    if (this.channel) {
      this.logger.info({ chatId }, 'Closing previous message channel before starting new loop');
      this.channel.close();
      this.channel = undefined;
    }

    // Issue #955: Trigger background loading of persisted history
    if (!this.historyManager.historyLoaded) {
      this.historyManager.loadPersistedHistory().catch((err) => {
        this.logger.error({ err, chatId }, 'Failed to load persisted history in background');
      });
    }

    // Issue #1230: Load chat history for first message context
    if (!this.historyManager.firstMessageHistoryLoaded && this.callbacks.getChatHistory) {
      this.historyManager.loadFirstMessageHistory().catch((err) => {
        this.logger.error({ err, chatId }, 'Failed to load first message history in background');
      });
    }

    // Build SDK options using BaseAgent's createSdkOptions
    // Issue #1916: Resolve cwd from CwdProvider if available (project-scoped context)
    // Issue #4448 (direction #1): when the structured resolver reports the
    // bound directory as missing, fail closed. Passing cwd: undefined would make
    // BaseAgent silently use the shared workspace and could write into the wrong
    // project. The plain cwdProvider cannot distinguish this from "unbound".
    // Nit: the resolver subsumes cwdProvider (same resolveCwd() underneath,
    // effectiveCwd is the plain provider's return value) — call it once and use
    // the result for both the cwd and the warning check, instead of running
    // resolveCwd() (existsSync + map lookup) twice per spawn.
    const resolution = this.cwdResolver?.(chatId);
    if (resolution?.reason === 'bound-missing' && resolution.boundWorkingDir) {
      // Nit: startAgentLoop() re-runs on restart cycles (processIterator →
      // startAgentLoop once the previous query ends), which would re-announce
      // the same missing directory to a chat that already saw the warning.
      // Warn once per missing target per agent instance; a rebind (or the
      // directory reappearing then vanishing again) clears the fingerprint
      // and warns again, matching the "re-resolve on restart" semantics.
      if (this.warnedMissingWorkingDir !== resolution.boundWorkingDir) {
        this.warnedMissingWorkingDir = resolution.boundWorkingDir;
        this.callbacks
          .sendMessage(
            chatId,
            [
              `⚠️ **项目绑定目录不存在**: \`${resolution.boundWorkingDir}\``,
              '',
              '本次消息已停止，**不会回退到工作空间根目录运行**。',
              '可能原因：容器重启时 volume 尚未就绪 / 目录被移动或卸载 / 路径大小写或规范化差异。',
              '可用 `/project reset` 回到默认，或 `/project use <dir>` 重新绑定。',
            ].join('\n')
          )
          .catch((err) => {
            this.logger.error({ err, chatId }, 'Failed to send bound-missing cwd rejection');
          });
      }
      this.isSessionActive = false;
      return;
    } else if (this.warnedMissingWorkingDir !== undefined) {
      // Binding recovered (bound or unbound now) — allow a future
      // bound-missing for a different (or re-vanished) target to warn again.
      this.warnedMissingWorkingDir = undefined;
    }
    const projectCwd = resolution?.effectiveCwd ?? this.cwdProvider?.(chatId);

    const sdkOptions = this.createSdkOptions({
      cwd: projectCwd,
      // Issue #4181: the built-in (session-only) cron/loop tools are disallowed
      // by default; set DISCLAUDE_ALLOW_BUILTIN_CRON=1 to restore them.
      // Disallowing alone blocks the calls; rerouting recurring work to the
      // persistent `schedule` skill needs a guidance nudge (tracked as a #4181
      // follow-up).
      disallowedTools: buildDisallowedTools(),
      // Issue #4634 (S7): chatId as session identity for concurrency
      // governance on backends that bound active sessions (codex).
      sessionKey: this.sdkSessionKey,
    });

    this.logger.info({ chatId }, 'Starting SDK query with message channel');

    // Issue #2926: Create fresh AbortController for this agent loop
    this.abortController = new AbortController();

    // Issue #3124: Set up task completion promise
    this.taskCompletionPromise = new Promise<void>((resolve, reject) => {
      this.taskCompletionResolve = resolve;
      this.taskCompletionReject = reject;
    });
    // Issue #3141: Prevent unhandled rejection when nobody awaits taskCompletionPromise.
    // In the regular streaming path (processMessage), executeOnce is not used, so
    // taskCompletionPromise is never awaited. When processIterator catches an error
    // and calls taskCompletionReject(), the rejected promise would cause an unhandled
    // rejection. The executeOnce flow still properly awaits the promise and will see
    // the rejection regardless of this no-op catch handler.
    this.taskCompletionPromise.catch(() => {});

    // Create message channel
    this.channel = new MessageChannel();

    // Create streaming query using channel's generator
    const { handle, iterator } = this.createQueryStream(this.channel.generator(), sdkOptions);

    this.queryHandle = handle;
    this.isSessionActive = true;
    // Issue #4626: fresh session generation — re-arm user-visible delivery.
    // A restart after a transient channel outage deserves a clean retry, and
    // a permanently-invalid target re-trips the circuit on its first send
    // (one wasted attempt per session, bounded by construction).
    this.consecutiveSendFailures = 0;
    this.sendCircuitOpen = false;
    // Issue #4391 (part 2 review): this query is a new session generation.
    // Any still-draining processIterator from a previous generation reads the
    // bump and exits as a superseded session instead of "unexpected end".
    this.sessionGeneration++;

    // Issue #4587 (part 1, review fix): fresh session — anchors queued for the
    // OLD session's channel are dead (that channel is closed above). Safe
    // because processMessage enqueues AFTER startAgentLoop() returns (see the
    // enqueue site), so a live anchor is never eaten here.
    this.pendingTurnAnchors = [];
    this.pendingTurnMessageIds = [];
    this.pendingLifecycleContexts = [];

    // Issue #4649 (review ③): fresh session — the OLD session's queued
    // messages will never get a turn (their channel is closed above), so
    // settle their completion entries instead of leaving awaiters hanging
    // until their own timeout. Safe by the same ordering argument as the
    // anchor clear: the current message's entry is registered only after
    // startAgentLoop() returns (see the push site in processMessage).
    this.rejectTurn(new Error('Session replaced — queued message never processed'));

    // Issue #3378: Log process exit listener count for leak monitoring.
    // Each Claude Agent SDK query() registers process.on("exit", handler) via ProcessTransport.
    // Normal range is 1-3; values > 8 indicate a leak.
    // #4813: only the provider's guarded per-query owner cleans SDK listeners.
    // A process-wide count cannot distinguish active queries or host listeners.
    const exitListenerCount = process.listenerCount('exit');
    this.logger.info({
      chatId,
      timing: 'agent:startLoop',
      elapsedMs: Date.now() - startMs,
      exitListenerCount,
      ok: true,
    });

    // Process SDK messages in background
    this.processIterator(iterator).catch(async (err) => {
      this.logger.error(
        {
          err,
          chatId,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
        },
        'Agent loop error'
      );
      this.isSessionActive = false;
      this.isProcessingMessage = false;

      // Issue #3124: Reject completion promise on outer catch
      this.taskCompletionReject?.(err instanceof Error ? err : new Error(String(err)));
      this.clearTaskCompletion();

      // Issue #1357: Notify user about the critical failure.
      // This is the outer catch — if processIterator itself throws (not an inner
      // iteration error, which is already handled inside processIterator), the user
      // currently sees complete silence. Send a fallback notification.
      try {
        await this.callbacks.sendMessage(
          chatId,
          '❌ 处理消息时发生严重错误，会话已中断。请发送 /reset 重置会话后重试。'
        );
      } catch (notifyErr) {
        this.logger.error(
          { err: notifyErr, chatId },
          'Failed to send agent loop error notification'
        );
      }
    });
  }

  /**
   * Issue #4626: send a user-visible message from the agent loop WITHOUT
   * letting a channel failure kill the agent session.
   *
   * Previously every awaited `callbacks.sendMessage` inside the for-await
   * loop (and in the catch-path error notices) could throw straight through
   * processIterator — one failed notice (e.g. Feishu 400 on a typo'd chatId)
   * tore down a session whose SDK stream was perfectly healthy. This wrapper
   * never throws:
   *
   * - success resets the consecutive-failure counter;
   * - a 4xx response (target rejected the message — invalid receive_id /
   *   chatId typo / no permission) opens the delivery circuit IMMEDIATELY:
   *   retrying or replaying cannot fix a bad target, so further sends to this
   *   chat are skipped for the rest of the session while the agent keeps
   *   working (history/logs still capture the output);
   * - 5xx / unknown (network) failures are counted; MAX_CONSECUTIVE_SEND_
   *   FAILURES in a row opens the circuit.
   *
   * When the circuit opens, an error-level log with `sendCircuitOpen: true`
   * is emitted (alertable via log search) and the debug group — the one
   * channel that may still be reachable — gets a fire-and-forget notice.
   *
   * @returns a Promise that always resolves (never rejects).
   */
  private async deliverUserVisible(
    chatId: string,
    content: string,
    threadRoot?: string
  ): Promise<boolean> {
    const context = this.activeLifecycleContext ?? {
      traceId: `${chatId}:unknown`,
      runId: crypto.randomUUID(),
      sourceMessageId: 'unknown',
    };
    const attempt = this.consecutiveSendFailures + 1;
    const recordDeliveryEvent = (event: 'delivery_attempt' | 'delivery_final', fields: Record<string, unknown>): void => {
      // Keep event publication off the hot path: legacy callers and tests rely
      // on delivery failures being isolated without extra scheduling points.
      setImmediate(() => this.logger.info({
        event, chatId, target: chatId, attempt, user_visible: false, ...context, ...fields,
      }, event));
    };
    recordDeliveryEvent('delivery_attempt', {
      state: 'started',
      fallback: threadRoot ? 'thread_reply' : 'direct',
      circuitState: this.sendCircuitOpen ? 'open' : 'closed',
    });
    if (this.sendCircuitOpen) {
      this.logger.debug(
        { chatId, contentLength: content.length },
        'Send skipped: delivery circuit open for this session (Issue #4626)'
      );
      recordDeliveryEvent('delivery_final', { state: 'delivery_failed', circuitState: 'open' });
      return false;
    }
    try {
      const sentMessageId = await this.callbacks.sendMessage(chatId, content, threadRoot);
      const messageId = typeof sentMessageId === 'string' ? sentMessageId : undefined;
      this.consecutiveSendFailures = 0;
      recordDeliveryEvent('delivery_final', {
        state: 'final',
        messageId,
        circuitState: 'closed',
        user_visible: true,
      });
      this.didDeliverUserVisibleThisTurn = true;
      return true;
    } catch (err) {
      this.consecutiveSendFailures++;
      const httpStatus = extractSendHttpStatus(err);
      const isPermanentTargetError =
        httpStatus !== undefined &&
        httpStatus >= 400 &&
        httpStatus < 500 &&
        !isOversizedFeishuMessageError(err);
      if (isPermanentTargetError || this.consecutiveSendFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
        this.sendCircuitOpen = true;
        // Publish after the current delivery microtask so consumers cannot
        // observe the circuit marker before the result event has settled.
        this.logger.error(
          {
            chatId,
            err,
            httpStatus,
            consecutiveSendFailures: this.consecutiveSendFailures,
            isPermanentTargetError,
            sendCircuitOpen: true,
          },
          'User-visible delivery circuit OPENED — agent output can no longer reach this chat ' +
            '(invalid target or repeated channel failures). The agent session stays alive; ' +
            'fix the chatId / channel config, then /reset. (Issue #4626)'
        );
        this.notifyDebugGroupOfDeliveryFailure(chatId, err, httpStatus, isPermanentTargetError);
      } else {
        this.logger.warn(
          {
            err,
            chatId,
            httpStatus,
            consecutiveSendFailures: this.consecutiveSendFailures,
          },
          'sendMessage failed in agent loop — isolated, session continues (Issue #4626)'
        );
      }
      recordDeliveryEvent('delivery_final', {
        state: 'delivery_failed',
        errorCategory: isPermanentTargetError ? 'target' : 'transport',
        errorCode: sanitizeLifecycleReason(err),
        fallback: 'none',
        circuitState: this.sendCircuitOpen ? 'open' : 'closed',
      });
      return false;
    }
  }

  /**
   * Issue #4626: when the delivery circuit opens, try to surface it on the
   * debug group — the only destination that may still be reachable (the
   * failing chat obviously cannot be notified about itself). Fire-and-forget:
   * a missing debug group or a failing forward must never propagate.
   */
  private notifyDebugGroupOfDeliveryFailure(
    chatId: string,
    err: unknown,
    httpStatus: number | undefined,
    isPermanentTargetError: boolean
  ): void {
    let debugChatId: string | undefined;
    try {
      const debugGroup = getDebugGroupService().getDebugGroup();
      // Never forward back into the chat that just failed.
      debugChatId = debugGroup && debugGroup.chatId !== chatId ? debugGroup.chatId : undefined;
    } catch {
      // Debug group service unavailable — the error-level structured log
      // above is the remaining alert channel.
    }
    if (!debugChatId) {
      return;
    }
    const reason = isPermanentTargetError
      ? `HTTP ${httpStatus} — 目标疑似无效（chatId 配置错误？）`
      : '连续投递失败';
    const message =
      `🚫 [投递熔断] Agent 输出无法送达 chat ${chatId}（${reason}），会话保持存活。` +
      `错误: ${err instanceof Error ? err.message : String(err)} (Issue #4626)`;
    void this.callbacks.sendMessage(debugChatId, message).catch((fwdErr) => {
      this.logger.debug(
        { err: fwdErr, debugChatId },
        'Failed to forward delivery-circuit notice to debug group (Issue #4626)'
      );
    });
  }

  /**
   * Clear task completion state (Issue #3124).
   */
  private clearTaskCompletion(): void {
    this.taskCompletionPromise = undefined;
    this.taskCompletionResolve = undefined;
    this.taskCompletionReject = undefined;
  }

  /**
   * Process the SDK iterator for this chatId.
   *
   * IMPORTANT: This method preserves conversation context by NOT clearing the session
   * when the iterator ends unexpectedly. Only explicit close (reset)
   * clears the session.
   *
   * If the iterator ends without explicit close, we use RestartManager to:
   * - Limit consecutive restarts (max 3 by default)
   * - Apply exponential backoff between restarts
   * - Open circuit breaker after max restarts exceeded
   *
   */
  // Issue #4320: use the canonical IteratorYieldResult['parsed'] (exported from
  // @disclaude/core) instead of a hand-written shape — the two had already
  // drifted (this copy omitted sessionId and made content optional), and every
  // value here is produced by BaseAgent.convertToLegacyFormat which already
  // returns IteratorYieldResult['parsed']. One source of truth, no drift.
  private async processIterator(iterator: AsyncGenerator<IteratorYieldResult>): Promise<void> {
    const chatId = this.boundChatId;
    // Issue #4391 (part 2 review): the session generation this invocation
    // belongs to. If the bump happens while this iterator is still parked
    // (endEmptyTurnSession → replay's startAgentLoop), this invocation was
    // superseded mid-flight and must exit as an intercepted teardown below,
    // not as an "unexpected end".
    const myGeneration = this.sessionGeneration;
    const diagnosticId = crypto.randomUUID();
    let iteratorError: Error | null = null;
    let messageCount = 0;
    const startTime = Date.now(); // Issue #2920: 追踪启动时间

    // Issue #3003: Timing diagnostics for request pipeline
    let firstMessageMs: number | undefined;
    let lastToolCallMs: number | undefined;
    let toolCallCount = 0;
    // Issue #4194: count substantive user-visible output sent this turn
    // (excludes the ✅ Complete result marker) so empty turns are detectable.
    let userVisibleOutputCount = 0;
    // 2026-09-08: 本轮是否收到 proxy 的 mid-stream 中断标记(带 MIDSTREAM_MARKER 的
    // assistant 正文)。turn 收尾 accounting 用;与其它 per-turn 计数一起清零。
    let sawMidstreamInterrupt = false;

    // Issue #4587 (part 1, review fix): per-turn reply anchor, consumed from
    // the pendingTurnAnchors FIFO. The original part-1 shape read the live
    // currentThreadRootId at each output site; processMessage(B) overwrites it
    // while A's iterator is still draining, so A's tail outputs anchored to
    // B's thread — the exact cross-thread hijack the PR set out to fix. Here
    // the anchor is frozen for the whole turn at the turn's FIRST event
    // (loop head below), and re-armed after each result so the next turn
    // (next queued message) picks up its own anchor.
    let turnAnchorConsumed = false;
    let currentTurnAnchor: string | undefined;
    let currentTurnMessageId: string | undefined;
    const consumeTurnAnchor = (): string | undefined => {
      if (!turnAnchorConsumed && this.pendingTurnMessageIds.length > 0) {
        turnAnchorConsumed = true;
        currentTurnAnchor = this.pendingTurnAnchors.shift();
        currentTurnMessageId = this.pendingTurnMessageIds.shift();
        this.activeLifecycleContext = this.pendingLifecycleContexts.shift();
        this.didDeliverUserVisibleThisTurn = false;
        this.activeTurnMessageId = currentTurnMessageId;
      }
      return currentTurnAnchor;
    };
    // Issue #4587 (part 1, review fix): resolve this turn's reply anchor once.
    const resolveReplyThreadRoot = (): string | undefined =>
      consumeTurnAnchor() ?? this.conversationOrchestrator.getThreadRoot(chatId);

    // Issue #4399 (#4208 P2-b): streaming-card state machine. Only constructed
    // when the channel advertises supportsStreaming AND provides all three
    // streaming callbacks; otherwise `streamDriver` is null and the assistant
    // dispatch below is bit-identical to today (sendMessage per chunk). The
    // driver owns the reply-never-lost guarantee (start-decline / flush-failure
    // → sendMessage fallback) and is finalized on every turn-exit path below.
    // Issue #4510 (part 2): the p2p-first gray rollout is built-in, not a
    // config option — streaming cards are only constructed for single chats;
    // group/topic turns skip the driver entirely and keep the per-chunk
    // sendMessage path, so the rollout never changes group behavior.
    // `this.chatType` is set by processMessage (#3641, with #4401/#4428 topic
    // normalization), so an unset value degrades to non-streaming
    // (fail-safe: unknown type → no card).
    const streamCapabilities = this.callbacks.getCapabilities?.(chatId);
    const streamDriver =
      !!streamCapabilities?.supportsStreaming &&
      this.chatType === 'p2p' &&
      !!this.callbacks.startStreaming &&
      !!this.callbacks.streamText &&
      !!this.callbacks.finalizeStreaming
        ? new StreamingReplyDriver({
            chatId,
            parentMessageId: resolveReplyThreadRoot() ?? undefined,
            startStreaming: this.callbacks.startStreaming,
            streamText: this.callbacks.streamText,
            finalizeStreaming: this.callbacks.finalizeStreaming,
            sendMessage: async (cid, content, threadRoot) => {
              await this.callbacks.sendMessage(cid, content, threadRoot);
            },
            logger: this.logger,
          })
        : null;

    try {
      for await (const { parsed } of iterator) {
        // Issue #2926: Check abort signal at the start of each iteration.
        // When /stop or /reset is received, we break immediately instead of
        // continuing to process buffered SDK messages.
        if (this.abortController?.signal.aborted) {
          this.logger.info(
            { chatId, messageCount, type: parsed.type },
            'Aborting processIterator: stop/reset signal received'
          );
          break;
        }

        // Issue #4587 (part 1, review fix): this event's turn adopts its
        // anchor from the FIFO on the turn's FIRST event. Harmless no-op for
        // the leading system/status events of a turn (they don't reply), and
        // it guarantees the anchor is frozen before any text/result of the
        // turn is dispatched, even when an interleaved processMessage pushed
        // a second anchor mid-turn.
        consumeTurnAnchor();

        messageCount++;

        // Issue #3003: Track Time-To-First-Token (TTFT)
        if (!firstMessageMs) {
          firstMessageMs = Date.now();
          this.logger.info(
            { chatId, ttftMs: firstMessageMs - startTime, type: parsed.type },
            'First SDK message received (TTFT)'
          );
        }

        // Issue #3003: Track tool call timing
        if (parsed.type === 'tool_use') {
          toolCallCount++;
          const now = Date.now();
          const sinceLastTool = lastToolCallMs ? now - lastToolCallMs : undefined;
          lastToolCallMs = now;
          this.logger.info(
            { chatId, toolCallCount, sinceLastToolMs: sinceLastTool, elapsedMs: now - startTime },
            'Tool call received'
          );
        }

        this.logger.debug({ chatId, messageCount, type: parsed.type }, 'SDK message received');

        // Send message content to callback
        // Issue #3641: In topic group threads, filter intermediate messages
        // (tool_use, tool_result, tool_progress) to reduce noise.
        // Issue #3809: Forward intermediate messages to debug group.
        if (parsed.content && parsed.terminatedReason !== 'turn_failed') {
          const isIntermediateMessage =
            parsed.type === 'tool_use' ||
            parsed.type === 'tool_result' ||
            parsed.type === 'tool_progress';
          // #4774: tool traces are internal for every harness and chat type.
          // Preserve debug forwarding and accounting without publishing raw
          // commands/results as ordinary user-facing progress.

          // Issue #3809: Forward intermediate process messages to debug group.
          // This surfaces tool_use/tool_result/tool_progress events that are
          // normally hidden from the user, giving visibility into agent internals.
          // Fire-and-forget: non-blocking, errors are logged but not awaited.
          if (isIntermediateMessage) {
            const debugGroup = getDebugGroupService().getDebugGroup();
            if (debugGroup && debugGroup.chatId !== chatId) {
              const prefix = `[${parsed.type}]`;
              const debugContent = `${prefix} ${parsed.content}`;
              this.callbacks.sendMessage(debugGroup.chatId, debugContent).catch((err) => {
                this.logger.debug(
                  { err, debugChatId: debugGroup.chatId, type: parsed.type },
                  'Failed to forward debug message'
                );
              });
            }
          }

          if (isIntermediateMessage) {
            this.logger.debug(
              { chatId, messageCount, type: parsed.type, provider: this.sdkProvider.name },
              'Filtered tool trace from user chat'
            );
          } else if (parsed.terminatedReason !== 'evicted') {
            const threadRoot = resolveReplyThreadRoot();
            // Capture as a local so the marker check stays type-safe after the
            // awaited sendMessage (which defeats parsed.content narrowing).
            const visibleContent = parsed.content;
            // Issue #4399: route assistant text through the streaming driver
            // (PATCHes one in-place card) when the channel supports streaming;
            // everything else (result markers, system notices, tool output in
            // non-topic chats) still uses sendMessage. The driver degrades to
            // sendMessage itself if streaming is declined/broken, so this never
            // changes whether the reply is delivered — only whether it streams.
            // (type === 'text' is exclusively assistant reply text — status /
            // thinking messages are type 'status', tool events are tool_use/….)
            const isAssistantReplyText = parsed.type === 'text';
            // 2026-09-08: proxy mid-stream 中断恢复正文自带 MIDSTREAM_MARKER。识别后:
            // (a) 只把 marker 之前的真实正文投给用户 —— marker+英文提示是跨层识别用的
            //     机器标记,不下发;
            // (b) 置 sawMidstreamInterrupt,供 turn 收尾决策(自动续跑 / ❌);
            // (c) 本 turn 的「✅ Complete」假成功摘要在同层整条吞掉 —— turn 并未完成。
            // marker 是 proxy 补发的独立 text 块,随 assistant 正文原样到达、不横跨两条
            // 消息,故单条 content.includes 判定稳定。
            let toDeliver = visibleContent;
            if (visibleContent.includes(MIDSTREAM_MARKER)) {
              sawMidstreamInterrupt = true;
              const markerIdx = visibleContent.indexOf(MIDSTREAM_MARKER);
              toDeliver = visibleContent.slice(0, markerIdx).trim();
            }
            const suppressFakeComplete =
              visibleContent.startsWith('✅ Complete') && sawMidstreamInterrupt;
            if (suppressFakeComplete) {
              toDeliver = '';
              this.logger.info(
                { chatId, messageCount },
                'Mid-stream interruption: suppressing fake ✅ Complete summary ' +
                  '(turn did not complete; auto-continue or ❌ follows)'
              );
            }
            if (toDeliver) {
              if (streamDriver && isAssistantReplyText) {
                await streamDriver.pushText(toDeliver, threadRoot);
              } else {
                // Issue #4626: route through the isolation wrapper — a channel
                // failure here must degrade delivery, never kill the loop. (The
                // streaming driver above already swallows its own fallback
                // failures; this path had no such protection.)
                await this.deliverUserVisible(chatId, toDeliver, threadRoot);
              }
            }
            // Issue #4194: the ✅ Complete result marker is sent as the result
            // message itself — exclude it so empty turns (no real reply) are
            // detectable at completion. Match by content (the codebase-wide
            // idiom — output-adapter.ts / messaging.ts treat
            // content.startsWith('✅ Complete') as the internal completion
            // marker) rather than by parsed.type, so error-result content
            // (which IS user-visible) is still counted.
            if (toDeliver && !visibleContent.startsWith('✅ Complete')) {
              userVisibleOutputCount++;
            }
          }
        }

        // Check for completion
        if (parsed.type === 'result') {
          // Codex can emit an empty synthetic result after a failed process.
          // Handle this before the normal success/empty-turn accounting so it
          // always has a user-visible terminal outcome.
          if (parsed.terminatedReason === 'turn_failed') {
            this.restartManager.recordFailure(chatId, 'turn_failed');
            await this.deliverUserVisible(
              chatId,
              `❌ 本轮 ${this.sdkProvider.name === 'codex' ? 'Codex' : this.sdkProvider.name} 执行失败，未生成可交付结果。请稍后重试；若持续失败，请检查模型服务、凭据和超时配置。`,
              resolveReplyThreadRoot()
            );
          }
          // Issue #3706 (GLM stall): provider watchdog terminated the stream.
          // The generic content-send block above already delivered the notice
          // (parsed.content carries STALL_TERMINATE_NOTICE). Here we only do
          // control flow: record failure (repeated stalls trip the circuit),
          // resolve the turn, and skip the normal recordSuccess / restart path.
          if (parsed.terminatedReason === 'stall') {
            this.stalledTerminated = true;
            this.logger.warn(
              { chatId, messageCount },
              'GLM stall: stream terminated by no-content-progress watchdog; recording failure, resolving turn'
            );
            this.restartManager.recordFailure(chatId, 'stall');
            this.isProcessingMessage = false;
            this.resolveTurn(currentTurnMessageId);
            if (this.callbacks.onDone) {
              const threadRoot = resolveReplyThreadRoot();
              await this.callbacks.onDone(chatId, threadRoot);
            }
            if (this.onceMode) {
              this.isSessionActive = false;
              this.channel?.close();
              this.taskCompletionResolve?.();
              this.clearTaskCompletion();
            }
            continue;
          }

          // Issue #4442 (part 3): provider exhausted the in-request retries on
          // an empty stream (200-OK-zero-content) and synthesized a terminal
          // result. Same interception shape as the GLM-stall branch above: the
          // generic content-send block already delivered the ❌ notice
          // (parsed.content carries EMPTY_STREAM_TERMINATE_NOTICE), so here we
          // only do control flow — record failure (chronic empty streams trip
          // the circuit), resolve the turn, and skip the normal recordSuccess
          // path. The session is NOT torn down here: the ChatAgent-level
          // one-shot empty-turn reset+replay (#4391) and the session-reset
          // advice in the ⚠️ #4258 notice remain the recovery levers above
          // this provider-level retry.
          if (parsed.terminatedReason === 'empty-stream') {
            this.emptyStreamTerminated = true;
            this.logger.warn(
              { chatId, messageCount },
              'Empty stream: turn terminated by provider after in-request retries exhausted ' +
                '(Issue #4442); recording failure, resolving turn'
            );
            this.restartManager.recordFailure(chatId, 'empty-stream');
            this.isProcessingMessage = false;
            this.resolveTurn(currentTurnMessageId);
            if (this.callbacks.onDone) {
              const threadRoot = resolveReplyThreadRoot();
              await this.callbacks.onDone(chatId, threadRoot);
            }
            if (this.onceMode) {
              this.isSessionActive = false;
              this.channel?.close();
              this.taskCompletionResolve?.();
              this.clearTaskCompletion();
            }
            continue;
          }

          if (parsed.terminatedReason === 'evicted') {
            // Issue #4634 (S7 review): LRU eviction is GOVERNANCE, not an
            // error — finish the turn cleanly and DO NOT auto-restart:
            // re-registering the same sessionKey while still at cap would
            // evict the next victim and cascade evictions into the circuit
            // breaker. The evicted chat lazily re-registers on its next
            // message and resumes its stashed codex thread.
            this.logger.info(
              { chatId, messageCount },
              'Codex session evicted (concurrency cap) — ending stream without auto-restart (Issue #4634)'
            );
            this.isProcessingMessage = false;
            this.resolveTurn(currentTurnMessageId);
            if (this.callbacks.onDone) {
              const threadRoot = this.conversationOrchestrator.getThreadRoot(chatId);
              await this.callbacks.onDone(chatId, threadRoot);
            }
            if (this.onceMode) {
              this.isSessionActive = false;
              this.channel?.close();
              this.taskCompletionResolve?.();
              this.clearTaskCompletion();
            }
            continue;
          }

          // Issue #3003: Log timing summary on completion
          const completionMs = Date.now() - startTime;
          this.logger.info(
            {
              chatId,
              content: parsed.content,
              completionMs,
              ttftMs: firstMessageMs ? firstMessageMs - startTime : undefined,
              toolCallCount,
              messageCount,
              // Issue #4320: surface why the turn ended (end_turn / max_tokens / tool_use / ...).
              stopReason: parsed.metadata?.stopReason,
              // Issue #4320 (part 2): turn-level observability — round-trips and
              // end-to-end / API-only duration, so a premature end_turn (few
              // round-trips, low duration_api_ms) is diagnosable at a glance.
              numTurns: parsed.metadata?.numTurns,
              durationMs: parsed.metadata?.durationMs,
              durationApiMs: parsed.metadata?.durationApiMs,
            },
            'Result received, turn complete'
          );

          // Issue #3706: Warn when turn completes with zero tool calls and Agent Teams enabled.
          // This pattern indicates the model may not support tool_use blocks properly.
          if (toolCallCount === 0 && this.isAgentTeamsEnabled()) {
            this.logger.warn(
              {
                chatId,
                messageCount,
                completionMs,
                model: this.model,
                provider: this.provider,
              },
              'Turn completed with 0 tool calls while Agent Teams is enabled. ' +
                'If team workers are stuck in idle loops, the model may not support ' +
                'tool_use blocks (common with non-Anthropic models via ' +
                'Anthropic-compatible API). See Issue #3706.'
            );
          }

          // Issue #4194: detect empty turns — SDK returned a result with no
          // user-visible output and no tool calls, so the bot appears to ignore
          // the user while the turn is marked successful.
          // Issue #4258 (part 1): notify the user instead of silently reporting
          // only ✅ Complete — the smallest safe corrective action endorsed by
          // #4258.
          // Issue #4258 (part 2 / ③): mark the empty turn as failed rather than
          // successful (see the recordSuccess/recordFailure branch below).
          // Reset/retry (②) is still a larger follow-up that needs session-
          // lifecycle design. See issues #4194 / #4258.
          // Capture the verdict before the per-turn counters are reset further
          // down, so the success-vs-failure decision can branch on it.
          const isEmptyTurn = userVisibleOutputCount === 0 && toolCallCount === 0;
          // Issue #4322: provider tags a success result with upstreamApiError when
          // the captured stderr shows the SDK gave up on an upstream API error
          // (overloaded_error / 5xx) but still emitted subtype=success. Such a turn
          // produced no reliable work product, so it must be reported as failed,
          // not masked as ✅ Complete.
          const upstreamApiError = parsed.upstreamApiError === true;
          // Issue #4391 (#4194 follow-up ②): on a real-user empty turn, decide
          // whether to consume this chat's single reset+replay attempt. The
          // policy returns false for synthetic IDs (sched-*/push_* — not valid
          // reply roots, #4259) and for chats that already used their one
          // retry (bounded to 1, cannot loop). When retrying, the ⚠️ notice
          // below is suppressed — we are actively recovering, not giving up
          // (no double-notify, design §4.5). The turn is still counted by
          // recordFailure('empty-turn') below so the restartManager circuit
          // keeps accounting chronic empty turns. A turn whose emptiness comes
          // from an upstream API error (#4322) is not retried here — that is
          // transient upstream trouble, not a corrupted session, and already
          // has its own ❌ notice + failure accounting.
          const turnMessage = this.lastTurnMessage;
          // 2026-09-08: mid-stream 中断 turn(带 MIDSTREAM_MARKER)不归 empty-turn 管 ——
          // 若它同时「零可见输出」会被误当成空会话 self-heal(会话健康,是上游截断),且会与
          // 下面 mid-stream 的续跑/❌ 双触发。这里排开,交给下方专门分支。
          const willRetryEmptyTurn =
            isEmptyTurn &&
            !upstreamApiError &&
            !sawMidstreamInterrupt &&
            !!turnMessage &&
            this.emptyTurnRetryPolicy.canRetry(chatId, turnMessage.messageId, true);
          if (willRetryEmptyTurn) {
            this.emptyTurnRetryPolicy.markRetried(chatId);
          }
          // Issue #4322 edge case: when a turn is empty BECAUSE of an upstream
          // API error, the more specific ❌ upstream notice below (with the
          // upstream request_id and the correct "transient overload — retry
          // shortly" diagnosis) takes precedence. Skip the generic ⚠️ empty-turn
          // notice here, whose "session may be invalid, try resetting" advice is
          // wrong for a transient upstream overload and would otherwise
          // double-notify. The upstream warn/notice still fires below.
          // Issue #4391: also suppressed when the turn is being retried — the
          // reset+replay below IS the "try again"; telling the user to resend
          // would be wrong (and noisy) while recovery is already in flight.
          if (isEmptyTurn && !upstreamApiError && !sawMidstreamInterrupt && !willRetryEmptyTurn) {
            this.logger.warn(
              {
                chatId,
                messageCount,
                toolCallCount,
                userVisibleOutputCount,
                model: this.model,
                provider: this.provider,
              },
              'Empty turn completed with no user-visible output and no tool calls (Issue #4194). ' +
                'Turn was marked successful but the user saw no reply; consider session reset.'
            );

            // Issue #4747: this is the terminal user-visible outcome for an
            // empty turn. Await the same isolated delivery wrapper used by
            // normal output so a rejected notification is recorded and
            // cannot be mistaken for successful delivery.
            const emptyTurnThreadRoot = resolveReplyThreadRoot();
            await this.deliverUserVisible(
              chatId,
              '⚠️ 本轮未产生任何可见输出，会话可能已失效。请重新发送消息触发重试；若持续无响应，请尝试重置会话。',
              emptyTurnThreadRoot
            );
          }

          // Issue #4391 (#4194 follow-up ②): schedule the deferred reset+replay
          // for a real-user empty turn that was granted its single retry. This
          // is the self-heal: the empty turn's root cause is typically a stale
          // / corrupted persistent session, so the replay runs against a FRESH
          // session, not the broken one (that is what distinguishes this from
          // #4314's in-place transient replay).
          //
          // Timing: processIterator is still unwinding this turn's result
          // (resolveTurn / onDone run below), and resetting the session right
          // here would close the very channel this iterator is consuming
          // mid-loop. So the replay is deferred via setTimeout(0): after this
          // iteration ends, the loop parks on the channel generator's wait,
          // and only then does the scheduled callback tear the session down
          // (endEmptyTurnSession) and re-invoke processMessage with the
          // ORIGINAL params. processMessage sees !isSessionActive and calls
          // startAgentLoop() — a fresh SDK query with a fresh channel — so the
          // replay never re-enters this iterator. v1 replayed only the single
          // message (no fresh history re-injection, design §4.1 — the replay
          // still carried the session-start persistedHistoryContext snapshot);
          // the deferred callback now also re-stashes recent chat history so
          // the replayed message — the fresh session's first — carries a FRESH
          // context snapshot (the §6 history re-injection follow-up, see the
          // callback body).
          //
          // Seq guard: if a NEWER message arrives before the timer fires (the
          // user resend, or anything else), the replay is dropped — it must
          // never clobber or run behind fresher input.
          if (willRetryEmptyTurn && turnMessage) {
            const replaySeq = this.messageSeq;
            const replayParams = turnMessage;
            this.logger.warn(
              { chatId, messageId: turnMessage.messageId, replaySeq },
              'Empty turn on a real-user message (Issue #4391): scheduling one-shot ' +
                'session reset + replay of the original input'
            );
            setTimeout(() => {
              // Async for the §6 history re-injection await below (the await
              // yields to the event loop; guards are re-checked after it).
              (async () => {
                // Issue #4391 (part 2 review): the disposed check is
                // ChatAgent's own `disposed` flag, NOT `!this.initialized` —
                // BaseAgent.initialized has no production path setting it
                // true, so that reading was always true in production (only
                // test mocks force it), silently disabling the replay.
                if (this.disposed || this.messageSeq !== replaySeq) {
                  this.logger.info(
                    {
                      chatId,
                      replaySeq,
                      currentSeq: this.messageSeq,
                      disposed: this.disposed,
                    },
                    'Empty-turn replay skipped (agent disposed or a newer message arrived) (Issue #4391)'
                  );
                  return;
                }
                // Issue #4391 (§6 history re-injection): re-stash recent chat
                // history BEFORE the teardown so the replayed message — the
                // fresh session's first — picks it up via the existing
                // consume-once first-message path in processMessage(). Without
                // this the fresh session's first message carries only the
                // session-start persistedHistoryContext snapshot: turns logged
                // after that snapshot are lost, exactly while recovering from
                // a stale session (long-lived chats lose the most). Best-effort:
                // on failure reloadFirstMessageHistory() logs and returns false,
                // and the replay proceeds on the stale snapshot (v1 behavior) —
                // re-injection must never block recovery.
                const reInjected = await this.historyManager.reloadFirstMessageHistory();
                // Re-check the guards AFTER the await: the fetch yields the
                // event loop, so a newer message (or dispose) may have landed
                // while re-injection was in flight. Without this second check
                // the teardown below would clobber that fresher input — the
                // exact hazard the seq guard exists to prevent. If we bail
                // here, the teardown never ran, so the newer message went into
                // the still-active OLD session — and it will consume the
                // re-stashed context on its next processMessage (the consume
                // runs on every message; the once-semantics come from the
                // stash being filled once). That is benign — the newer message
                // gets a fresh history snapshot attached — and the disposed
                // sub-case is trivially safe (no processMessage can follow).
                if (this.disposed || this.messageSeq !== replaySeq) {
                  this.logger.info(
                    {
                      chatId,
                      replaySeq,
                      currentSeq: this.messageSeq,
                      disposed: this.disposed,
                    },
                    'Empty-turn replay skipped after history re-injection ' +
                      '(agent disposed or a newer message arrived) (Issue #4391)'
                  );
                  return;
                }
                // Issue #4391 (§6 review follow-up): processMessage prefers an
                // incoming chatHistoryContext param over the consume-once
                // stash. Trigger-mode @mentions — the primary empty-turn
                // scenario this recovery targets — carry a receive-time
                // snapshot param, so replaying the original params unchanged
                // would leave the fresh stash unconsumed (and leaking onto a
                // later param-less message). When re-injection succeeded,
                // replay a COPY of the params with the stale param stripped so
                // the fresh fetch wins. Copy, never mutate: replayParams is
                // lastTurnMessage by reference. On a failed fetch keep the
                // param (v1 behavior — the snapshot beats context-less).
                const effectiveReplayParams = reInjected
                  ? (() => {
                      const { chatHistoryContext: _staleSnapshot, ...rest } = replayParams;
                      return rest as UserMessageParams;
                    })()
                  : replayParams;
                if (reInjected) {
                  this.logger.info(
                    { chatId, messageId: replayParams.messageId },
                    'Re-injected chat history into empty-turn replay context ' +
                      '(stale receive-time snapshot param dropped) (Issue #4391)'
                  );
                  // The single snapshot is consumed by the replay. Log paths
                  // survive independently; no second persisted stash is sent.
                }
                // Session-only teardown: close query+channel, keep this agent
                // (history, restartManager accounting, thread roots) intact.
                this.endEmptyTurnSession();
                void this.processMessage(effectiveReplayParams).catch((replayErr) => {
                  this.logger.error(
                    { err: replayErr, chatId },
                    'Empty-turn replay processMessage failed (Issue #4391)'
                  );
                });
              })().catch((schedErr) => {
                this.logger.error(
                  { err: schedErr, chatId },
                  'Empty-turn replay scheduling callback failed (Issue #4391)'
                );
              });
            }, 0);
          }

          // Issue #4322: a turn killed by an upstream API error (overloaded_error
          // / 5xx) is reported honestly instead of masked as ✅ Complete. The SDK
          // surfaces the failure only to stderr while still emitting a success
          // result; the provider tagged it (metadata.upstreamApiError). Send a
          // user-visible ❌ Failed notice — including the upstream request_id from
          // the stderr tail when available — and record the failure below so the
          // restart circuit can account for chronic upstream issues. Fire-and-
          // forget for the same reason as the empty-turn notice above.
          if (upstreamApiError) {
            this.logger.warn(
              {
                chatId,
                messageCount,
                toolCallCount,
                userVisibleOutputCount,
                model: this.model,
                provider: this.provider,
                stopReason: parsed.metadata?.stopReason,
                // upstreamApiErrorStderr lives at the top level of `parsed`
                // (hoisted by convertToLegacyFormat), NOT inside parsed.metadata
                // (which only carries tool/cost/token/stopReason fields).
                upstreamApiErrorStderr: parsed.upstreamApiErrorStderr,
              },
              'Turn ended via upstream API error but SDK emitted subtype=success result (Issue #4322). ' +
                'Reporting as failed instead of ✅ Complete.'
            );
            try {
              const upstreamThreadRoot = resolveReplyThreadRoot();
              // Surface the upstream request_id from the stderr tail if present,
              // so the failure is actionable (Issue #4322 direction 3).
              const stderrTail = (parsed.upstreamApiErrorStderr ?? '').trim();
              const requestIdMatch = stderrTail.match(/request_id["'\s:=]+([A-Za-z0-9]{16,})/);
              const requestId = requestIdMatch ? requestIdMatch[1] : undefined;
              const noticeLines = [
                '❌ 本轮被上游 API 错误（overloaded_error / 5xx）中断，未正常完成，请稍后重试。',
              ];
              if (requestId) {
                noticeLines.push(`upstream request_id: ${requestId}`);
              }
              await this.deliverUserVisible(chatId, noticeLines.join('\n'), upstreamThreadRoot);
            } catch (notifyErr) {
              this.logger.warn(
                { err: notifyErr, chatId },
                'Failed to send upstream-API-error notice (Issue #4322)'
              );
            }
          }

          // 2026-09-08: proxy mid-stream 中断(mid-stream 静默后 proxy 补的恢复正文带
          // MIDSTREAM_MARKER)。200 已锁,proxy 只能补「看似成功」的收尾 —— 这里把它识别回
          // 真实失败:会话健康 → 静默自动续跑一次(deployment 冷却过后再投,见
          // MIDSTREAM_RETRY_DELAY_MS);不可续(预算耗尽 / once-mode 计划任务 / 会话已关)
          // → 发 ❌。绝不落 recordSuccess,杜绝「假 ✅ Complete」。stopReason 不判(marker 才
          // 权威)。与 #4322 upstreamApiError 互斥(那边已发 ❌ + 记 upstream-api-error)。
          const midstreamInterrupted = sawMidstreamInterrupt && !upstreamApiError;
          if (midstreamInterrupted) {
            const willAutoContinue =
              this.midstreamAutoRetryAvailable &&
              !this.onceMode &&
              this.isSessionActive &&
              !this.disposed;
            if (willAutoContinue) {
              this.midstreamAutoRetryAvailable = false;
              const autoRetryDelayMs = midstreamRetryDelayMs();
              this.logger.warn(
                { chatId, messageCount, stopReason: parsed.metadata?.stopReason },
                'Mid-stream interruption: auto-continuing this session once after ' +
                  `${autoRetryDelayMs}ms (bounded; deployment cooldown respected)`
              );
              const autoReplaySeq = this.messageSeq;
              const autoThreadRootId = this.lastTurnMessage?.threadRootId;
              setTimeout(() => {
                // 与 #4391 同款 seq+disposed 守卫:期间来了更新的用户消息或已 dispose 则
                // 丢弃 —— 自动续跑绝不能插到用户新输入后面或复活已关会话。
                if (this.disposed || this.messageSeq !== autoReplaySeq) {
                  this.logger.info(
                    { chatId, autoReplaySeq, currentSeq: this.messageSeq },
                    'Mid-stream auto-continue dropped (agent disposed or a newer message arrived)'
                  );
                  return;
                }
                const nudge: UserMessageParams = {
                  chatId,
                  messageId: `auto-midstream-${Date.now()}`,
                  payload: '（上一轮上游响应中断，输出不完整。）请继续完成刚才的任务。',
                  threadRootId: autoThreadRootId,
                };
                void this.processMessage(nudge).catch((err) => {
                  this.logger.error(
                    { err, chatId },
                    'Mid-stream auto-continue processMessage failed'
                  );
                });
              }, autoRetryDelayMs);
            } else {
              this.logger.warn(
                { chatId, messageCount, onceMode: this.onceMode },
                'Mid-stream interruption but cannot auto-continue ' +
                  '(retry budget exhausted / once-mode / session closed): reporting ❌'
              );
              try {
                const midstreamThreadRoot = resolveReplyThreadRoot();
                await this.deliverUserVisible(
                  chatId,
                  '❌ 本轮被上游中断（响应中途停滞），输出不完整，任务可能未完成。请重新发送消息重试。',
                  midstreamThreadRoot
                );
              } catch (notifyErr) {
                this.logger.warn(
                  { err: notifyErr, chatId },
                  'Failed to send mid-stream-interruption notice'
                );
              }
            }
          }

          // Issue #4194: reset per-turn detection counters now that this turn's
          // checks are done, so the empty-turn warn above can fire on turn 2+.
          // processIterator runs once per persistent session (startAgentLoop is
          // only invoked when !isSessionActive); without this reset, toolCallCount
          // and userVisibleOutputCount accumulate across turns — after turn 1
          // produces any output/tools the empty-turn check can never be true
          // again, which is exactly the follow-up-turn scenario #4194 reports.
          // messageCount / startTime / firstMessageMs stay session-scoped: they
          // feed isStartupFailure() (packages/core/.../provider.ts) and the
          // "entire agent loop" timing summary below, both documented as
          // loop-level metrics — resetting them would misclassify mid-session
          // transient errors as startup/config failures.
          toolCallCount = 0;
          lastToolCallMs = undefined;
          userVisibleOutputCount = 0;
          sawMidstreamInterrupt = false;

          // Issue #4258 (part 2 / ③): an empty turn is a failure symptom, not
          // a success. recordSuccess would reset the restart failure counter,
          // so a chronically-broken session (only empty turns) could never
          // accumulate toward the circuit threshold and would appear
          // permanently unresponsive (#4194). recordFailure records the
          // failure and trips the circuit after maxRestarts, but — per its
          // contract (packages/core/.../restart-manager.ts) — does NOT trigger
          // an actual restart, so this is bounded and safe. Mirrors the GLM
          // stall handling above (recordFailure('stall')). Reset/retry (②)
          // remains a larger follow-up needing session-lifecycle design.
          // Record the most specific failure cause. When a turn is BOTH empty
          // and tagged upstreamApiError, prefer 'upstream-api-error' so the
          // recorded reason matches the ❌ notice surfaced above. recordFailure
          // only logs the label and bumps the failure count — the branch order
          // does not change circuit behavior (counting is reason-agnostic).
          if (upstreamApiError) {
            // Issue #4322: a turn killed by an upstream API error is a failure
            // symptom, not a success — record it so chronic upstream issues can
            // trip the restart circuit. Same bounded, non-restarting contract as
            // empty-turn / stall above. Turn-level retry is #4314's follow-up.
            this.restartManager.recordFailure(chatId, 'upstream-api-error');
          } else if (midstreamInterrupted && parsed.terminatedReason !== 'turn_failed') {
            // 2026-09-08: mid-stream 中断 turn(无论自动续跑与否)一律计入失败 —— 续跑成功
            // 会由下一 turn 的 recordSuccess 重置电路计数;中断本身不重置。与 #4322 同款
            // bounded、non-restarting 契约。
            this.restartManager.recordFailure(chatId, 'midstream-interrupt');
          } else if (isEmptyTurn && parsed.terminatedReason !== 'turn_failed') {
            this.restartManager.recordFailure(chatId, 'empty-turn');
          } else if (parsed.terminatedReason !== 'turn_failed') {
            // Record success to reset restart state
            this.restartManager.recordSuccess(chatId);
            // Issue #4391: a non-empty turn means the session is healthy —
            // re-arm the empty-turn retry for this chat (both when the retried
            // replay succeeded and when an ordinary turn just produced output).
            this.emptyTurnRetryPolicy.reset(chatId);
            // 2026-09-08: 真成功 = 健康间隙复位 → 重新武装 mid-stream 自动续跑预算
            // (语义「每个健康间隙续一次」)。
            this.midstreamAutoRetryAvailable = true;
          }

          this.logger.info({
            event: 'agent_turn', state: 'completed', chatId, user_visible: this.didDeliverUserVisibleThisTurn,
            circuitState: this.sendCircuitOpen ? 'open' : 'closed', ...this.activeLifecycleContext,
          }, 'agent_turn');

          // Issue #3985: Mark as not processing after receiving result.
          // The agent is now idle between turns — blocking tasks can execute.
          this.isProcessingMessage = false;

          // Issue #4063: Resolve per-turn completion promise (works in persistent mode)
          this.resolveTurn(currentTurnMessageId);

          if (this.callbacks.onDone) {
            const threadRoot = resolveReplyThreadRoot();
            await this.callbacks.onDone(chatId, threadRoot);
          }

          // Issue #4587 (part 1, review fix): turn boundary — re-arm the FIFO
          // consumption so the NEXT queued message's anchor (possibly another
          // thread's, pushed while this turn was draining) is adopted at the
          // next turn's first event. currentTurnAnchor keeps this turn's value
          // for the tail paths below (onDone above already ran; error paths
          // after a result are not expected but read the frozen value).
          turnAnchorConsumed = false;
          this.activeTurnMessageId = undefined;

          // Issue #3124: In once-mode, close channel after result to end the iterator.
          // This enables blocking one-shot execution via processMessage + taskComplete.
          if (this.onceMode) {
            this.logger.info({ chatId }, 'Once-mode: closing channel after result');
            this.isSessionActive = false;
            this.channel?.close();
            this.taskCompletionResolve?.();
            this.clearTaskCompletion();
          }
        }
      }
    } catch (error) {
      if (!this.stoppedQueryGenerations.has(myGeneration)) {
        iteratorError = error as Error;
        const elapsedMs = Date.now() - startTime; // Issue #2920: 计算耗时

        // Issue #3003: Log detailed timing on iterator error
        this.logger.error(
          {
            err: iteratorError,
            diagnosticId,
            ...this.activeLifecycleContext,
            chatId,
            messageCount,
            elapsedMs,
            ttftMs: firstMessageMs ? firstMessageMs - startTime : undefined,
            toolCallCount,
            errorMessage: iteratorError.message,
            errorStack: iteratorError.stack,
            errorName: iteratorError.constructor.name,
            errorCause: iteratorError.cause,
          },
          'Iterator error'
        );

        // Issue #2920: 检测启动阶段失败
        // 启动失败的特征：没有收到任何 SDK 消息且耗时很短。
        // 根因通常是配置错误（MCP 配置无效、API Key 过期等），
        // 重试无法解决，直接向用户展示具体错误。
        const classification = tagErrorCategory(iteratorError);
        if (isStartupFailure(messageCount, elapsedMs) && !classification.transient && classification.category !== 'UNKNOWN') {
          const stderr = getErrorStderr(iteratorError);
          const threadRoot = resolveReplyThreadRoot();

          this.logger.error(
            {
              chatId,
              messageCount,
              elapsedMs,
              stderr,
              diagnosticId,
            },
            'Startup failure detected — skipping retry/circuit-breaker'
          );

          // Issue #4626: isolated delivery — this catch-path notice throwing
          // used to escape processIterator into the outer "Agent loop error"
          // handler, which was the second kill in the incident chain (the same
          // invalid target rejects the error notice too).
          await this.deliverUserVisible(
            chatId,
            `❌ Agent 启动失败（${classification.category}）。诊断 ID: ${diagnosticId}\n\n` +
              '请检查配置、权限和运行环境。\n' +
              '请检查上述错误信息，修复后发送 /reset 重置会话。',
            threadRoot
          );

          // 启动失败不触发重试，直接标记会话为非活跃
          this.isSessionActive = false;
          this.isProcessingMessage = false;

          // Issue #4063: Reject per-turn completion on startup failure.
          // Issue #4649 (review ③): generation guard — a superseded iterator
          // (its session was replaced via reset / replay / restart) must not
          // settle the NEW session's entries; its own entries died with its
          // session and the replacement already settled them.
          if (this.sessionGeneration === myGeneration) {
            this.rejectTurn(iteratorError);
          }

          // Issue #3124: Reject completion promise on startup failure
          this.taskCompletionReject?.(iteratorError);
          this.clearTaskCompletion();

          if (this.callbacks.onDone) {
            await this.callbacks.onDone(chatId, threadRoot);
          }
          return; // 直接返回，不进入重启逻辑
        }

        // Notify user about the error
        {
          const threadRoot = resolveReplyThreadRoot();
          // Issue #4626: isolated delivery (see the startup-failure notice above
          // for why a throwing error-notice must not escape processIterator).
          await this.deliverUserVisible(
            chatId,
            `❌ 本次请求中断，结果可能不完整。诊断 ID: ${diagnosticId}。请先核对已经执行的操作，再决定是否重新提交。`,
            threadRoot
          );
        }

        // Issue #4063: Reject per-turn completion on runtime error.
        // Issue #4649 (review ③): generation guard — see the startup-failure
        // branch above for why a superseded iterator must not settle the
        // replacement session's entries.
        if (this.sessionGeneration === myGeneration) {
          this.rejectTurn(iteratorError);
        }

        // Issue #3124: Reject completion promise on runtime error
        this.taskCompletionReject?.(iteratorError);
        this.clearTaskCompletion();

        if (this.callbacks.onDone) {
          const threadRoot = resolveReplyThreadRoot();
          await this.callbacks.onDone(chatId, threadRoot);
        }
      }
    } finally {
      // Issue #4399 (#4208 P2-b): finalize the in-place streaming card on every
      // turn-exit path (normal result, stall, abort, iterator error). No-op
      // when streaming never started or the channel doesn't stream — the
      // driver's finish() is idempotent and only acts in the streaming state.
      if (streamDriver) {
        const finishThreadRoot = currentTurnAnchor ?? this.conversationOrchestrator.getThreadRoot(chatId);
        const terminalDelivered = await streamDriver.finish(finishThreadRoot);
        if (!terminalDelivered) {
          this.logger.error(
            { chatId, turnMessageId: currentTurnMessageId, ...this.activeLifecycleContext },
            'Streaming terminal delivery failed after fallback'
          );
        }
      }
    }

    // A user stop is a terminal outcome, not an unknown upstream failure.
    // Keep the generation check so late teardown cannot finish a replacement
    // session's REST request or turn-completion promises.
    if (this.stoppedQueryGenerations.delete(myGeneration)) {
      if (this.sessionGeneration === myGeneration) {
        const threadRoot = resolveReplyThreadRoot();
        const error = new Error('Agent turn cancelled by stop');
        this.rejectTurn(error);
        this.taskCompletionReject?.(error);
        this.clearTaskCompletion();
        await this.deliverUserVisible(chatId, '⏹️ 本轮已停止。', threadRoot);
        if (this.sessionGeneration !== myGeneration) { return; }
        await this.callbacks.onDone?.(chatId, threadRoot);
        if (this.sessionGeneration !== myGeneration) { return; }
        this.isSessionActive = false;
        this.isProcessingMessage = false;
        this.activeTurnMessageId = undefined;
      }
      return;
    }

    // Check if this was an explicit close (reset cleared the session)
    const wasExplicitClose = !this.isSessionActive;

    // Issue #3706 (GLM stall): the provider watchdog terminated the stream.
    // isSessionActive is still true here (we didn't flip it), so wasExplicitClose
    // is false — intercept BEFORE the "unexpected end" warn + auto-restart path
    // (a restart would immediately re-stall). Flip isSessionActive=false so the
    // next user message starts a fresh turn, while preserving conversation context.
    if (this.stalledTerminated) {
      this.stalledTerminated = false;
      this.isSessionActive = false;
      this.isProcessingMessage = false;
      this.logger.info(
        { chatId, messageCount },
        'GLM stall: terminated turn ended; suppressing auto-restart, context preserved'
      );
      return;
    }

    // Issue #4442 (part 3): the provider's synthetic empty-stream result ended
    // the turn — same interception as the stall path above. recordFailure was
    // already recorded in the result branch; an auto-restart here would just
    // re-run the turn without a user prompt. Flip isSessionActive so the next
    // user message starts a fresh turn, context preserved.
    if (this.emptyStreamTerminated) {
      this.emptyStreamTerminated = false;
      this.isSessionActive = false;
      this.isProcessingMessage = false;
      this.logger.info(
        { chatId, messageCount },
        'Empty stream: terminated turn ended; suppressing auto-restart, context preserved (Issue #4442)'
      );
      return;
    }

    // Issue #4391 (part 2 review): this invocation's session was torn down by
    // the empty-turn reset+replay. Timing: endEmptyTurnSession() closes this
    // iterator's query+channel, then the same timer callback synchronously
    // runs the replay's processMessage → startAgentLoop(), which re-sets
    // isSessionActive=true — BEFORE this parked iterator wakes from the close.
    // So the wasExplicitClose read above races and can be false even though
    // the teardown was deliberate; falling through would misroute this exit
    // into the unexpected-end / auto-restart path (false ⚠️ reconnect or 🚫
    // circuit-breaker notice per empty turn, plus clobbering the replay's
    // fresh session). Detect it structurally — the generation bumped past
    // myGeneration — and exit silently, the same interception shape as the
    // GLM-stall stalledTerminated path above. Touch no session state: the
    // replay's loop already owns it (isSessionActive, isProcessingMessage,
    // queryHandle, channel).
    if (this.sessionGeneration !== myGeneration && !wasExplicitClose) {
      this.logger.info(
        { chatId, messageCount, myGeneration, currentGeneration: this.sessionGeneration },
        'Empty-turn reset+replay: superseded session iterator ended; suppressing unexpected-end path (Issue #4391)'
      );
      return;
    }

    // Issue #3003: Log timing summary for the entire agent loop
    if (!wasExplicitClose) {
      const loopElapsedMs = Date.now() - startTime;
      this.logger.warn(
        {
          chatId,
          loopElapsedMs,
          messageCount,
          ttftMs: firstMessageMs ? firstMessageMs - startTime : undefined,
          toolCallCount,
          hadError: !!iteratorError,
        },
        'Agent loop ended unexpectedly — timing summary'
      );
    }

    if (wasExplicitClose) {
      this.logger.info({ chatId }, 'Agent loop completed (explicit close)');
      return;
    }

    // Iterator ended without explicit close - this is unexpected
    this.isSessionActive = false;
    this.isProcessingMessage = false;

    // Issue #3124: In once-mode, resolve completion and skip restart logic.
    // The channel was closed by the result handler or an error occurred.
    if (this.onceMode) {
      this.taskCompletionResolve?.();
      this.clearTaskCompletion();
      return;
    }

    // Iterator ended without explicit close - determine error message for restart logic
    const errorMessage = iteratorError?.message ?? 'Unknown error';
    // Classify the restart-triggering error before touching RestartManager.
    // Persistent configuration, validation, and permission errors already have
    // a user-visible diagnostic from the iterator catch above. They are a
    // terminal outcome for this session: a retry cannot repair them and must
    // neither consume restart state nor turn that diagnostic into a misleading
    // circuit-breaker or reconnect message.
    // Classify once via tagErrorCategory (returns {category, transient} from a
    // single pass + tags the error for downstream L1/L2 layers) rather than
    // calling classifyError() + isTransient() separately, which would classify
    // twice. Logged at `warn` to match the sibling timing-summary log above.
    if (iteratorError) {
      const { category, transient } = tagErrorCategory(iteratorError);
      this.logger.warn(
        {
          chatId,
          diagnosticId,
          errorCategory: category,
          transient,
          errorMessage,
        },
        'Agent loop ended unexpectedly; classified error for restart decision (Issue #4192 L0)'
      );
      // Keep the bounded recovery contract for opaque and operational
      // categories with ambiguous retry semantics. Only errors whose category
      // is explicitly a user-correctable, persistent failure are terminal.
      const terminalRuntimeCategory =
        category === 'CONFIGURATION' ||
        category === 'VALIDATION' ||
        category === 'PERMISSION';
      if (!transient && terminalRuntimeCategory) {
        this.logger.info(
          { chatId, errorCategory: category, errorMessage },
          'Non-transient runtime error: terminating session without restart (Issue #4989)'
        );
        return;
      }
    }
    // Issue #4314 (L2): pass the original (L0-tagged) error so RestartManager
    // reads the authoritative transient verdict from the tag instead of
    // re-classifying the bare message string (which loses the constructor name).
    const decision = this.restartManager.shouldRestart(chatId, errorMessage, iteratorError);

    if (!decision.allowed) {
      // Circuit breaker opened - notify user and stop
      this.logger.error(
        { chatId, diagnosticId, reason: decision.reason, restartCount: decision.restartCount },
        'Restart blocked by circuit breaker'
      );

      // Notify user that circuit breaker opened
      {
        const threadRoot = resolveReplyThreadRoot();
        const blockMessage = decision.reason === 'non_transient'
          ? `🚫 会话已暂停。请检查配置与权限，修复后发送 /reset。诊断 ID: ${diagnosticId}`
          : `🚫 自动恢复次数已用完，会话已暂停。请核对上次操作后发送 /reset。诊断 ID: ${diagnosticId}`;
        // Issue #4626: isolated delivery — a failing channel here must not
        // throw processIterator into the outer "Agent loop error" handler.
        await this.deliverUserVisible(chatId, blockMessage, threadRoot);
      }
      return;
    }

    // Restart allowed - apply backoff
    this.logger.warn(
      { chatId, diagnosticId, error: errorMessage, restartCount: decision.restartCount, waitMs: decision.waitMs },
      'Agent loop ended unexpectedly, attempting restart with backoff'
    );

    // Wait for backoff period
    if (decision.waitMs && decision.waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, decision.waitMs));
    }

    // A reset/stop/new request during backoff owns the replacement session.
    if (this.sessionGeneration !== myGeneration || this.isSessionActive || this.stoppedQueryGenerations.has(myGeneration)) {return;}
    const threadRoot = resolveReplyThreadRoot();
    const restartMessage = `⚠️ 会话正在重新连接，后续消息可继续处理。上次请求不会自动重放。诊断 ID: ${diagnosticId}`;
    // Issue #4626: isolated delivery (same rationale as the notices above).
    await this.deliverUserVisible(chatId, restartMessage, threadRoot);

    // Restart the agent loop to preserve context for future messages
    if (this.sessionGeneration !== myGeneration || this.isSessionActive || this.stoppedQueryGenerations.has(myGeneration)) {return;}
    this.startAgentLoop();
    this.logger.info({ chatId, diagnosticId }, 'Agent loop restarted');
  }

  /**
   * Issue #4391 (#4194 follow-up ②): session-only teardown for the empty-turn
   * reset+replay. Closes the current query + channel and marks the session
   * inactive so the NEXT processMessage() starts a fresh SDK session — the
   * replay runs against a clean session instead of the corrupted one.
   *
   * Deliberately narrower than `reset()`: history context, the restartManager
   * accounting, the thread root, and the inline MCP instances all survive, and
   * the still-running processIterator is NOT aborted (its channel closes, so
   * its generator drains and the iterator ends as a superseded session —
   * intercepted via the sessionGeneration check in processIterator, because
   * the replay's startAgentLoop() re-sets isSessionActive=true before the
   * parked iterator wakes, so the wasExplicitClose read alone would race;
   * same interception shape as the GLM-stall path, `stalledTerminated`).
   * startAgentLoop() rebuilds everything it needs on the replay.
   */
  private endEmptyTurnSession(): void {
    const chatId = this.boundChatId;
    this.logger.info({ chatId }, 'Ending session for empty-turn reset+replay (Issue #4391)');

    // Mark inactive BEFORE closing so the iterator end is read as an explicit
    // close (wasExplicitClose), not an unexpected loop end that would trigger
    // the auto-restart path below.
    this.isSessionActive = false;
    this.isProcessingMessage = false;

    if (this.queryHandle) {
      this.queryHandle.close();
      this.queryHandle = undefined;
    }
    if (this.channel) {
      this.channel.close();
      this.channel = undefined;
    }
  }

  /**
   * Reset the agent session (ChatAgent interface).
   *
   * Clears conversation history and state for this ChatAgent's bound chatId.
   * By default, does NOT reload history context after reset, giving a clean session.
   *
   * @param chatId - Optional chat ID (must match bound chatId if provided)
   * @param keepContext - If true, reloads history context after reset (default: false, uses config)
   */
  reset(chatId?: string, keepContext?: boolean): void {
    // Issue #644: If chatId is provided, it must match bound chatId
    if (chatId && chatId !== this.boundChatId) {
      this.logger.warn(
        { boundChatId: this.boundChatId, requestedChatId: chatId },
        'Reset called for different chatId, ignoring'
      );
      return;
    }

    this.logger.info({ chatId: this.boundChatId, keepContext }, 'Resetting ChatAgent session');

    // Issue #2926: Abort the running agent loop first so processIterator
    // breaks out of its for-await loop immediately, rather than continuing
    // to process buffered SDK messages.
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Mark session as inactive BEFORE closing to signal explicit close
    this.isSessionActive = false;
    this.isProcessingMessage = false;

    // Close channel and query
    if (this.channel) {
      this.channel.close();
      this.channel = undefined;
    }
    if (this.queryHandle) {
      this.queryHandle.close();
      this.queryHandle = undefined;
    }

    // Issue #4644: forget provider-side session state as well. Stream
    // teardown alone cannot cover it: the codex backend stashes an EVICTED
    // chat's thread anchor (so its next message resumes the conversation),
    // and eviction teardown deliberately keeps that stash — so a /reset while
    // the chat has no live stream (the eviction drain window, or after the
    // pool already disposed the agent) would otherwise resurrect the
    // conversation the user reset away. Optional capability — claude/pi
    // providers don't implement it and stay untouched.
    this.sdkProvider.forgetSession?.(this.sdkSessionKey);

    // Clear conversation context
    this.conversationOrchestrator.deleteThreadRoot(this.boundChatId);

    // Reset restart state
    this.restartManager.reset(this.boundChatId);

    // Clear persisted & first-message history context (Issue #955, #1230)
    this.historyManager.reset();

    // Issue #3124: Clear once-mode and task completion state
    this.onceMode = false;
    this.stalledTerminated = false; // Issue #3706: clear stall flag
    this.emptyStreamTerminated = false; // Issue #4442: clear empty-stream flag
    // Issue #4391 (part 2 review): a reset also supersedes any still-draining
    // iterator from the previous session (defense-in-depth alongside the
    // isSessionActive=false set above, which already reads as explicit close).
    this.sessionGeneration++;
    this.clearTaskCompletion();

    // Issue #4587 (part 1, review fix): drop pending turn anchors too — the
    // aborted iterator's finally block may still emit its error notice, and it
    // must not reply into a pre-reset thread; queued messages are gone with
    // the session.
    this.pendingTurnAnchors = [];
    this.pendingTurnMessageIds = [];
    this.pendingLifecycleContexts = [];

    // Issue #4063: Clear per-turn completion state
    this.rejectTurn(new Error('Agent reset'));

    // Issue #1213: Reload history only if explicitly requested via keepContext
    if (keepContext) {
      this.logger.info({ chatId: this.boundChatId }, 'Reloading history context after reset');
      this.historyManager.loadPersistedHistory().catch((err) => {
        this.logger.error(
          { err, chatId: this.boundChatId },
          'Failed to reload history after reset'
        );
        // Issue #1357: Notify user that context preservation failed
        this.callbacks
          .sendMessage(this.boundChatId, '⚠️ 重置后加载历史记录失败，当前会话无历史上下文。')
          .catch(() => {});
      });
    }
  }

  /**
   * Get the number of active sessions (always 0 or 1 for bound ChatAgent).
   */
  getActiveSessionCount(): number {
    return this.isSessionActive ? 1 : 0;
  }

  /**
   * Check if this ChatAgent has an active session.
   */
  hasActiveSession(): boolean {
    return this.isSessionActive;
  }

  /**
   * Stop the current query without resetting the session.
   * Issue #1349: /stop command
   *
   * Unlike reset(), this only interrupts the current streaming response
   * while preserving the session state and conversation context.
   * The user can continue the conversation after stopping.
   *
   * @param chatId - Optional chat ID (must match bound chatId if provided)
   * @returns true if a query was stopped, false if no active query
   */
  stop(chatId?: string): boolean {
    // Issue #644: If chatId is provided, it must match bound chatId
    if (chatId && chatId !== this.boundChatId) {
      this.logger.warn(
        { boundChatId: this.boundChatId, requestedChatId: chatId },
        'Stop called for different chatId, ignoring'
      );
      return false;
    }

    // Check if there's an active query to stop
    if (!this.queryHandle) {
      this.logger.debug({ chatId: this.boundChatId }, 'No active query to stop');
      return false;
    }

    this.logger.info({ chatId: this.boundChatId }, 'Stopping current query');
    this.stoppedQueryGenerations.add(this.sessionGeneration);

    // Issue #2926: Abort the running iterator so processIterator breaks
    // immediately instead of continuing to process buffered messages.
    if (this.abortController) {
      this.abortController.abort();
      // Note: A new AbortController will be created when the agent loop
      // restarts (via processIterator → startAgentLoop).
    }

    // Issue #3378: Close the current query (not cancel) to remove the exit listener
    // registered by ProcessTransport. cancel() only stops iteration but leaves
    // the exit listener registered, causing leaks when the agent loop restarts
    // (which creates a new ProcessTransport with a new exit listener).
    if (this.channel) {
      this.logger.info({ chatId: this.boundChatId }, 'stop: closing channel');
      this.channel.close();
      this.channel = undefined;
    }
    this.queryHandle.close();
    this.queryHandle = undefined;

    // Note: We do NOT set isSessionActive to false here.
    // processIterator settles the cancelled turn and ends this native query.
    // The next user message starts a fresh query through startAgentLoop().

    return true;
  }

  /** Apply an instruction to the currently executing native turn after backend acknowledgement. */
  async steer(prompt: string): Promise<{ ok: true; turnId: string } | { ok: false; error: string }> {
    type SteerCapableQueryHandle = QueryHandle & {
      steer(text: string): Promise<{ turnId: string }>;
    };
    const handle = this.queryHandle;
    const turnMessageId = this.activeTurnMessageId;
    if (!handle || !this.isBusy || !turnMessageId) {
      return { ok: false, error: 'No active turn to steer. The instruction was not queued.' };
    }
    if (typeof (handle as Partial<SteerCapableQueryHandle>).steer !== 'function') {
      return {
        ok: false,
        error: 'Immediate steer is unsupported by this backend. The instruction was not queued.',
      };
    }
    const generation = this.sessionGeneration;
    try {
      const acknowledgement = await (handle as SteerCapableQueryHandle).steer(prompt);
      if (
        this.queryHandle !== handle ||
        this.sessionGeneration !== generation ||
        this.activeTurnMessageId !== turnMessageId ||
        !this.isBusy
      ) {
        return { ok: false, error: 'The active turn changed before steer was acknowledged.' };
      }
      return { ok: true, turnId: acknowledgement.turnId };
    } catch (error) {
      return {
        ok: false,
        error: `Steer was rejected by the active backend: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Dispose of resources held by this agent.
   *
   * Implements Disposable interface (Issue #328).
   */
  dispose(): void {
    // Issue #4391 (part 2 review): mark disposed synchronously first, so a
    // replay timer firing mid-dispose (or right after) sees the flag.
    this.disposed = true;
    // Issue #3745: Synchronously close queryHandle and channel to prevent
    // exit listener leaks. The previous fire-and-forget pattern (dispose →
    // shutdown() without await) meant shutdown()'s `await Promise.resolve()`
    // deferred the close() calls to the next microtask. If a new agent was
    // created immediately after dispose() (e.g., scheduled task via InputMessageRouter),
    // the old exit listener was still registered when the new snapshot was
    // taken, making the cleanup blind to it.
    if (this.queryHandle) {
      this.queryHandle.close();
      this.queryHandle = undefined;
    }
    if (this.channel) {
      this.channel.close();
      this.channel = undefined;
    }

    // Issue #4063: Reject per-turn completion on dispose (agent eviction during turn)
    this.rejectTurn(new Error('Agent disposed'));

    // Fire-and-forget the rest of shutdown (abort, clear state, etc.)
    this.shutdown().catch((err) => {
      this.logger.error({ err }, 'Error during dispose shutdown');
    });
    // Call super.dispose() to mark as disposed
    super.dispose();
  }

  /**
   * Cleanup resources on shutdown.
   */
  async shutdown(): Promise<void> {
    this.logger.info({ chatId: this.boundChatId }, 'Shutting down ChatAgent');

    // Mark session as inactive
    this.isSessionActive = false;
    this.isProcessingMessage = false;

    // Issue #2926: Abort any running agent loop
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Close channel and query (may already be closed by dispose() — that's fine,
    // close() is idempotent since queryHandle/channel are set to undefined first)
    if (this.channel) {
      this.channel.close();
      this.channel = undefined;
    }
    if (this.queryHandle) {
      this.queryHandle.close();
      this.queryHandle = undefined;
    }

    // Clear conversation context
    this.conversationOrchestrator.clearAll();

    // Clear restart states
    this.restartManager.clearAll();

    this.logger.info({ chatId: this.boundChatId }, 'ChatAgent shutdown complete');

    // Yield to satisfy require-await lint rule; shutdown is intentionally synchronous
    // to ensure immediate cleanup (Issue #3745).
    await Promise.resolve();
  }
}
