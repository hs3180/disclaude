/**
 * Tests for Config.FEISHU_STREAMING_CARD — Issue #4510 (part 2).
 *
 * Covers:
 * - boolean values pass through unchanged (true / false / unset)
 * - the removed `'p2p'` scope enum (and any other non-boolean value) is
 *   treated as `false` with a warning instead of silently disabling nothing
 *
 * @see Issue #4400 (streamingCard flag)
 * @see Issue #4510 (part 2: zero-config p2p gate — enum removed)
 */

import { describe, it, expect, vi } from 'vitest';

const { mockConfig, mockWarn } = vi.hoisted(() => ({
  mockConfig: vi.fn(() => ({})),
  mockWarn: vi.fn(),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockConfig,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ warn: mockWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

// Config reads getConfigFromFile() once at module import, so re-import per case.
async function importConfigWith(streamingCard: unknown): Promise<boolean> {
  mockConfig.mockReturnValue({
    feishu: { appId: 'app', appSecret: 'secret', ...(streamingCard === undefined ? {} : { streamingCard }) },
  });
  mockWarn.mockClear();
  vi.resetModules();
  const { Config } = await import('./index.js');
  return Config.FEISHU_STREAMING_CARD;
}

describe('Config.FEISHU_STREAMING_CARD — Issue #4510 part 2 boolean-only flag', () => {
  it('passes true through unchanged', async () => {
    await expect(importConfigWith(true)).resolves.toBe(true);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('passes false through unchanged', async () => {
    await expect(importConfigWith(false)).resolves.toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('defaults to false when unset', async () => {
    await expect(importConfigWith(undefined)).resolves.toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('treats the removed \'p2p\' scope as false with a warning (no silent mismatch)', async () => {
    await expect(importConfigWith('p2p')).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const msg = mockWarn.mock.calls[0][1] as string;
    expect(msg).toContain('p2p');
    expect(msg).toContain('false');
  });

  it('treats any other non-boolean value as false with a warning', async () => {
    await expect(importConfigWith('all')).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});
