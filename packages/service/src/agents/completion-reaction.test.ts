import { describe, it, expect, vi } from 'vitest';
import { addCompletionReaction } from './completion-reaction.js';

describe('bounded completion reactions', () => {
  it('returns after one successful request', async () => {
    const add = vi.fn().mockResolvedValue(true);
    await expect(addCompletionReaction(add, () => true)).resolves.toBe('added');
    expect(add).toHaveBeenCalledOnce();
  });
  it('retries a rejected request once', async () => {
    const add = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(true);
    await expect(addCompletionReaction(add, () => true)).resolves.toBe('added');
    expect(add).toHaveBeenCalledTimes(2);
  });
  it('bounds explicit failures to two requests', async () => {
    const add = vi.fn().mockResolvedValue(false);
    await expect(addCompletionReaction(add, () => true)).resolves.toBe('failed');
    expect(add).toHaveBeenCalledTimes(2);
  });
  it('does not retry a timeout with an unknown remote outcome', async () => {
    vi.useFakeTimers();
    try {
      const add = vi.fn(() => new Promise<boolean>(() => {}));
      const result = addCompletionReaction(add, () => true, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(result).resolves.toBe('timeout');
      expect(add).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('does not start or retry work for an obsolete session', async () => {
    const add = vi.fn().mockResolvedValue(false);
    await expect(addCompletionReaction(add, () => false)).resolves.toBe('cancelled');
    expect(add).not.toHaveBeenCalled();
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(addCompletionReaction(add, current)).resolves.toBe('cancelled');
    expect(add).toHaveBeenCalledOnce();
  });
});
