/**
 * Tests for the on-demand research comment watch session host (T-089 rework /
 * #5197, review 6677596913).
 *
 * Session lifecycle is the contract under test: start begins the bounded poll
 * loop over explicit registrations, the checkpoint cursor advances only after
 * delivery, stop leaves nothing scheduled, and a later start resumes from the
 * persisted checkpoint without replay. Before any start the service is inert —
 * that zero-resident-cost guarantee is asserted too. The registry is the real
 * file-based implementation; the comment source and delivery are injected
 * fakes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MessageRouter as InputMessageRouter, SystemMessage } from '@disclaude/core';
import type { DocCommentSource, DocCommentPage, DocCommentThread } from './feishu-doc-comment-source.js';
import type { ResearchCommentNotification } from './doc-comment-monitor.js';
import {
  ResearchCommentWatchService,
  createResearchCommentDelivery,
} from './watch-service.js';

const tempDirs: string[] = [];
const services: ResearchCommentWatchService[] = [];
let clockMs = 1_700_000_000_000;

function thread(commentId: string): DocCommentThread {
  return {
    commentId,
    authorId: `ou_${commentId}`,
    authorName: `作者${commentId}`,
    contentText: `评论内容 ${commentId}`,
    createdAtMs: clockMs - 60_000,
    isWhole: false,
    replyCount: 1,
    raw: { comment_id: commentId },
  };
}

interface Harness {
  watchDir: string;
  service: ResearchCommentWatchService;
  pagesByToken: Map<string, () => DocCommentPage>;
  sourceError?: Error;
  listCalls: string[];
  delivered: ResearchCommentNotification[];
  deliverImpl?: (notification: ResearchCommentNotification) => Promise<void>;
}

function createHarness(): Harness {
  const watchDir = mkdtempSync(join(tmpdir(), 'research-watch-'));
  tempDirs.push(watchDir);
  const harness: Harness = {
    watchDir,
    pagesByToken: new Map(),
    listCalls: [],
    delivered: [],
    service: undefined as unknown as Harness['service'],
  };
  const source: DocCommentSource = {
    listComments: async request => {
      harness.listCalls.push(request.docToken);
      if (harness.sourceError) { throw harness.sourceError; }
      const factory = harness.pagesByToken.get(request.docToken);
      return await Promise.resolve(factory ? factory() : { items: [], hasMore: false });
    },
  };
  harness.service = new ResearchCommentWatchService({
    watchDir,
    source,
    deliver: async notification => {
      harness.delivered.push(notification);
      await harness.deliverImpl?.(notification);
    },
    pollIntervalMs: 10_000,
    now: () => clockMs,
  });
  services.push(harness.service);
  return harness;
}

beforeEach(() => {
  tempDirs.length = 0;
  services.length = 0;
  clockMs = 1_700_000_000_000;
  // Fake only the setTimeout chain the monitor loop uses. The real registry
  // reads/writes files, so the rest of the event loop (setImmediate, real I/O
  // completions) must keep running for ticks to settle — `until` below drives it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  // Stop any live session so fake-timer callbacks cannot leak across tests.
  for (const service of services) {
    await service.stop().catch(() => undefined);
  }
  vi.useRealTimers();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/**
 * Wait (bounded, real event-loop turns) until `predicate` holds — a tick's
 * real file I/O settles over a few setImmediate rounds after its fake timer
 * has fired.
 */
async function until(predicate: () => boolean, rounds = 200): Promise<void> {
  for (let round = 0; round < rounds && !predicate(); round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(predicate()).toBe(true);
}

describe('ResearchCommentWatchService — on-demand session lifecycle', () => {
  it('is inert before any start: no polling, no checkpoint, not running', async () => {
    const harness = createHarness();
    const status = await harness.service.status();
    expect(status.running).toBe(false);
    expect(status.registrations).toEqual([]);
    expect(status.docs).toEqual({});
    expect(status.recentErrors).toEqual([]);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.listCalls).toEqual([]);
    expect(existsSync(join(harness.watchDir, 'state.json'))).toBe(false);
    expect(harness.service.isRunning()).toBe(false);
  });

  it('start() begins the session; register→baseline→deliver→dedup advances the cursor', async () => {
    const harness = createHarness();
    const registered = await harness.service.register({ docToken: 'doxcnAbc123', chatId: 'oc_research_chat', projectName: '季度报告研究' });
    expect(registered.ok).toBe(true);

    let items = [thread('c1')];
    harness.pagesByToken.set('doxcnAbc123', () => ({ items, hasMore: false }));

    const startResult = await harness.service.start();
    expect(startResult.started).toBe(true);
    expect(startResult.status.running).toBe(true);
    expect(startResult.status.pollIntervalMs).toBe(10_000);
    expect(typeof startResult.status.startedAtMs).toBe('number');
    expect(startResult.status.registrations).toHaveLength(1);

    // First tick (1s delay): baseline pass — c1 seen, not delivered.
    await vi.advanceTimersByTimeAsync(1_000);
    await until(() => harness.listCalls.length === 1);
    expect(harness.listCalls).toEqual(['doxcnAbc123']);
    expect(harness.delivered).toEqual([]);

    // New comment c2 arrives → delivered with doc/author/time/project association.
    items = [thread('c1'), thread('c2')];
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => harness.delivered.length === 1);
    expect(harness.delivered).toHaveLength(1);
    const [notification] = harness.delivered;
    expect(notification).toMatchObject({ docToken: 'doxcnAbc123', chatId: 'oc_research_chat', projectName: '季度报告研究', identity: 'user' });
    expect(notification.comments.map(comment => comment.commentId)).toEqual(['c2']);

    // Poll overlap / duplicate events: next ticks do not redeliver.
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => harness.listCalls.length === 3);
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => harness.listCalls.length === 4);
    expect(harness.delivered).toHaveLength(1);

    const status = await harness.service.status();
    expect(status.docs['doxcnAbc123']).toMatchObject({ baselineDone: true, processedComments: 2, consecutiveFailures: 0 });
  });

  it('stop() ends the session: nothing scheduled afterwards, checkpoint kept', async () => {
    const harness = createHarness();
    await harness.service.register({ docToken: 'doxcnAbc123', chatId: 'oc_research_chat' });
    const items = [thread('c1')];
    harness.pagesByToken.set('doxcnAbc123', () => ({ items, hasMore: false }));
    await harness.service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await until(() => harness.listCalls.length === 1); // baseline

    const status = await harness.service.stop();
    expect(status.running).toBe(false);
    expect(harness.service.isRunning()).toBe(false);

    items.push(thread('c2'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.listCalls).toHaveLength(1);
    expect(harness.delivered).toEqual([]);
    // The checkpoint file survives for the next session.
    expect(existsSync(join(harness.watchDir, 'state.json'))).toBe(true);
  });

  it('restart after stop resumes from the checkpoint: no replay of delivered comments', async () => {
    const harness = createHarness();
    await harness.service.register({ docToken: 'doxcnAbc123', chatId: 'oc_research_chat' });
    const items = [thread('c1'), thread('c2'), thread('c3')];
    harness.pagesByToken.set('doxcnAbc123', () => ({ items, hasMore: false }));

    await harness.service.start();
    await vi.advanceTimersByTimeAsync(1_000); // baseline c1..c3
    await until(() => harness.listCalls.length === 1);
    await vi.advanceTimersByTimeAsync(10_000); // no new comments
    await until(() => harness.listCalls.length === 2);
    expect(harness.delivered).toEqual([]);
    await harness.service.stop();

    // New comment c4 lands while nobody is watching.
    items.push(thread('c4'));

    // Fresh session over the same watchDir: c1..c3 are checkpointed, only c4 is new.
    const restarted = await harness.service.start();
    expect(restarted.started).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await until(() => harness.delivered.length === 1);
    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0].comments.map(comment => comment.commentId)).toEqual(['c4']);
  });

  it('a second start while running is a no-op reporting started:false', async () => {
    const harness = createHarness();
    await harness.service.register({ docToken: 'doxcnAbc123', chatId: 'oc_research_chat' });
    harness.pagesByToken.set('doxcnAbc123', () => ({ items: [], hasMore: false }));
    await harness.service.start();
    const again = await harness.service.start({ pollIntervalMs: 60_000 });
    expect(again.started).toBe(false);
    expect(again.status.pollIntervalMs).toBe(10_000); // interval unchanged
    await vi.advanceTimersByTimeAsync(1_000);
    await until(() => harness.listCalls.length === 1);
  });

  it('registers validate strictly and invalid input is refused explicitly', async () => {
    const harness = createHarness();
    const badChat = await harness.service.register({ docToken: 'doxcnAbc123', chatId: 'x' });
    expect(badChat.ok).toBe(false);
    if (!badChat.ok) { expect(badChat.error).toContain('chatId'); }
    const badIdentity = await harness.service.register({ docToken: 'doxcnAbc123', chatId: 'oc_research_chat', identity: 'app' });
    expect(badIdentity.ok).toBe(false);
    if (!badIdentity.ok) { expect(badIdentity.error).toContain('identity'); }
    const badToken = await harness.service.register({ docToken: '../escape', chatId: 'oc_research_chat' });
    expect(badToken.ok).toBe(false);
  });

  it('only registered documents are polled; unregister drops the document', async () => {
    const harness = createHarness();
    await harness.service.register({ docToken: 'doxcnWatched', chatId: 'oc_research_chat' });
    await harness.service.register({ docToken: 'doxcnKept', chatId: 'oc_research_chat' });
    // Present in the source but never registered → never scanned.
    harness.pagesByToken.set('doxcnWatched', () => ({ items: [], hasMore: false }));
    harness.pagesByToken.set('doxcnKept', () => ({ items: [], hasMore: false }));
    harness.pagesByToken.set('doxcnUnrelated', () => ({ items: [thread('x')], hasMore: false }));
    await harness.service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await until(() => harness.listCalls.length === 2);
    expect(harness.listCalls).toEqual(['doxcnKept', 'doxcnWatched']);

    const removed = await harness.service.unregister('doxcnWatched');
    expect(removed.removed).toBe(true);
    const status = await harness.service.status();
    expect(status.registrations.map(reg => reg.docToken)).toEqual(['doxcnKept']);
    // Next tick runs (observable: doxcnKept is polled again) and drops the
    // unregistered document without ever touching the unrelated one.
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => harness.listCalls.length === 3);
    expect(harness.listCalls).toEqual(['doxcnKept', 'doxcnWatched', 'doxcnKept']);
  });

  it('source failures are reported explicitly with backoff and surface in status', async () => {
    const harness = createHarness();
    harness.sourceError = new Error('lark-cli exit 1');
    await harness.service.register({ docToken: 'doxcnAbc123', chatId: 'oc_research_chat' });
    await harness.service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    // The failure is recorded and checkpointed (state.json written) — that is
    // the explicit, non-silent error channel under test.
    await until(() => existsSync(join(harness.watchDir, 'state.json')));
    const status = await harness.service.status();
    expect(status.recentErrors).toHaveLength(1);
    expect(status.recentErrors[0]).toMatchObject({ docToken: 'doxcnAbc123', chatId: 'oc_research_chat', kind: 'unexpected' });
    expect(status.docs['doxcnAbc123'].consecutiveFailures).toBe(1);
    expect(status.docs['doxcnAbc123'].lastError?.kind).toBe('unexpected');
    expect(typeof status.docs['doxcnAbc123'].backoffUntilMs).toBe('number');
  });

  it('delivery failures do not advance the cursor and are retried after backoff', async () => {
    const harness = createHarness();
    await harness.service.register({ docToken: 'doxcnAbc123', chatId: 'oc_research_chat' });
    let items = [thread('c1')];
    harness.pagesByToken.set('doxcnAbc123', () => ({ items, hasMore: false }));
    await harness.service.start();
    await vi.advanceTimersByTimeAsync(1_000); // baseline c1
    await until(() => harness.listCalls.length === 1);

    items = [thread('c1'), thread('c2')];
    harness.deliverImpl = () => Promise.reject(new Error('router down'));
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => harness.delivered.length === 1);
    expect(harness.delivered).toHaveLength(1);
    const midStatus = await harness.service.status();
    expect(midStatus.docs['doxcnAbc123'].processedComments).toBe(1);
    expect(midStatus.recentErrors[0].kind).toBe('delivery');

    harness.deliverImpl = undefined;
    // Past the backoff gate (default base 60s + up to 20% jitter).
    clockMs += 90_000;
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => harness.delivered.length === 2);
    expect(harness.delivered).toHaveLength(2);
    expect(harness.delivered[1].comments.map(comment => comment.commentId)).toEqual(['c2']);
  });
});

describe('createResearchCommentDelivery', () => {
  it('routes a waitForCompletion system message to the original project chat', async () => {
    const routed: SystemMessage[] = [];
    const router = {
      route: (message: SystemMessage) => { routed.push(message); return Promise.resolve(); },
    } as unknown as InputMessageRouter;
    const deliver = createResearchCommentDelivery(() => router);
    await deliver({
      monitor: 'research-doc-comment/v1',
      docToken: 'doxcnAbc123',
      docType: 'docx',
      chatId: 'oc_research_chat',
      identity: 'user',
      fetchedAt: '2026-11-06T08:00:00.000Z',
      comments: [thread('c9')],
    });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      source: 'system',
      trigger: 'command',
      chatId: 'oc_research_chat',
      waitForCompletion: true,
    });
    expect(routed[0].id).toMatch(/^research-comment-/);
    expect(routed[0].payload).toContain('doxcnAbc123');
    expect(routed[0].data).toMatchObject({ docToken: 'doxcnAbc123', commentIds: ['c9'] });
  });

  it('fails explicitly when the router is not ready (deferred to the next poll)', async () => {
    const deliver = createResearchCommentDelivery(() => undefined);
    await expect(deliver({
      monitor: 'research-doc-comment/v1',
      docToken: 'doxcnX',
      docType: 'docx',
      chatId: 'oc_c',
      identity: 'user',
      fetchedAt: '2026-11-06T08:00:00.000Z',
      comments: [],
    })).rejects.toThrow(/InputMessageRouter not initialized/);
  });
});
