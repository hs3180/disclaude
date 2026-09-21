import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectResearchStore } from './project.js';
import { ResearchManager } from './manager.js';

const roots: string[] = [];
const makeRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'disclaude-research-'));
  roots.push(root);
  return root;
};
const createInput = (overrides: Partial<Parameters<ResearchManager['create']>[0]> = {}) => ({
  owner: 'ou_owner',
  chatId: 'oc_chat',
  source: 'om_message',
  title: '核验目标',
  scope: '只核验一个结论',
  materials: 'https://example.test/source',
  ...overrides,
});
const checkpoint = (state: 'continue' | 'complete' = 'complete') => ({
  state,
  message: '完成一轮核验。',
  work: [
    {
      title: '核验来源',
      status: 'done' as const,
      findings: [
        {
          claim: '来源支持结论。',
          kind: 'fact' as const,
          sources: [{ title: '来源', location: 'https://example.test', excerpt: '原文片段' }],
        },
      ],
    },
  ],
  feedback: [],
  ...(state === 'complete' ? { summary: '已有来源支持，但样本有限。' } : {}),
  questions: [],
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ResearchManager', () => {
  it('persists a project in the active Project directory and starts an idempotent run', async () => {
    const root = makeRoot();
    const runner = vi.fn().mockResolvedValue(checkpoint());
    const manager = new ResearchManager({ store: new ProjectResearchStore(root), runner });
    const created = await manager.create(createInput());
    const duplicate = await manager.create(createInput());
    expect(duplicate.id).toBe(created.id);

    const started = await manager.act(created.id, 'ou_owner', 'oc_chat', 'start', {
      revision: created.revision,
    });
    await manager.idle(created.id);
    const finished = manager.get(created.id, 'ou_owner', 'oc_chat');
    expect(started.status).toBe('running');
    expect(finished.status).toBe('completed');
    expect(finished.directions[0]?.findings[0]?.sources[0]?.location).toBe('https://example.test');
    expect(runner).toHaveBeenCalledOnce();
    expect(new ProjectResearchStore(root).paths.state).toContain(
      path.join('.disclaude', 'research-state.json')
    );
    manager.dispose();
  });

  it('rejects stale controls and preserves an in-flight turn when paused', async () => {
    const root = makeRoot();
    let release: (() => void) | undefined;
    const runner = vi.fn().mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          release = () => resolve(checkpoint());
          signal.addEventListener('abort', () => resolve(checkpoint()), { once: true });
        })
    );
    const manager = new ResearchManager({ store: new ProjectResearchStore(root), runner });
    const created = await manager.create(createInput());
    await manager.act(created.id, 'ou_owner', 'oc_chat', 'start', { revision: created.revision });
    await expect(
      manager.act(created.id, 'ou_owner', 'oc_chat', 'pause', { revision: created.revision })
    ).rejects.toThrow(/changed/);
    const current = manager.get(created.id, 'ou_owner', 'oc_chat');
    const paused = await manager.act(created.id, 'ou_owner', 'oc_chat', 'pause', {
      revision: current.revision,
    });
    await manager.idle(created.id);
    expect(['pausing', 'paused']).toContain(paused.status);
    expect(manager.get(created.id, 'ou_owner', 'oc_chat').status).toBe('paused');
    release?.();
    manager.dispose();
  });

  it('marks a running project interrupted on a new manager and isolates actors', async () => {
    const root = makeRoot();
    const store = new ProjectResearchStore(root);
    const manager = new ResearchManager({ store, runner: vi.fn() });
    const created = await manager.create(createInput());
    // Simulate a process crash by preserving a running record without starting a runner.
    store.saveAll([{ ...created, status: 'running' }]);
    manager.dispose();

    const recovered = new ResearchManager({
      store: new ProjectResearchStore(root),
      runner: vi.fn(),
    });
    expect(recovered.get(created.id, 'ou_owner', 'oc_chat').status).toBe('interrupted');
    expect(() => recovered.get(created.id, 'ou_other', 'oc_chat')).toThrow(/does not exist/);
    recovered.dispose();
  });

  it('writes a traceable result to the linked document with a revision guard', async () => {
    const root = makeRoot();
    const writer = vi.fn().mockResolvedValue({ revision: 2 });
    const reader = vi.fn().mockResolvedValue({
      token: 'doc-token',
      revision: 1,
      body: '用户目标',
      rawBody: '用户目标',
      comments: [],
      fingerprint: 'base',
      syncedAt: '2026-01-01T00:00:00Z',
    });
    const runner = vi.fn().mockResolvedValue(checkpoint());
    const manager = new ResearchManager({
      store: new ProjectResearchStore(root),
      runner,
      readDocument: reader,
      writeDocument: writer,
    });
    const created = await manager.create({
      ...createInput(),
      document: { url: 'https://example.feishu.cn/docx/doc-token', token: 'doc-token' },
    });

    await manager.act(created.id, 'ou_owner', 'oc_chat', 'start', { revision: created.revision });
    await manager.idle(created.id);

    const finished = manager.get(created.id, 'ou_owner', 'oc_chat');
    expect(finished.status).toBe('completed');
    expect(finished.directions[0]?.findings).toHaveLength(1);
    expect(finished.document?.publishedFragments).toHaveLength(1);
    expect(finished.document?.publishedFragments[0]).toContain('核验目标');
    expect(finished.document?.publishedFragments[0]).toContain('https://example.test');
    expect(writer).toHaveBeenCalledOnce();
    expect(writer.mock.calls[0]?.[0]).toBe('doc-token');
    expect(writer.mock.calls[0]?.[1]).toBe(1);
    expect(reader).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it('keeps findings and exposes document write failures for a later retry', async () => {
    const root = makeRoot();
    const writer = vi.fn().mockRejectedValue(new Error('permission denied'));
    const reader = vi.fn().mockResolvedValue({
      token: 'doc-token',
      revision: 4,
      body: '用户目标',
      rawBody: '用户目标',
      comments: [],
      fingerprint: 'base',
      syncedAt: '2026-01-01T00:00:00Z',
    });
    const manager = new ResearchManager({
      store: new ProjectResearchStore(root),
      runner: vi.fn().mockResolvedValue(checkpoint()),
      readDocument: reader,
      writeDocument: writer,
    });
    const created = await manager.create({
      ...createInput(),
      document: { url: 'https://example.feishu.cn/docx/doc-token', token: 'doc-token' },
    });

    await manager.act(created.id, 'ou_owner', 'oc_chat', 'start', { revision: created.revision });
    await manager.idle(created.id);

    const finished = manager.get(created.id, 'ou_owner', 'oc_chat');
    expect(finished.status).toBe('completed');
    expect(finished.directions[0]?.findings[0]?.claim).toBe('来源支持结论。');
    expect(finished.document?.error).toContain('permission denied');
    expect(finished.history.some((entry) => entry.text.includes('成果已保留'))).toBe(true);
    manager.dispose();
  });
});
