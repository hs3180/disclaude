/**
 * Tests for the Feishu slash-command router (Issue #4126 part 2).
 */

import { describe, it, expect, vi } from 'vitest';
import { tryHandleSlashCommand } from './command-router.js';
import type { ControlResponse } from '@disclaude/core';

function makeDeps(opts: { hasControlHandler?: boolean; controlResponse?: ControlResponse } = {}) {
  return {
    deps: {
      hasControlHandler: opts.hasControlHandler ?? false,
      emitControl: vi.fn().mockResolvedValue(opts.controlResponse ?? { success: false }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  };
}

const input = (text: string) => ({ textWithoutMentions: text, chatId: 'oc_x', senderOpenId: 'ou_s' });

describe('tryHandleSlashCommand', () => {
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
});
