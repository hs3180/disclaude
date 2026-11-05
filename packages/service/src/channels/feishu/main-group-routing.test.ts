/**
 * Tests for main-group routing (Issue #5396).
 *
 * Covers the redirect decision matrix (non-main project group → redirect;
 * main group / unmapped chat / disabled hints / non-group chats → proceed
 * normally) and the content-safety invariant: redirect replies carry the
 * main-group chatId and a busy-state summary only — never message content.
 */

import { describe, it, expect } from 'vitest';
import type { MappingEntry } from '@disclaude/core';
import {
  evaluateMainGroupRedirect,
  buildRedirectHint,
  buildMigrationGuidance,
  type MainGroupRoutingDeps,
  type MainGroupStoreLike,
} from './main-group-routing.js';

/** In-memory store fake: mirrors the structural slice the router needs. */
function makeStore(opts: { entries?: Array<{ chatId: string; workdir?: string }>; mainGroups?: Record<string, string> } = {}): MainGroupStoreLike {
  const entries: MappingEntry[] = (opts.entries ?? []).map((e) => ({
    chatId: e.chatId,
    createdAt: '2026-11-05T00:00:00.000Z',
    purpose: 'pr-review',
    ...(e.workdir !== undefined ? { workdir: e.workdir } : {}),
  }));
  const mainGroups = { ...opts.mainGroups };
  return {
    findEntryByChatId: (chatId: string) => Promise.resolve(entries.find((e) => e.chatId === chatId) ?? null),
    getMainGroup: (workdir: string) => Promise.resolve(mainGroups[workdir] ?? null),
    declareMainGroup: (workdir: string, chatId: string) => {
      const previousChatId = mainGroups[workdir] ?? null;
      mainGroups[workdir] = chatId;
      return Promise.resolve({ previousChatId, persisted: true });
    },
    clearMainGroup: (workdir: string) => Promise.resolve(delete mainGroups[workdir]),
  };
}

function makeDeps(opts: {
  store?: MainGroupStoreLike;
  enabled?: boolean;
  busy?: string;
} = {}): MainGroupRoutingDeps {
  return {
    store: opts.store ?? makeStore(),
    hintEnabled: () => opts.enabled ?? true,
    getBusySummary: () => opts.busy,
  };
}

const WORKDIR = '/data/workspace/proj-a';

describe('evaluateMainGroupRedirect (Issue #5396)', () => {
  it('redirects a task message arriving in a non-main group of a mapped project', async () => {
    const store = makeStore({
      entries: [{ chatId: 'oc_main', workdir: WORKDIR }, { chatId: 'oc_side', workdir: WORKDIR }],
      mainGroups: { [WORKDIR]: 'oc_main' },
    });
    const redirect = await evaluateMainGroupRedirect(makeDeps({ store }), { chatId: 'oc_side', chatType: 'group' });
    expect(redirect).toEqual({ mainChatId: 'oc_main', workdir: WORKDIR });
  });

  it('lets the declared main group itself proceed normally', async () => {
    const store = makeStore({
      entries: [{ chatId: 'oc_main', workdir: WORKDIR }],
      mainGroups: { [WORKDIR]: 'oc_main' },
    });
    expect(await evaluateMainGroupRedirect(makeDeps({ store }), { chatId: 'oc_main', chatType: 'group' })).toBeNull();
  });

  it('behaves exactly as before when no declaration exists (no mapping / single group)', async () => {
    const store = makeStore({ entries: [{ chatId: 'oc_only', workdir: WORKDIR }] });
    expect(await evaluateMainGroupRedirect(makeDeps({ store }), { chatId: 'oc_only', chatType: 'group' })).toBeNull();
  });

  it('ignores unmapped chats — no project context means no redirect', async () => {
    const store = makeStore({ mainGroups: { [WORKDIR]: 'oc_main' } });
    expect(await evaluateMainGroupRedirect(makeDeps({ store }), { chatId: 'oc_stranger', chatType: 'group' })).toBeNull();
  });

  it('ignores mapping entries without a workdir', async () => {
    const store = makeStore({ entries: [{ chatId: 'oc_side' }], mainGroups: { [WORKDIR]: 'oc_main' } });
    expect(await evaluateMainGroupRedirect(makeDeps({ store }), { chatId: 'oc_side', chatType: 'group' })).toBeNull();
  });

  it('never redirects p2p or topic chats', async () => {
    const store = makeStore({
      entries: [{ chatId: 'oc_side', workdir: WORKDIR }],
      mainGroups: { [WORKDIR]: 'oc_main' },
    });
    expect(await evaluateMainGroupRedirect(makeDeps({ store }), { chatId: 'oc_side', chatType: 'p2p' })).toBeNull();
    expect(await evaluateMainGroupRedirect(makeDeps({ store }), { chatId: 'oc_side', chatType: 'topic' })).toBeNull();
    expect(await evaluateMainGroupRedirect(makeDeps({ store }), { chatId: 'oc_side' })).toBeNull();
  });

  it('can be disabled by configuration (feishu.mainGroupRoutingHint: false)', async () => {
    const store = makeStore({
      entries: [{ chatId: 'oc_side', workdir: WORKDIR }],
      mainGroups: { [WORKDIR]: 'oc_main' },
    });
    expect(await evaluateMainGroupRedirect(makeDeps({ store, enabled: false }), { chatId: 'oc_side', chatType: 'group' })).toBeNull();
  });
});

describe('redirect hint content safety (Issue #5396)', () => {
  it('carries the main chatId and busy summary but never message content', () => {
    const redirect = { mainChatId: 'oc_main', workdir: WORKDIR };
    const text = buildRedirectHint(redirect, makeDeps({ busy: '有任务执行中' }));
    expect(text).toContain('oc_main');
    expect(text).toContain('有任务执行中');
    expect(text).toContain('/main-group');
    expect(text).not.toContain('正文');
    expect(text).not.toContain(WORKDIR); // hint stays in the group, no paths leaked
  });

  it('omits the busy line when no summary is available', () => {
    const text = buildRedirectHint({ mainChatId: 'oc_main', workdir: WORKDIR }, { store: makeStore(), hintEnabled: () => true });
    expect(text).not.toContain('主群当前状态');
  });
});

describe('migration guidance (Issue #5396)', () => {
  it('points the old group at the new main group without message content', () => {
    const text = buildMigrationGuidance({ oldChatId: 'oc_old', newChatId: 'oc_new', workdir: WORKDIR });
    expect(text).toContain('oc_new');
    expect(text).toContain(WORKDIR);
    expect(text).toContain('主群迁移');
    expect(text).not.toContain('oc_old'); // the old group knows where it is
  });
});
