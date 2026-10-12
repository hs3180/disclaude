/**
 * Tests for the Feishu slash-command router (Issue #4126 part 2).
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryHandleSlashCommand } from './command-router.js';
import { createControlCommand, createControlHandler, ProjectManager, type ControlResponse } from '@disclaude/core';

// Spy on createControlCommand so we can assert on the rawData the router builds
// (input.args), while delegating to the real impl so the other tests keep their
// realistic behavior. Issue #4196: senderOpenId/rawText were dead fields (dropped
// by normalizeCommandData before any handler saw them) and have been removed.
vi.mock('@disclaude/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@disclaude/core')>();
  return { ...mod, createControlCommand: vi.fn(mod.createControlCommand) };
});

function makeDeps(opts: { hasControlHandler?: boolean; controlResponse?: ControlResponse } = {}) {
  return {
    deps: {
      hasControlHandler: opts.hasControlHandler ?? false,
      emitControl: vi.fn().mockResolvedValue(opts.controlResponse ?? { success: false }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  };
}

const input = (text: string) => ({ textWithoutMentions: text, chatId: 'oc_x' });
const mentions = [{
  key: '@_user_1', name: '机器人',
  id: { open_id: 'ou_bot', union_id: 'on_bot', user_id: 'ut_bot' }, tenant_key: 'tenant',
}];

describe('tryHandleSlashCommand', () => {
  it.each([
    '/project use my project@home @_user_1',
    '/project use my project@home ${@_user_1}',
    '/project use my project@home @机器人',
    '/project use my project@home <at user_id="ou_bot">@机器人</at>',
    '/project @_user_1 use my project@home',
  ])('binds a real directory without persisting mention entities: %s', async (text) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'command-project-'));
    try {
      const projectDir = join(workspaceDir, 'my project@home');
      mkdirSync(projectDir);
      const pm = new ProjectManager({ workspaceDir });
      const reset = vi.fn();
      const deps = {
        hasControlHandler: true,
        emitControl: createControlHandler({
          projectManager: pm,
          agentPool: { reset, stop: () => false },
          debugGroups: { getDebugGroup: () => null, setDebugGroup: () => {}, clearDebugGroup: () => null },
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      expect(await tryHandleSlashCommand({ ...input(text), mentions, threadRootId: 'om_root' }, deps)).toBe(true);
      expect(new ProjectManager({ workspaceDir }).resolveCwd('oc_x').effectiveCwd).toBe(projectDir);
      const persisted = readFileSync(pm.getPersistPath(), 'utf8');
      expect(persisted).not.toContain('@_user_1');
      expect(deps.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        chatId: 'oc_x', threadId: 'om_root', text: expect.stringContaining('已切换工作目录'),
      }));

      // Invalid binding reports its error, leaves the old cwd intact, and does not reset it.
      deps.sendMessage.mockClear();
      expect(await tryHandleSlashCommand({ ...input('/project use missing @_user_1'), mentions }, deps)).toBe(true);
      expect(deps.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expect.stringContaining('不存在') }));
      expect(readFileSync(pm.getPersistPath(), 'utf8')).toBe(persisted);
      expect(reset).toHaveBeenCalledTimes(1);

      expect(await tryHandleSlashCommand({ ...input('/project reset@_user_1'), mentions }, deps)).toBe(true);
      expect(pm.resolveCwd('oc_x').reason).toBe('unbound');
      expect(reset).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it('does not strip conversation mentions or literal @ path characters', async () => {
    const { deps } = makeDeps({ hasControlHandler: true, controlResponse: { success: true } });
    expect(await tryHandleSlashCommand({ ...input('请让 @机器人 看一下'), mentions }, deps)).toBe(false);
    expect(deps.emitControl).not.toHaveBeenCalled();
    await tryHandleSlashCommand({ ...input('/project use project@机器人 @_user_1'), mentions }, deps);
    expect(deps.emitControl).toHaveBeenCalledWith(expect.objectContaining({ data: { subcommand: 'use', workingDir: 'project@机器人' } }));
  });

  it('returns false for non-command text', async () => {
    const { deps } = makeDeps();
    expect(await tryHandleSlashCommand(input('hello'), deps)).toBe(false);
    expect(deps.emitControl).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('handles /reset via fallback (no control handler)', async () => {
    const { deps } = makeDeps();
    expect(await tryHandleSlashCommand(input('/reset'), deps)).toBe(true);
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_x', text: expect.stringContaining('对话已重置') }));
  });

  it('handles /status via fallback', async () => {
    const { deps } = makeDeps();
    expect(await tryHandleSlashCommand(input('/status'), deps)).toBe(true);
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('状态') }));
  });

  it('handles /stop via fallback', async () => {
    const { deps } = makeDeps();
    expect(await tryHandleSlashCommand(input('/stop'), deps)).toBe(true);
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('停止') }));
  });

  it('relays control-handler message and returns true', async () => {
    const { deps } = makeDeps({ hasControlHandler: true, controlResponse: { success: true, message: 'triggered' } });
    expect(await tryHandleSlashCommand(input('/trigger'), deps)).toBe(true);
    expect(deps.emitControl).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'triggered' }));
  });

  it.each([true, false])('replies to the original thread for control success=%s', async (success) => {
    const { deps } = makeDeps({ hasControlHandler: true, controlResponse: { success, message: 'preset response' } });
    await tryHandleSlashCommand({ ...input('/agent use notebook063dl'), threadRootId: 'om_original' }, deps);
    expect(deps.sendMessage).toHaveBeenCalledExactlyOnceWith({
      chatId: 'oc_x', threadId: 'om_original', type: 'text', text: 'preset response',
    });
  });

  it.each(['reset', 'status', 'stop'])('keeps /%s fallback feedback in the original thread', async (command) => {
    const { deps } = makeDeps();
    await tryHandleSlashCommand({ ...input(`/${command}`), threadRootId: 'om_original' }, deps);
    expect(deps.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      chatId: 'oc_x', threadId: 'om_original', type: 'text',
    }));
  });

  it('keeps unmatched-control fallback feedback in the original thread', async () => {
    const { deps } = makeDeps({ hasControlHandler: true, controlResponse: { success: false } });
    await tryHandleSlashCommand({ ...input('/stop'), threadRootId: 'om_original' }, deps);
    expect(deps.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ threadId: 'om_original' }));
  });

  it('does not add a thread target to ordinary chat feedback', async () => {
    const { deps } = makeDeps({ hasControlHandler: true, controlResponse: { success: true, message: 'status' } });
    await tryHandleSlashCommand(input('/status'), deps);
    expect(deps.sendMessage).toHaveBeenCalledExactlyOnceWith({ chatId: 'oc_x', type: 'text', text: 'status' });
  });

  it('returns true on control success with no message (no sendMessage)', async () => {
    const { deps } = makeDeps({ hasControlHandler: true, controlResponse: { success: true } });
    expect(await tryHandleSlashCommand(input('/something'), deps)).toBe(true);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('falls through to reset fallback when control handler does not match', async () => {
    const { deps } = makeDeps({ hasControlHandler: true, controlResponse: { success: false } });
    expect(await tryHandleSlashCommand(input('/reset'), deps)).toBe(true);
    expect(deps.emitControl).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('对话已重置') }));
  });

  it('returns false for unrecognized command without control handler', async () => {
    const { deps } = makeDeps();
    expect(await tryHandleSlashCommand(input('/foobar'), deps)).toBe(false);
  });

  it('returns false for unrecognized command when control handler does not match', async () => {
    const { deps } = makeDeps({ hasControlHandler: true, controlResponse: { success: false } });
    expect(await tryHandleSlashCommand(input('/foobar'), deps)).toBe(false);
  });

  it('returns false for a bare "/" (no command word) without throwing', async () => {
    const { deps } = makeDeps();
    expect(await tryHandleSlashCommand(input('/'), deps)).toBe(false);
    expect(deps.emitControl).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('threads args into createControlCommand rawData (Issue #4196)', async () => {
    vi.mocked(createControlCommand).mockClear();
    const { deps } = makeDeps({ hasControlHandler: true, controlResponse: { success: true } });
    await tryHandleSlashCommand(
      { textWithoutMentions: '/trigger batch', chatId: 'oc_x' },
      deps,
    );
    // Issue #4587 part 3: the router now always passes a 4th extra arg —
    // undefined outside topic threads.
    expect(createControlCommand).toHaveBeenCalledWith(
      'trigger',
      'oc_x',
      { args: ['batch'] },
      undefined,
    );
  });

  it('forwards threadRootId on the emitted command (Issue #4587 part 3)', async () => {
    vi.mocked(createControlCommand).mockClear();
    const { deps } = makeDeps({ hasControlHandler: true, controlResponse: { success: true } });
    await tryHandleSlashCommand(
      { textWithoutMentions: '/reset', chatId: 'oc_x', threadRootId: 'om_root' },
      deps,
    );
    expect(createControlCommand).toHaveBeenCalledWith(
      'reset',
      'oc_x',
      { args: [] },
      { threadRootId: 'om_root' },
    );
  });

  it('omits the threadRootId extra when not in a thread (Issue #4587 part 3)', async () => {
    vi.mocked(createControlCommand).mockClear();
    const { deps } = makeDeps({ hasControlHandler: true, controlResponse: { success: true } });
    await tryHandleSlashCommand(
      { textWithoutMentions: '/reset', chatId: 'oc_x' },
      deps,
    );
    expect(createControlCommand).toHaveBeenCalledWith(
      'reset',
      'oc_x',
      { args: [] },
      undefined,
    );
  });
});
