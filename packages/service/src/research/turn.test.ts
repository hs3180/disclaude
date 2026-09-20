import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFactory } from '../agents/factory.js';
import { runResearchTurn, ResearchTurnDirectoryError, type ResearchTurn } from './turn.js';

vi.mock('../agents/factory.js', () => ({ AgentFactory: { createAgent: vi.fn() } }));
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function input(): ResearchTurn {
  const root = mkdtempSync(join(tmpdir(), 'research-turn-'));
  roots.push(root);
  return { identity: 'task:maintenance:attempt:1', owner: 'alice', workingDir: root,
    prompt: 'Summarize the build failure from the supplied log.', signal: new AbortController().signal, timeoutMs: 1000 };
}

describe('bounded project task turn', () => {
  it('passes a non-research task unchanged and returns only final text without a stage schema', async () => {
    const request = input();
    const dispose = vi.fn();
    vi.mocked(AgentFactory.createAgent).mockImplementation((id, callbacks, options) => {
      expect(id).toBe(request.identity);
      expect(options?.cwdProvider?.('unrelated-chat')).toBe(request.workingDir);
      expect(options?.sdkSessionKey).toBe(id);
      const originalDirectory = request.workingDir;
      request.workingDir = '/changed-project';
      expect(options?.cwdProvider?.('unrelated-chat')).toBe(originalDirectory);
      return { runOnce: async (...args: unknown[]) => {
        expect(args).toEqual([id, request.prompt, id, request.owner]);
        await callbacks.sendMessage(id, 'Intermediate progress');
        await callbacks.onTurnResult?.({ success: true, text: 'Build failed because an input file is missing.', truncated: false } as never);
      }, dispose } as never;
    });
    await expect(runResearchTurn(request)).resolves.toBe('Build failed because an input file is missing.');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not start an agent or create a fallback for a missing project directory', async () => {
    const request = input();
    request.workingDir = join(request.workingDir, 'missing');
    await expect(runResearchTurn(request)).rejects.toBeInstanceOf(ResearchTurnDirectoryError);
    expect(AgentFactory.createAgent).not.toHaveBeenCalled();
    expect(existsSync(request.workingDir)).toBe(false);
  });

  it('does not construct an agent when cancelled before execution', async () => {
    const request = input();
    const controller = new AbortController(); controller.abort();
    await expect(runResearchTurn({ ...request, signal: controller.signal })).rejects.toThrow('interrupted');
    expect(AgentFactory.createAgent).not.toHaveBeenCalled();
  });

  it('disposes without starting if cancellation arrives during setup', async () => {
    const request = input();
    const controller = new AbortController();
    const runOnce = vi.fn(), dispose = vi.fn();
    vi.mocked(AgentFactory.createAgent).mockImplementation(() => {
      controller.abort();
      return { runOnce, dispose } as never;
    });
    await expect(runResearchTurn({ ...request, signal: controller.signal })).rejects.toThrow('interrupted');
    expect(runOnce).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['abort', 'timeout'] as const)('bounds an unresponsive turn on %s without reporting successful completion', async kind => {
    vi.useFakeTimers();
    const request = input();
    const controller = new AbortController();
    const dispose = vi.fn();
    let lateResult: (() => Promise<void>) | undefined;
    vi.mocked(AgentFactory.createAgent).mockImplementation((_id, callbacks) => {
      lateResult = async () => { await callbacks.onTurnResult?.({ success: true, text: 'Late result', truncated: false } as never); };
      return { runOnce: () => new Promise(() => {}), dispose } as never;
    });
    const run = runResearchTurn({ ...request, signal: controller.signal });
    const rejected = expect(run).rejects.toThrow(kind === 'abort' ? 'interrupted' : 'time budget exhausted');
    if (kind === 'abort') { controller.abort(); }
    else { await vi.advanceTimersByTimeAsync(request.timeoutMs); }
    await rejected;
    await lateResult?.();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ success: false, truncated: false }, { success: true, truncated: true }])('rejects incomplete results %j', async result => {
    const dispose = vi.fn();
    vi.mocked(AgentFactory.createAgent).mockImplementation((_id, callbacks) => ({
      runOnce: async () => { await callbacks.onTurnResult?.({ ...result, text: 'Partial output' } as never); }, dispose,
    } as never));
    await expect(runResearchTurn(input())).rejects.toThrow('did not finish');
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
