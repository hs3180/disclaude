import { describe, expect, it } from 'vitest';
import { configuredFeishuMessageBytes, splitFeishuMessage } from './feishu-message-chunker.js';

describe('splitFeishuMessage (Issue #4693)', () => {
  it('keeps UTF-8 text intact and bounded', () => {
    const source = '你好🙂'.repeat(30);
    const chunks = splitFeishuMessage(source, 32);
    expect(chunks.join('')).toBe(source);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 32)).toBe(true);
  });

  it('keeps fenced markdown chunks bounded', () => {
    const chunks = splitFeishuMessage(`\`\`\`ts\n${  'const value = 1;\n'.repeat(20)  }\`\`\``, 48);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 48)).toBe(true);
  });

  it('uses a positive configured limit or the safe default', () => {
    expect(configuredFeishuMessageBytes({ FEISHU_MAX_MESSAGE_BYTES: '123' } as NodeJS.ProcessEnv)).toBe(123);
    expect(configuredFeishuMessageBytes({ FEISHU_MAX_MESSAGE_BYTES: 'nope' } as NodeJS.ProcessEnv)).toBe(1_800_000);
  });
});
