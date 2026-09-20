import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchRunner } from './runner.js';
import { AgentFactory } from '../agents/factory.js';
import { ResearchDirectoryError, type ResearchProject } from './project.js';

vi.mock('../agents/factory.js', () => ({ AgentFactory: { createAgent: vi.fn() } }));
const directories: string[] = [];
afterEach(() => { vi.resetAllMocks(); directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'research-cwd-')); directories.push(dir); return dir; }
function project(workingDir?: string): ResearchProject {
  return { id: 'abcdef', workingDir, owner: 'alice', chat: 'chat', source: 'form', title: 'Question', scope: '', materials: '', status: 'running', revision: 1, createdAt: '', updatedAt: '', directions: [], summary: '', questions: [], history: [], feedback: [], stepCount: 0 };
}

describe('research execution directory', () => {
  it('uses the persisted binding rather than a changed default workspace', async () => {
    const bound = directory(), other = directory();
    vi.mocked(AgentFactory.createAgent).mockImplementation((_id, callbacks, options) => {
      expect(options?.cwdProvider?.('chat')).toBe(bound);
      return { runOnce: async () => { await callbacks.onTurnResult?.({ success: true, text: '{"state":"continue","message":"Check evidence","work":[],"feedback":[],"questions":[]}', truncated: false } as never); }, dispose: vi.fn() } as never;
    });
    await expect(createResearchRunner(other)(project(bound), new AbortController().signal)).resolves.toMatchObject({ state: 'continue', message: 'Check evidence' });
    expect(existsSync(join(other, '.research-work'))).toBe(false);
  });
  it('does not recreate a missing bound directory or start a model in a fallback', async () => {
    const root = directory(), missing = join(root, 'removed');
    await expect(createResearchRunner(root)(project(missing), new AbortController().signal)).rejects.toBeInstanceOf(ResearchDirectoryError);
    expect(AgentFactory.createAgent).not.toHaveBeenCalled();
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(root, '.research-work'))).toBe(false);
  });
});
