/**
 * Control handler types.
 *
 * @module control/types
 */

import type { ControlCommand, ControlResponse, ControlCommandType, ChannelCapabilities } from '../types/channel.js';
import type { Logger } from '../utils/logger.js';
import type { TriggerMode } from '../config/types.js';
import type { ProjectManager } from '../project/project-manager.js';
import type { ChatFailureRecord } from '../feedback/failure-registry.js';
import type { GoalStore, GoalRecord } from '../goals/goal-store.js';

/** Explicit channel request; the execution capability still owns current authorization. */
export interface GoalCommandExecutionRequest {
  goalId: string;
  expectedRevision: number;
  chatId: string;
  projectRoot: string;
  actorId: string;
  sourceMessageId: string;
  chatType?: 'p2p' | 'group' | 'topic';
  threadRootId?: string;
}

/**
 * Debug 组信息
 */
export interface DebugGroup {
  chatId: string;
  name?: string;
  setAt: number;
}

/**
 * 控制命令处理器上下文
 */
export interface ControlHandlerContext {
  /** Only configured by a user-message channel, never by the model-facing REST control endpoint. */
  goalStore?: GoalStore;
  /** Trusted user-channel execution capability. Absent hosts cannot activate goals. */
  goalExecution?: {
    start(request: GoalCommandExecutionRequest, action: 'activate' | 'resume'): Promise<{ record: GoalRecord }>;
    control(request: GoalCommandExecutionRequest, action: 'pause' | 'stop'): Promise<{ record: GoalRecord; settlement?: Promise<unknown> }>;
    /** Best-effort stop of the chat's running Goal without a revision token; `/stop` uses this (#5212). */
    stopForChat?(chatId: string, threadRootId?: string): boolean;
  };
  /** Optional host access policy; help uses exactly the same decision as dispatch. */
  isCommandAllowed?: (command: ControlCommand) => boolean;
  getHelpCapabilities?: () => ChannelCapabilities;
  guidance?: {
    isEnabled(chatId: string): boolean;
    setEnabled(chatId: string, enabled: boolean): void;
    claimPrompt?(chatId: string): boolean;
  };
  /** AgentPool 实例 */
  agentPool: {
    /** Issue #3696: skipContext=true skips history loading on next agent creation (when honored by the pool implementation) */
    reset(chatId: string, skipContext?: boolean): void;
    /** Chat-wide Project bindings affect ordinary and persistent topic sessions. */
    resetProjectSessions?(chatId: string): void;
    /** Refuse a binding change while any affected session still owns work. */
    isProjectBusy?(chatId: string): boolean;
    /** Issue #1349: Stop current query without resetting session */
    stop(chatId: string): boolean;
    /**
     * Issue #4587 (part 3): thread-scoped reset. Resets the topic-group
     * thread's agent (`chatId::threadRoot` slot) instead of the chat-scoped
     * one. Implementations that predate part 3 may omit this — the /reset
     * handler falls back to the chat-scoped `reset()`.
     */
    resetThread?(chatId: string, skipContext: boolean | undefined, threadRootId: string): void;
    /**
     * Issue #4587 (part 3): thread-scoped stop. Stops the topic-group
     * thread's agent instead of the chat-scoped one. Same fallback rule
     * as `resetThread`.
     */
    stopThread?(chatId: string, threadRootId: string): boolean;
    listAgentPresets?(): Array<{ name: string; agentBackend: string; model: string }>;
    getActiveAgentPreset?(chatId: string, threadRootId?: string):
      { name: string; agentBackend: string; model: string } | undefined;
    switchAgentPreset?(chatId: string, presetName: string, threadRootId?: string):
      | { ok: true; active: { name: string; agentBackend: string; model: string }; sessionBoundary: 'new-session' }
      | { ok: false; error: string };
    steer?(chatId: string, prompt: string, threadRootId?: string):
      Promise<{ ok: true; message: string } | { ok: false; error: string }>;
    canSteer?(chatId: string, threadRootId?: string): boolean;
  };

  /** Debug group settings, independent of any execution-node role. */
  debugGroups: {
    getDebugGroup(): DebugGroup | null;
    setDebugGroup(chatId: string, name?: string): void;
    clearDebugGroup(): DebugGroup | null;
  };

  /** 触发模式管理（可选） (Issue #2291: enum-based interface, #3345: 'auto' mode) */
  triggerMode?: {
    /** Get the current trigger mode for a chat */
    getMode(chatId: string): TriggerMode;
    /** Set the trigger mode for a chat */
    setMode(chatId: string, mode: TriggerMode): void;
  };

  /** ProjectManager for /project commands (Issue #3335) */
  projectManager?: ProjectManager;

  /**
   * Restart the entire service process (Issue #3807).
   * Called by /restart command to trigger graceful shutdown so the
   * launchd or Docker can restart the service.
   */
  shutdown?: () => Promise<void>;

  /**
   * Issue #5400: per-chat last-failure records backing /feedback (#5428).
   * The registry is fed by ChatAgent's failureRecorder wiring.
   */
  failureRegistry?: {
    get(chatId: string): ChatFailureRecord | undefined;
  };

  /** Version embedded in locally generated issue drafts. */
  serviceVersion?: string;

  /**
   * Issue #5400: channel hook that renders the sanitized confirmation card
   * for a failure record (Feishu interactive card). Absent → /feedback answers
   * with text-only guidance instead (#5428).
   */
  issueReporting?: {
    sendConfirmation(
      record: ChatFailureRecord,
      target: { chatId: string; threadRootId?: string; actorId?: string }
    ): Promise<{ ok: true } | { ok: false; error: string }>;
  };

  /**
   * Issue #5412: channel hook that delivers side discussions (支线讨论) for
   * /discuss. The command parses input and picks the venue in core; the hook
   * executes it on the platform (native thread/topic send, DM, record
   * persistence, conclusion flow-back). Absent → /discuss is unavailable.
   */
  sideDiscussions?: {
    /** Open a side venue and persist the source link. */
    open(request: SideDiscussionOpenRequest): Promise<{ ok: true; message: string } | { ok: false; error: string }>;
    /** Post a conclusion summary back to the source venue and mark the record concluded. */
    conclude(request: SideDiscussionConcludeRequest): Promise<{ ok: true; message: string } | { ok: false; error: string }>;
    /** Side-discussion summaries visible from a chat (source or venue). */
    list(chatId: string): Promise<SideDiscussionSummary[]>;
  };

  /** 日志记录器 */
  logger?: Logger;
}

/**
 * 载体类型（Issue #5412 选路面）：
 * - `topic-thread` — 话题群内新开原生话题（新根消息）
 * - `message-thread` — p2p/普通群以锚点消息开原生话题线程（reply_in_thread）
 * - `p2p` — 与发起人私聊承接
 * - `delegated-group` — 建群交给 start-discussion 交接（本命令不直接建群）
 */
export type SideVenueKind = 'topic-thread' | 'message-thread' | 'p2p' | 'delegated-group';

/** /discuss open request — context bundle for opening a side venue. */
export interface SideDiscussionOpenRequest {
  chatId: string;
  question: string;
  venue: Exclude<SideVenueKind, 'delegated-group'>;
  /** Thread anchor chosen by core (trigger message when replying, else the command message). */
  anchorMessageId?: string;
  /** Message the user replied to with /discuss, when any. */
  triggerMessageId?: string;
  /** The /discuss command message itself. */
  commandMessageId?: string;
  /** Thread root when the command was typed inside an existing topic. */
  threadRootId?: string;
  chatType?: 'p2p' | 'group' | 'topic';
  actorId?: string;
}

/** /discuss done request — conclusion flow-back. */
export interface SideDiscussionConcludeRequest {
  chatId: string;
  /** Explicit record id (`side-N`), when given. */
  id?: string;
  /** Thread root of the chat where /discuss done was typed (anchor resolution). */
  threadRootId?: string;
  summary: string;
  actorId?: string;
}

/** Persisted side-discussion summary surfaced by /discuss status. */
export interface SideDiscussionSummary {
  id: string;
  title: string;
  venue: SideVenueKind;
  /** Thread anchor for topic/message-thread venues. */
  anchorMessageId?: string;
  createdAt: string;
  status: 'open' | 'concluded';
}

/**
 * 单个命令的处理函数 (Issue #3529: generic over command type for typed data)
 */
export type CommandHandler<T extends ControlCommandType = ControlCommandType> = (
  command: ControlCommand<T>,
  context: ControlHandlerContext
) => Promise<ControlResponse> | ControlResponse;

/**
 * 命令定义
 */
export interface CommandDefinition<T extends ControlCommandType = ControlCommandType> {
  type: T;
  handler: CommandHandler<T>;
  description: string;
  usage?: string;
  isAvailable?: (context: ControlHandlerContext, command: ControlCommand) => boolean;
  /** A transient capability can be hidden in help without changing the command's error path. */
  showInHelp?: (context: ControlHandlerContext, command: ControlCommand) => boolean;
}
