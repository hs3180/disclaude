import { describe, expect, it } from 'vitest';
import { WeChatChannel, normalizeProgressUpdates } from './wechat-channel.js';

/** #5453: channels.wechat.progressUpdates normalization on the channel. */
describe('WeChat progressUpdates normalization (#5453)', () => {
  it('defaults to enabled without coalescing (baseline behavior)', () => {
    expect(normalizeProgressUpdates(undefined)).toEqual({ enabled: true, minIntervalMs: 0 });
    expect(normalizeProgressUpdates(true)).toEqual({ enabled: true, minIntervalMs: 0 });
    expect(new WeChatChannel().progressDelivery).toEqual({ enabled: true, minIntervalMs: 0 });
  });

  it('false restores final-reply-only', () => {
    expect(normalizeProgressUpdates(false)).toEqual({ enabled: false, minIntervalMs: 0 });
    expect(new WeChatChannel({ progressUpdates: false }).progressDelivery).toEqual({ enabled: false, minIntervalMs: 0 });
  });

  it('object form enables the anti-flood window, bounded to [0, 10 minutes]', () => {
    expect(normalizeProgressUpdates({ minIntervalMs: 8_000 })).toEqual({ enabled: true, minIntervalMs: 8_000 });
    expect(normalizeProgressUpdates({})).toEqual({ enabled: true, minIntervalMs: 0 });
    expect(normalizeProgressUpdates({ minIntervalMs: 999_999_999 })).toEqual({ enabled: true, minIntervalMs: 600_000 });
    expect(normalizeProgressUpdates({ minIntervalMs: 2.9 })).toEqual({ enabled: true, minIntervalMs: 2 });
    expect(new WeChatChannel({ progressUpdates: { minIntervalMs: 8_000 } }).progressDelivery)
      .toEqual({ enabled: true, minIntervalMs: 8_000 });
  });
});
