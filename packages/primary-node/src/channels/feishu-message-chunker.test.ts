import { describe, expect, it } from 'vitest';
import {
  configuredFeishuMessageBytes,
  FEISHU_PLATFORM_MESSAGE_BYTES,
  FEISHU_RETRY_MESSAGE_BYTES,
  FEISHU_TRUNCATION_MARKER,
  truncateFeishuMessage,
} from './feishu-message-chunker.js';

describe('truncateFeishuMessage (Issue #4693)', () => {
  it('keeps the head and tail in one UTF-8-safe bounded message', () => {
    const source = '你好🙂'.repeat(30);
    const result = truncateFeishuMessage(source, 64);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(64);
    expect(result).toContain(FEISHU_TRUNCATION_MARKER);
    expect(result.startsWith('你好🙂')).toBe(true);
    expect(result.endsWith('你好🙂')).toBe(true);
  });

  it('does not alter text within the limit', () => {
    expect(truncateFeishuMessage('short', 32)).toBe('short');
  });

  it('rejects a limit too small for the marker', () => {
    expect(() => truncateFeishuMessage('long text', 1)).toThrow(/truncation marker/);
  });

  it('uses a positive configured limit or the safe default', () => {
    expect(
      configuredFeishuMessageBytes({ FEISHU_MAX_MESSAGE_BYTES: '123' } as NodeJS.ProcessEnv)
    ).toBe(123);
    expect(
      configuredFeishuMessageBytes({ FEISHU_MAX_MESSAGE_BYTES: 'nope' } as NodeJS.ProcessEnv)
    ).toBe(FEISHU_PLATFORM_MESSAGE_BYTES);
  });

  it('never allows configuration to exceed the platform hard ceiling', () => {
    expect(
      configuredFeishuMessageBytes({ FEISHU_MAX_MESSAGE_BYTES: '1800000' } as NodeJS.ProcessEnv)
    ).toBe(FEISHU_PLATFORM_MESSAGE_BYTES);
    expect(FEISHU_RETRY_MESSAGE_BYTES).toBeLessThan(FEISHU_PLATFORM_MESSAGE_BYTES);
  });
});
