import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFactory } from '../agents/factory.js';
import { createResearchRunner } from './runner.js';
import type { ResearchProject } from './project.js';

vi.mock('../agents/factory.js', () => ({ AgentFactory: { createAgent: vi.fn() } }));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function project(): ResearchProject {
  return {
    id: 'project-id', owner: 'alice', chat: 'chat-a', source: 'message-1',
    title: 'Compare the supplied reports', scope: 'Use only the supplied reports',
    materials: 'Report A and report B', status: 'running', revision: 1,
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
    directions: [], summary: '', questions: [], history: [], feedback: [], stepCount: 0,
  };
}

describe('Research runner prompt boundary', () => {
  it.fails('does not inherit outbound next-step card guidance for a synthetic Research identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'research-runner-discovery-')); roots.push(root);
    let options: unknown;
    vi.mocked(AgentFactory.createAgent).mockImplementation((_id, callbacks, createOptions) => {
      options = createOptions;
      return {
        runOnce: async () => { await callbacks.onTurnResult?.({ success: true, text: '{"directions":["Compare reports"]}', truncated: false } as never); },
        dispose: vi.fn(),
      } as never;
    });

    const runner = createResearchRunner(root);
    await runner(project(), { type: 'plan' }, new AbortController().signal);

    const messageBuilderOptions = (options as { messageBuilderOptions?: { suppressNextStepGuidance?: boolean } } | undefined)?.messageBuilderOptions;
    expect(messageBuilderOptions?.suppressNextStepGuidance).toBe(true);
  });
});
