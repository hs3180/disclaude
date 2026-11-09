/**
 * Unit tests for the research doc comment monitor (T-089 / #5197).
 *
 * Registry, comment source and delivery are injected fakes; the checkpoint is
 * a real file in a temp dir so restart-resume is exercised for real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ResearchDocWatchRegistration } from './doc-watch-registry.js';
import {
  DocCommentSourceError,
  type DocCommentSource,
  type DocCommentPage,
  type DocCommentThread,
} from './feishu-doc-comment-source.js';
import {
  DocCommentMonitor,
  buildResearchCommentNotificationMessage,
  type ResearchCommentNotification,
  type MonitorErrorReport,
} from './doc-comment-monitor.js';

const tempDirs: string[] = [];
let clockMs = 1_700_000_000_000;

function thread(commentId: string, overrides?: Partial<DocCommentThread>): DocCommentThread {
  return {
    commentId,
    authorId: `ou_${commentId}`,
    authorName: `作者${commentId}`,
    contentText: `评论内容 ${commentId}`,
    createdAtMs: clockMs - 60_000,
    isWhole: false,
    replyCount: 1,
    raw: { comment_id: commentId },
    ...overrides,
  };
}

function registration(overrides?: Partial<ResearchDocWatchRegistration>): ResearchDocWatchRegistration {
  return {
    docToken: 'doxcnAbc123',
    docType: 'docx',
    chatId: 'oc_research_chat',
    projectName: '季度报告研究',
    registeredAt: new Date(clockMs).toISOString(),
    identity: 'user',
    ...overrides,
  };
}

interface Harness {
  watchDir: string;
  registrations: ResearchDocWatchRegistration[];
  pagesByToken: Map<string, () => DocCommentPage>;
  listCalls: Array<{ docToken: string; pageToken?: string }>;
  delivered: ResearchCommentNotification[];
  deliverImpl?: (notification: ResearchCommentNotification) => Promise<void>;
  errors: MonitorErrorReport[];
  sourceError?: (docToken: string) => Error;
  createMonitor(overrides?: Partial<ConstructorParameters<typeof DocCommentMonitor>[0]>): DocCommentMonitor;
}

function createHarness(): Harness {
  const watchDir = mkdtempSync(join(tmpdir(), 'research-monitor-'));
  tempDirs.push(watchDir);
  const harness: Harness = {
    watchDir,
    registrations: [registration()],
    pagesByToken: new Map(),
    listCalls: [],
    delivered: [],
    errors: [],
    createMonitor(overrides) {
      const source: DocCommentSource = {
        listComments: async request => {
          harness.listCalls.push({ docToken: request.docToken, pageToken: request.pageToken });
          if (harness.sourceError) { throw harness.sourceError(request.docToken); }
          const factory = harness.pagesByToken.get(request.docToken);
          return await Promise.resolve(factory ? factory() : { items: [], hasMore: false });
        },
      };
      return new DocCommentMonitor({
        registry: { list: () => Promise.resolve([...harness.registrations]) },
        source,
        deliver: async notification => {
          harness.delivered.push(notification);
          await harness.deliverImpl?.(notification);
        },
        onError: report => { harness.errors.push(report); },
        watchDir,
        pollIntervalMs: 10_000,
        backoffBaseMs: 1_000,
        maxBackoffMs: 60_000,
        backoffFactor: 2,
        jitterRatio: 0,
        now: () => clockMs,
        ...overrides,
      });
    },
  };
  return harness;
}

beforeEach(() => {
  tempDirs.length = 0;
  clockMs = 1_700_000_000_000;
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('DocCommentMonitor', () => {
  it('first poll is a baseline: existing comments are seen but never delivered', async () => {
    const harness = createHarness();
    harness.pagesByToken.set('doxcnAbc123', () => ({ items: [thread('c1'), thread('c2')], hasMore: false }));
    const monitor = harness.createMonitor();

    await monitor.tick();

    expect(harness.delivered).toEqual([]);
    const status = monitor.getStatus();
    expect(status.docs['doxcnAbc123'].baselineDone).toBe(true);
    expect(status.docs['doxcnAbc123'].processedIds).toEqual(['c1', 'c2']);
  });

  it('delivers new comments mapped to doc/author/time/project and never redelivers them', async () => {
    const harness = createHarness();
    let items = [thread('c1')];
    harness.pagesByToken.set('doxcnAbc123', () => ({ items, hasMore: false }));
    const monitor = harness.createMonitor();
    await monitor.tick(); // baseline

    items = [thread('c1'), thread('c2', { authorName: '李四', createdAtMs: clockMs - 1_000, isWhole: true })];
    await monitor.tick();

    expect(harness.delivered).toHaveLength(1);
    const [notification] = harness.delivered;
    expect(notification.chatId).toBe('oc_research_chat');
    expect(notification.projectName).toBe('季度报告研究');
    expect(notification.docToken).toBe('doxcnAbc123');
    expect(notification.identity).toBe('user');
    expect(notification.comments).toHaveLength(1);
    expect(notification.comments[0].commentId).toBe('c2');
    expect(notification.comments[0].authorName).toBe('李四');
    expect(notification.comments[0].isWhole).toBe(true);

    // Poll overlap + duplicate events: same listing again → no second delivery.
    await monitor.tick();
    await monitor.tick();
    expect(harness.delivered).toHaveLength(1);
  });

  it('batches several new comments of one document into a single notification', async () => {
    const harness = createHarness();
    let items: DocCommentThread[] = [thread('c1')];
    harness.pagesByToken.set('doxcnAbc123', () => ({ items, hasMore: false }));
    const monitor = harness.createMonitor();
    await monitor.tick();

    items = [thread('c1'), thread('c3'), thread('c4')];
    await monitor.tick();

    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0].comments.map(comment => comment.commentId)).toEqual(['c3', 'c4']);
  });

  it('follows pagination and rejects repeated page tokens', async () => {
    const harness = createHarness();
    let call = 0;
    harness.pagesByToken.set('doxcnAbc123', () => {
      call += 1;
      if (call === 1) { return { items: [], hasMore: true, nextPageToken: 'same' }; }
      return { items: [], hasMore: true, nextPageToken: 'same' };
    });
    const monitor = harness.createMonitor();
    await monitor.tick();
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0].kind).toBe('invalid-response');
    expect(monitor.getStatus().docs['doxcnAbc123'].baselineDone).toBe(false);
  });

  it('fails explicitly when the pagination cap is hit instead of truncating silently', async () => {
    const harness = createHarness();
    harness.pagesByToken.set('doxcnAbc123', () => ({ items: [thread(`c${harness.listCalls.length}`)], hasMore: true, nextPageToken: `p${harness.listCalls.length}` }));
    const monitor = harness.createMonitor({ maxPagesPerPoll: 2 });
    await monitor.tick();

    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0].kind).toBe('transient');
    expect(harness.errors[0].message).toContain('pagination cap reached');
    expect(harness.delivered).toEqual([]);
  });

  it('reports source failures explicitly with per-doc backoff, then recovers', async () => {
    const harness = createHarness();
    harness.pagesByToken.set('doxcnAbc123', () => ({ items: [thread('c1')], hasMore: false }));
    const monitor = harness.createMonitor();

    // Failure 1 → transient, 1s backoff, checkpoint not advanced.
    harness.sourceError = () => new DocCommentSourceError('transient', 'boom');
    await monitor.tick();
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toMatchObject({ docToken: 'doxcnAbc123', chatId: 'oc_research_chat', kind: 'transient', consecutiveFailures: 1, nextDelayMs: 1_000 });
    expect(monitor.getStatus().docs['doxcnAbc123'].baselineDone).toBe(false);

    // Backoff gate: within the window the document is not polled again.
    const callsBefore = harness.listCalls.length;
    await monitor.tick();
    expect(harness.listCalls.length).toBe(callsBefore);
    expect(harness.errors).toHaveLength(1);

    // Failure 2 after the window → backoff doubles.
    clockMs += 1_000;
    await monitor.tick();
    expect(harness.errors[1]).toMatchObject({ kind: 'transient', consecutiveFailures: 2, nextDelayMs: 2_000 });

    // Recovery after the window: baseline succeeds, failures reset.
    clockMs += 2_000;
    harness.sourceError = undefined;
    await monitor.tick();
    const state = monitor.getStatus().docs['doxcnAbc123'];
    expect(state.baselineDone).toBe(true);
    expect(state.consecutiveFailures).toBe(0);
  });

  it('reports permission failures with their kind so they are actionable', async () => {
    const harness = createHarness();
    harness.sourceError = () => new DocCommentSourceError('permission', 'no access');
    const monitor = harness.createMonitor();
    await monitor.tick();
    expect(harness.errors[0].kind).toBe('permission');
  });

  it('does not advance the checkpoint when delivery fails, then redelivers after backoff', async () => {
    const harness = createHarness();
    let items = [thread('c1')];
    harness.pagesByToken.set('doxcnAbc123', () => ({ items, hasMore: false }));
    const monitor = harness.createMonitor();
    await monitor.tick(); // baseline c1

    items = [thread('c1'), thread('c2')];
    harness.deliverImpl = () => Promise.reject(new Error('router down'));
    await monitor.tick();
    expect(harness.delivered).toHaveLength(1);
    expect(harness.errors[0].kind).toBe('delivery');
    expect(monitor.getStatus().docs['doxcnAbc123'].processedIds).toEqual(['c1']);

    // Within the backoff window: no retry.
    await monitor.tick();
    expect(harness.delivered).toHaveLength(1);

    // After the window: redelivered (at-least-once), checkpoint advances.
    clockMs += 1_000;
    harness.deliverImpl = undefined;
    await monitor.tick();
    expect(harness.delivered).toHaveLength(2);
    expect(harness.delivered[1].comments.map(comment => comment.commentId)).toEqual(['c2']);
    expect(monitor.getStatus().docs['doxcnAbc123'].processedIds).toEqual(['c1', 'c2']);

    // And it is not delivered a third time.
    await monitor.tick();
    expect(harness.delivered).toHaveLength(2);
  });

  it('never polls documents that are not registered', async () => {
    const harness = createHarness();
    harness.registrations = [registration({ docToken: 'doxcnWatched' })];
    harness.pagesByToken.set('doxcnWatched', () => ({ items: [], hasMore: false }));
    // An unrelated document exists in the source fixture but has no registration.
    const monitor = harness.createMonitor();
    await monitor.tick();
    expect(harness.listCalls.map(call => call.docToken)).toEqual(['doxcnWatched']);
  });

  it('reports registry failures and skips the cycle without touching checkpoints', async () => {
    const harness = createHarness();
    const monitor = harness.createMonitor({
      registry: { list: () => Promise.reject(new Error('disk gone')) },
    });
    await monitor.tick();
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toMatchObject({ docToken: '*', kind: 'registry' });
    expect(harness.listCalls).toEqual([]);
  });

  it('resumes from the persisted checkpoint after a restart (no duplicate delivery)', async () => {
    const harness = createHarness();
    let items = [thread('c1')];
    harness.pagesByToken.set('doxcnAbc123', () => ({ items, hasMore: false }));
    const first = harness.createMonitor();
    await first.tick(); // baseline
    items = [thread('c1'), thread('c2')];
    await first.tick();
    expect(harness.delivered).toHaveLength(1);

    // "Restart": a fresh monitor over the same watchDir must not re-deliver.
    const second = harness.createMonitor();
    await second.tick();
    expect(harness.delivered).toHaveLength(1);
    expect(second.getStatus().docs['doxcnAbc123'].processedIds).toEqual(['c1', 'c2']);

    // Backoff state survives restarts too.
    const failing = harness.createMonitor();
    await failing.tick();
    harness.sourceError = () => new DocCommentSourceError('transient', 'x');
    await failing.tick();
    const persisted = JSON.parse(readFileSync(join(harness.watchDir, 'state.json'), 'utf8')) as {
      docs: Record<string, { consecutiveFailures: number; nextAttemptAtMs?: number }>;
    };
    expect(persisted.docs['doxcnAbc123'].consecutiveFailures).toBe(1);
    expect(persisted.docs['doxcnAbc123'].nextAttemptAtMs).toBe(clockMs + 1_000);
  });

  it('falls back to a fresh baseline when the checkpoint file is corrupt', async () => {
    const harness = createHarness();
    mkdirSync(join(harness.watchDir, 'docs'), { recursive: true });
    writeFileSync(join(harness.watchDir, 'state.json'), '{corrupt', 'utf8');
    harness.pagesByToken.set('doxcnAbc123', () => ({ items: [thread('c1')], hasMore: false }));
    const monitor = harness.createMonitor({ });
    monitor.start();
    await monitor.stop();
    // Corrupt state must not crash start(); the tick below baselines cleanly.
    await monitor.tick();
    expect(monitor.getStatus().docs['doxcnAbc123'].baselineDone).toBe(true);
    expect(harness.delivered).toEqual([]);
  });

  it('bounds the processed-id ring per document', async () => {
    const harness = createHarness();
    const many = Array.from({ length: 5 }, (_, index) => thread(`c${index}`));
    harness.pagesByToken.set('doxcnAbc123', () => ({ items: many, hasMore: false }));
    const monitor = harness.createMonitor({ processedIdsLimit: 3 });
    await monitor.tick();
    // Oldest ids fall out of the ring; the newest are kept.
    expect(monitor.getStatus().docs['doxcnAbc123'].processedIds).toEqual(['c2', 'c3', 'c4']);
  });

  it('runs a bounded timer chain: first tick, interval tick, stop cancels', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.pagesByToken.set('doxcnAbc123', () => ({ items: [], hasMore: false }));
    const monitor = harness.createMonitor();

    monitor.start();
    expect(monitor.isRunning()).toBe(true);
    expect(harness.listCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000); // FIRST_TICK_DELAY_MS
    expect(harness.listCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000); // pollIntervalMs
    expect(harness.listCalls).toHaveLength(2);

    await monitor.stop();
    expect(monitor.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.listCalls).toHaveLength(2);
  });

  it('start() is idempotent and a second start does not double the loop', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.pagesByToken.set('doxcnAbc123', () => ({ items: [], hasMore: false }));
    const monitor = harness.createMonitor();
    monitor.start();
    monitor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.listCalls).toHaveLength(1);
    await monitor.stop();
  });
});

describe('buildResearchCommentNotificationMessage', () => {
  it('contains the association fields and hands the decision to the agent', () => {
    const message = buildResearchCommentNotificationMessage({
      monitor: 'research-doc-comment/v1',
      docToken: 'doxcnAbc123',
      docType: 'docx',
      chatId: 'oc_research_chat',
      projectName: '季度报告研究',
      identity: 'user',
      fetchedAt: '2026-11-06T08:00:00.000Z',
      comments: [thread('c9', { authorName: '李四', createdAtMs: 1762400000000, contentText: '结论与来源二不符' })],
    });
    expect(message).toContain('doxcnAbc123');
    expect(message).toContain('季度报告研究');
    expect(message).toContain('c9');
    expect(message).toContain('李四');
    expect(message).toContain('2026-11-06T');
    expect(message).toContain('采纳');
    expect(message).toContain('追问');
    expect(message).toContain('不采纳');
    expect(message).toContain('不要直接改写报告或自动答复评论');
  });

  it('marks unresolvable fields as unknown and notes whole-document comments', () => {
    const message = buildResearchCommentNotificationMessage({
      monitor: 'research-doc-comment/v1',
      docToken: 'doxcnX',
      docType: 'docx',
      chatId: 'oc_c',
      identity: 'user',
      fetchedAt: '2026-11-06T08:00:00.000Z',
      comments: [thread('c1', { authorName: undefined, authorId: undefined, createdAtMs: undefined, isWhole: true, replyCount: 3 })],
    });
    expect(message).toContain('未知');
    expect(message).toContain('is_whole');
    expect(message).toContain('3 条回复');
  });
});
