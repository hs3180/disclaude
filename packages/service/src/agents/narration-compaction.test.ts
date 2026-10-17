import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NARRATION_COMPACTION,
  compactNarrationPayloads,
} from './narration-compaction.js';

describe('compactNarrationPayloads', () => {
  it('passes ordinary narration through byte-identical', () => {
    const text = '权重进度：VAE 已就位；DiT 45.7%。等待期把预处理全部做完。';
    const result = compactNarrationPayloads(text);
    expect(result.compacted).toBe(false);
    expect(result.text).toBe(text);
  });

  it('keeps short fenced blocks intact', () => {
    const text = '```\nls -la\n```';
    const result = compactNarrationPayloads(text);
    expect(result.compacted).toBe(false);
    expect(result.text).toBe(text);
  });

  it('folds an oversized fenced payload to a one-line summary', () => {
    const signature = 'a'.repeat(300);
    const payload = `{"imageSource":"https://example.com/shot_01.png?UCloudPublicKey=TOKEN_x&Signature=${signature}","prompt":"Describe this image"}`;
    expect(payload.length).toBeGreaterThan(DEFAULT_NARRATION_COMPACTION.maxBlockChars);
    const text = `**🌐 Built-in Tool: analyze_image**\n\n**Input:**\n\`\`\`json\n${payload}\n\`\`\`\n*Executing on server...*`;
    const result = compactNarrationPayloads(text);
    expect(result.compacted).toBe(true);
    expect(result.foldedBlocks).toBe(1);
    // The preview keeps the payload's beginning but cuts the signature value.
    expect(result.text).toContain('shot_01.png');
    expect(result.text).not.toContain('aaaa');
    expect(result.text).toContain('payload 已折叠');
    expect(result.text).toContain('Built-in Tool: analyze_image');
    expect(result.text).toContain('*Executing on server...*');
    // Folded output is a single short line replacing the fence.
    expect(result.text.split('\n').every((line) => Array.from(line).length <= 300)).toBe(true);
  });

  it('folds an unterminated fence instead of letting a partial dump through', () => {
    const payload = `{"imageSource":"${'x'.repeat(400)}"}`;
    const result = compactNarrationPayloads(`**Input:**\n\`\`\`json\n${payload}`);
    expect(result.foldedBlocks).toBe(1);
    expect(result.text).toContain('payload 已折叠');
    // The bulk of the dump is gone; only the short preview remains.
    expect(result.text).not.toContain('x'.repeat(100));
    expect(result.text).not.toContain('```');
  });

  it('folds an oversized plain output line (no fence)', () => {
    const dump = `**analyze_image_result_summary:** [{"text": "${'The image shows a tunnel. '.repeat(20)}"}]`;
    expect(dump.length).toBeGreaterThan(DEFAULT_NARRATION_COMPACTION.maxLineChars);
    const result = compactNarrationPayloads(`**Output:**\n${dump}`);
    expect(result.compacted).toBe(true);
    expect(result.foldedLines).toBe(1);
    expect(result.text).toContain('payload 已折叠');
    expect(result.text).toContain('**Output:**');
    expect(result.text).not.toContain('tunnel. tunnel.');
  });

  it('folds multiple payloads in one message and counts them separately', () => {
    const long = 'y'.repeat(400);
    const result = compactNarrationPayloads(
      `\`\`\`json\n${long}\n\`\`\`\n中间一行普通叙述。\n${long}`
    );
    expect(result.foldedBlocks).toBe(1);
    expect(result.foldedLines).toBe(1);
    expect(result.text).toContain('中间一行普通叙述。');
  });

  it('truncates the preview on a code-point boundary', () => {
    const payload = `${'😀'.repeat(200)}`;
    const result = compactNarrationPayloads(payload, { maxLineChars: 50 });
    const summary = result.text;
    // Preview keeps at most previewChars code points and never a lone surrogate.
    expect(summary).not.toContain('�');
    expect(summary).toContain('payload 已折叠（200 字符）');
  });

  it('does not fold content exactly at the threshold', () => {
    const line = 'z'.repeat(DEFAULT_NARRATION_COMPACTION.maxLineChars);
    const result = compactNarrationPayloads(line);
    expect(result.compacted).toBe(false);
    expect(result.text).toBe(line);
  });
});
