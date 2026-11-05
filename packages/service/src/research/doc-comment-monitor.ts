/**
 * Bounded poller that watches registered research output documents for new
 * Feishu comments and routes each new comment batch back to the Project agent
 * that produced the research (T-089 / #5197).
 *
 * Polling model (Feishu comment subscription/events are UNKNOWN offline — if a
 * real event mechanism becomes available, `DocCommentSource` is the seam to
 * replace):
 * - One bounded loop per process: a setTimeout chain, never re-entrant
 *   (single-flight), interval clamped to [10s, 1h] (default 5 min).
 * - Per-document checkpoint in `{watchDir}/state.json` (atomic write):
 *   baseline flag, bounded processed-id ring, consecutive failures, backoff
 *   gate. The checkpoint is only advanced AFTER a batch is delivered, giving
 *   at-least-once delivery across restarts; poll overlap and duplicate events
 *   are suppressed by the processed-id ring.
 * - First poll of a newly registered document is a baseline pass: existing
 *   comments are recorded as seen but NOT delivered (registration happens at
 *   report delivery time; only feedback after that is new).
 * - Failures never advance the checkpoint and are always reported (logger +
 *   `onError`) — nothing is silently dropped. Transient failures (incl. rate
 *   limits, indistinguishable offline) back off exponentially per document
 *   with jitter, capped; permission errors back off the same way but keep
 *   their kind in reports so they are actionable.
 * - Delivery wakes the original Project agent (see service wiring); the
 *   monitor itself never edits documents, replies to comments, or answers —
 *   adoption / follow-up questions / reasoned rejection are the agent's call
 *   per the research-workflow skill.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '@disclaude/core';
import type {
  DocWatchIdentity,
  ResearchDocWatchRegistration,
} from './doc-watch-registry.js';
import {
  DocCommentSourceError,
  type DocCommentSource,
  type DocCommentThread,
} from './feishu-doc-comment-source.js';

const logger = createLogger('ResearchDocCommentMonitor');

const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
const MIN_POLL_INTERVAL_MS = 10_000;
const MAX_POLL_INTERVAL_MS = 60 * 60_000;
const DEFAULT_BACKOFF_BASE_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 30 * 60_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES_PER_POLL = 10;
const DEFAULT_PROCESSED_IDS_LIMIT = 256;
const DEFAULT_MAX_TRACKED_DOCS = 256;
const FIRST_TICK_DELAY_MS = 1_000;

/** One comment batch routed to the original project agent. */
export interface ResearchCommentNotification {
  monitor: 'research-doc-comment/v1';
  docToken: string;
  docType: string;
  /** Project chat whose agent receives the notification. */
  chatId: string;
  projectName?: string;
  identity: DocWatchIdentity;
  /** ISO timestamp of the poll that collected the batch. */
  fetchedAt: string;
  comments: DocCommentThread[];
}

/** Delivery sink — wakes the original research context's agent. */
export type ResearchCommentDelivery = (notification: ResearchCommentNotification) => Promise<void>;

/** Structured, explicit failure report — the "not silently dropped" channel. */
export interface MonitorErrorReport {
  docToken: string;
  chatId?: string;
  kind: string;
  message: string;
  consecutiveFailures: number;
  nextDelayMs: number;
  at: string;
}

export interface DocCommentMonitorOptions {
  /** Registration source; only registered documents are ever polled. */
  registry: { list(): Promise<ResearchDocWatchRegistration[]> };
  /** Comment source (lark-cli adapter in production, fakes in tests). */
  source: DocCommentSource;
  /** Notification sink. Throw to make the batch retried on the next poll. */
  deliver: ResearchCommentDelivery;
  /** Explicit error channel (in addition to logs). */
  onError?(report: MonitorErrorReport): void;
  /** Directory holding `state.json` (`.disclaude/research-doc-watch`). */
  watchDir: string;
  /** Poll interval, clamped to [10s, 1h]. Default 5 min. */
  pollIntervalMs?: number;
  /** First backoff delay (default 1 min). */
  backoffBaseMs?: number;
  /** Backoff cap (default 30 min). */
  maxBackoffMs?: number;
  /** Exponential factor (default 2). */
  backoffFactor?: number;
  /** Jitter fraction of the delay (default 0.2). */
  jitterRatio?: number;
  /** Comment page size (default 50). */
  pageSize?: number;
  /** Pagination cap per poll (default 10). Exceeding it fails the poll
   * explicitly instead of silently truncating. */
  maxPagesPerPoll?: number;
  /** Processed-id ring size per document (default 256). */
  processedIdsLimit?: number;
  /** Checkpoint entries kept for gone/re-registered docs (default 256). */
  maxTrackedDocs?: number;
  /** Injectable clock (tests). */
  now?(): number;
}

interface DocWatchState {
  baselineDone: boolean;
  processedIds: string[];
  consecutiveFailures: number;
  nextAttemptAtMs?: number;
  updatedAtMs: number;
  lastError?: { kind: string; message: string; at: string };
}

interface MonitorStateFile {
  version: 1;
  docs: Record<string, DocWatchState>;
}

function freshDocState(nowMs: number): DocWatchState {
  return { baselineDone: false, processedIds: [], consecutiveFailures: 0, updatedAtMs: nowMs };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function excerpt(text: string | undefined, limit: number): string {
  if (!text) { return '(无文本内容)'; }
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

function formatTime(ms: number | undefined): string {
  return ms === undefined ? '未知' : new Date(ms).toISOString();
}

/**
 * Agent-facing notification text. Self-contained (the agent may no longer hold
 * the document in context) and explicitly hands the judgement to the agent —
 * the monitor neither edits the report nor replies to comments.
 */
export function buildResearchCommentNotificationMessage(notification: ResearchCommentNotification): string {
  const project = notification.projectName ?? notification.chatId;
  const lines = [
    `【研究文档评论】项目「${project}」的研究输出文档收到 ${notification.comments.length} 条新评论。`,
    `(来自研究文档评论监控 ${notification.monitor};读取身份 ${notification.identity};获取时间 ${notification.fetchedAt})`,
    `文档:token ${notification.docToken}(类型 ${notification.docType})`,
    '',
    ...notification.comments.map(comment => [
      `- 评论 ${comment.commentId} | 作者 ${comment.authorName ?? comment.authorId ?? '未知'} | 创建 ${formatTime(comment.createdAtMs)}${comment.isWhole === true ? ' | 全文评论(is_whole,不支持原线程回复)' : ''}`,
      `  摘要:「${excerpt(comment.contentText, 120)}」${comment.replyCount !== undefined && comment.replyCount > 1 ? `(线程内 ${comment.replyCount} 条回复,请读取完整分页)` : ''}`,
    ].join('\n')),
    '',
    '请按 research-workflow 方法处理:先读取该文档正文与上述评论/回复的完整分页,再逐条判断采纳、需进一步核验并追问、或有依据地不采纳;修订与通知由你在原研究上下文中决定并执行,未经确认不要直接改写报告或自动答复评论。处理后请向用户说明重要反馈的处理结果与理由;未采纳的也要说明依据。',
  ];
  return lines.join('\n');
}

/**
 * Bounded comment poller with persisted checkpoints. Construct, `start()`, and
 * `stop()` on service lifecycle; `tick()` is public for tests and operators.
 */
export class DocCommentMonitor {
  private readonly options: Required<Pick<DocCommentMonitorOptions,
    'pollIntervalMs' | 'backoffBaseMs' | 'maxBackoffMs' | 'backoffFactor' | 'jitterRatio'
    | 'pageSize' | 'maxPagesPerPoll' | 'processedIdsLimit' | 'maxTrackedDocs'>>;
  private readonly registry: DocCommentMonitorOptions['registry'];
  private readonly source: DocCommentSource;
  private readonly deliver: ResearchCommentDelivery;
  private readonly onError?: (report: MonitorErrorReport) => void;
  private readonly now: () => number;
  private readonly statePath: string;
  private readonly stateTmpPath: string;

  private state: MonitorStateFile = { version: 1, docs: {} };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activeTick: Promise<void> | undefined;
  private running = false;

  constructor(options: DocCommentMonitorOptions) {
    this.registry = options.registry;
    this.source = options.source;
    this.deliver = options.deliver;
    this.onError = options.onError;
    this.now = options.now ?? (() => Date.now());
    this.statePath = join(options.watchDir, 'state.json');
    this.stateTmpPath = `${this.statePath}.tmp`;
    this.options = {
      pollIntervalMs: clamp(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS),
      backoffBaseMs: options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      backoffFactor: options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR,
      jitterRatio: options.jitterRatio ?? DEFAULT_JITTER_RATIO,
      pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
      maxPagesPerPoll: options.maxPagesPerPoll ?? DEFAULT_MAX_PAGES_PER_POLL,
      processedIdsLimit: options.processedIdsLimit ?? DEFAULT_PROCESSED_IDS_LIMIT,
      maxTrackedDocs: options.maxTrackedDocs ?? DEFAULT_MAX_TRACKED_DOCS,
    };
  }

  /** Start the bounded loop. Safe to call twice. */
  start(): void {
    if (this.running) { return; }
    this.loadState();
    this.running = true;
    this.scheduleTick(FIRST_TICK_DELAY_MS);
    logger.info(
      { pollIntervalMs: this.options.pollIntervalMs, trackedDocs: Object.keys(this.state.docs).length },
      'Research doc comment monitor started',
    );
  }

  /** Stop the loop and wait for an in-flight tick to settle. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.activeTick !== undefined) {
      await this.activeTick.catch(() => undefined);
      this.activeTick = undefined;
    }
    logger.info('Research doc comment monitor stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Ops/test view of the checkpoint. */
  getStatus(): { running: boolean; trackedDocs: number; docs: Record<string, Pick<DocWatchState, 'baselineDone' | 'consecutiveFailures' | 'processedIds' | 'lastError'>> } {
    const docs: Record<string, Pick<DocWatchState, 'baselineDone' | 'consecutiveFailures' | 'processedIds' | 'lastError'>> = {};
    for (const [token, state] of Object.entries(this.state.docs)) {
      docs[token] = {
        baselineDone: state.baselineDone,
        consecutiveFailures: state.consecutiveFailures,
        processedIds: [...state.processedIds],
        lastError: state.lastError,
      };
    }
    return { running: this.running, trackedDocs: Object.keys(this.state.docs).length, docs };
  }

  /** One poll cycle over all registered documents. Public for tests/ops. */
  async tick(): Promise<void> {
    let registrations: ResearchDocWatchRegistration[];
    try {
      registrations = await this.registry.list();
    } catch (error) {
      this.reportError('*', undefined, 'registry', error, 0, this.options.pollIntervalMs);
      return;
    }
    const registered = new Set(registrations.map(reg => reg.docToken));
    this.pruneState(registered);
    for (const registration of registrations) {
      await this.pollDoc(registration);
    }
  }

  private scheduleTick(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.activeTick = this.tick()
        .catch(error => {
          // tick() reports per-doc errors itself; this guards coding errors.
          logger.error({ err: error }, 'Research doc comment tick crashed');
        })
        .finally(() => {
          this.activeTick = undefined;
          if (this.running) {
            this.scheduleTick(this.options.pollIntervalMs);
          }
        });
    }, delayMs);
  }

  private async pollDoc(registration: ResearchDocWatchRegistration): Promise<void> {
    const nowMs = this.now();
    const state = this.state.docs[registration.docToken] ?? freshDocState(nowMs);
    this.state.docs[registration.docToken] = state;
    if (state.nextAttemptAtMs !== undefined && nowMs < state.nextAttemptAtMs) {
      logger.debug({ docToken: registration.docToken }, 'Research doc poll skipped (backoff)');
      return;
    }
    try {
      const threads = await this.fetchAllThreads(registration);
      if (!state.baselineDone) {
        // Baseline pass: pre-existing comments are seen, never delivered.
        state.processedIds = this.boundIds(threads.map(thread => thread.commentId));
        state.baselineDone = true;
        this.clearFailure(state, nowMs);
        state.updatedAtMs = nowMs;
        this.persistState();
        logger.info(
          { docToken: registration.docToken, chatId: registration.chatId, baselineComments: threads.length },
          'Research doc baseline recorded; future comments will notify the project agent',
        );
        return;
      }
      const seen = new Set(state.processedIds);
      const fresh = threads.filter(thread => !seen.has(thread.commentId));
      this.clearFailure(state, nowMs);
      if (fresh.length > 0) {
        try {
          await this.deliver({
            monitor: 'research-doc-comment/v1',
            docToken: registration.docToken,
            docType: registration.docType,
            chatId: registration.chatId,
            ...(registration.projectName !== undefined ? { projectName: registration.projectName } : {}),
            identity: registration.identity,
            fetchedAt: new Date(nowMs).toISOString(),
            comments: fresh,
          });
        } catch (error) {
          throw new CommentDeliveryError(error);
        }
        state.processedIds = this.boundIds([...state.processedIds, ...fresh.map(thread => thread.commentId)]);
      }
      state.updatedAtMs = nowMs;
      this.persistState();
    } catch (error) {
      this.recordFailure(registration, state, error, nowMs);
    }
  }

  private async fetchAllThreads(registration: ResearchDocWatchRegistration): Promise<DocCommentThread[]> {
    const threads: DocCommentThread[] = [];
    const seenCommentIds = new Set<string>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let pageIndex = 0; ; pageIndex++) {
      const page = await this.source.listComments({
        docToken: registration.docToken,
        docType: registration.docType,
        identity: registration.identity,
        ...(pageToken !== undefined ? { pageToken } : {}),
        pageSize: this.options.pageSize,
      });
      for (const thread of page.items) {
        if (seenCommentIds.has(thread.commentId)) {
          throw new DocCommentSourceError('invalid-response', 'duplicate comment_id within one poll');
        }
        seenCommentIds.add(thread.commentId);
        threads.push(thread);
      }
      if (!page.hasMore) { return threads; }
      pageToken = page.nextPageToken;
      if (pageToken === undefined || pageToken.length === 0 || seenPageTokens.has(pageToken)) {
        throw new DocCommentSourceError('invalid-response', 'invalid or repeated page token');
      }
      seenPageTokens.add(pageToken);
      if (pageIndex + 1 >= this.options.maxPagesPerPoll) {
        throw new DocCommentSourceError('transient',
          `pagination cap reached (${this.options.maxPagesPerPoll} pages); poll incomplete and will retry`);
      }
    }
  }

  private clearFailure(state: DocWatchState, nowMs: number): void {
    state.consecutiveFailures = 0;
    state.nextAttemptAtMs = undefined;
    state.lastError = undefined;
    state.updatedAtMs = nowMs;
  }

  private recordFailure(
    registration: ResearchDocWatchRegistration,
    state: DocWatchState,
    error: unknown,
    nowMs: number,
  ): void {
    state.consecutiveFailures += 1;
    const delayMs = this.backoffDelayMs(state.consecutiveFailures);
    state.nextAttemptAtMs = nowMs + delayMs;
    state.updatedAtMs = nowMs;
    state.lastError = {
      kind: errorKind(error),
      message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      at: new Date(nowMs).toISOString(),
    };
    this.persistState();
    this.reportError(registration.docToken, registration.chatId, state.lastError.kind, error, state.consecutiveFailures, delayMs);
  }

  private reportError(
    docToken: string,
    chatId: string | undefined,
    kind: string,
    error: unknown,
    consecutiveFailures: number,
    nextDelayMs: number,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const at = new Date(this.now()).toISOString();
    const context = { docToken, chatId, kind, consecutiveFailures, nextDelayMs, err: error };
    if (kind === 'permission' || consecutiveFailures <= 1 || docToken === '*') {
      logger.error(context, 'Research doc comment poll failed');
    } else {
      logger.warn(context, 'Research doc comment poll failed (retrying with backoff)');
    }
    try {
      this.onError?.({ docToken, chatId, kind, message: message.slice(0, 300), consecutiveFailures, nextDelayMs, at });
    } catch (callbackError) {
      logger.error({ err: callbackError }, 'Research doc comment onError callback failed');
    }
  }

  private backoffDelayMs(consecutiveFailures: number): number {
    const exponent = Math.min(consecutiveFailures - 1, 16);
    const base = Math.min(
      this.options.backoffBaseMs * Math.pow(this.options.backoffFactor, exponent),
      this.options.maxBackoffMs,
    );
    const jitter = base * this.options.jitterRatio * Math.random();
    return Math.min(Math.floor(base + jitter), this.options.maxBackoffMs);
  }

  private boundIds(ids: string[]): string[] {
    return ids.length > this.options.processedIdsLimit
      ? ids.slice(ids.length - this.options.processedIdsLimit)
      : ids;
  }

  /** Keep the checkpoint bounded; prefer dropping entries for unregistered docs. */
  private pruneState(registered: Set<string>): void {
    const tokens = Object.keys(this.state.docs);
    if (tokens.length <= this.options.maxTrackedDocs) { return; }
    const byRecency = tokens.sort((a, b) => this.state.docs[a].updatedAtMs - this.state.docs[b].updatedAtMs);
    let excess = tokens.length - this.options.maxTrackedDocs;
    const dropped: string[] = [];
    for (const token of byRecency) {
      if (excess <= 0) { break; }
      if (!registered.has(token)) {
        dropped.push(token);
        excess -= 1;
      }
    }
    for (const token of byRecency) {
      if (excess <= 0) { break; }
      if (!dropped.includes(token)) {
        dropped.push(token);
        excess -= 1;
      }
    }
    for (const token of dropped) { delete this.state.docs[token]; }
    if (dropped.length > 0) {
      logger.warn({ dropped: dropped.length }, 'Research doc checkpoint pruned to bound');
      this.persistState();
    }
  }

  private persistState(): void {
    try {
      mkdirSyncRecursive(this.statePath);
      writeFileSyncAtomic(this.statePath, this.stateTmpPath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      // Checkpoint persist failure is loud; delivery already happened, so the
      // worst case is a duplicate notification on restart (at-least-once).
      logger.error({ err: error, statePath: this.statePath }, 'Research doc checkpoint persist failed');
    }
  }

  private loadState(): void {
    try {
      const raw = readFileSyncText(this.statePath);
      const parsed = raw === undefined ? undefined : JSON.parse(raw) as unknown;
      if (parsed === undefined) { return; }
      if (typeof parsed !== 'object' || parsed === null ||
          (parsed as Record<string, unknown>).version !== 1 ||
          typeof (parsed as Record<string, unknown>).docs !== 'object') {
        throw new Error('state schema invalid');
      }
      const docs: Record<string, DocWatchState> = {};
      for (const [token, value] of Object.entries((parsed as { docs: Record<string, unknown> }).docs)) {
        if (typeof value !== 'object' || value === null) { continue; }
        const record = value as Record<string, unknown>;
        if (record.baselineDone !== true) { continue; }
        if (!Array.isArray(record.processedIds) || !record.processedIds.every(id => typeof id === 'string')) { continue; }
        docs[token] = {
          baselineDone: true,
          processedIds: record.processedIds as string[],
          consecutiveFailures: typeof record.consecutiveFailures === 'number' ? record.consecutiveFailures : 0,
          ...(typeof record.nextAttemptAtMs === 'number' ? { nextAttemptAtMs: record.nextAttemptAtMs } : {}),
          updatedAtMs: typeof record.updatedAtMs === 'number' ? record.updatedAtMs : 0,
          ...(isLastError(record.lastError) ? { lastError: record.lastError } : {}),
        };
      }
      this.state = { version: 1, docs };
    } catch (error) {
      // Corrupt/absent checkpoint: restart from per-doc baselines (safe — no
      // duplicate deliveries, existing comments are baselined, not replayed).
      logger.error({ err: error, statePath: this.statePath },
        'Research doc checkpoint unreadable; restarting from per-doc baselines');
      this.state = { version: 1, docs: {} };
    }
  }
}

function errorKind(error: unknown): string {
  if (error instanceof CommentDeliveryError) { return 'delivery'; }
  if (error instanceof DocCommentSourceError) { return error.kind; }
  return 'unexpected';
}

/** Tags delivery-sink failures so reports say "delivery", not a guess. */
class CommentDeliveryError extends Error {
  constructor(cause: unknown) {
    super(`comment notification delivery failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CommentDeliveryError';
  }
}

function isLastError(value: unknown): value is { kind: string; message: string; at: string } {
  if (typeof value !== 'object' || value === null) { return false; }
  const record = value as Record<string, unknown>;
  return typeof record.kind === 'string' && typeof record.message === 'string' && typeof record.at === 'string';
}

// Small sync-FS helpers: the monitor runs on a bounded tick where synchronous
// atomic writes (same write-tmp-then-rename pattern as ProjectManager) are
// simpler to reason about than interleaved async renames racing the next tick.
function mkdirSyncRecursive(file: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
}

function writeFileSyncAtomic(file: string, tmp: string, content: string): void {
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

function readFileSyncText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
    throw error;
  }
}
