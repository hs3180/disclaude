import { describe, expect, it } from 'vitest';
import type { ChatFailureRecord } from '@disclaude/core';
import { appendFailureReportLink } from './failure-report-link.js';

const record: ChatFailureRecord = {
  chatId: 'private-chat', diagnosticId: 'diag-1', failureClass: 'agent-loop-error',
  detail: 'boom', timestamp: '2026-11-05T14:00:00.000Z',
};

describe('failure report channel rendering', () => {
  it('uses a clickable Markdown link for Feishu text and cards fallback', () => {
    const result = appendFailureReportLink('ORIGINAL ERROR', record, '0.6.0', true);
    expect(result).toContain('ORIGINAL ERROR');
    expect(result).toContain('[打开预填 GitHub issue 上报此故障](https://github.com/');
  });

  it('uses a raw copyable URL for WeChat plain text', () => {
    const result = appendFailureReportLink('ORIGINAL ERROR', record, '0.6.0', false);
    expect(result).toContain('复制链接');
    expect(result).toContain('\nhttps://github.com/hs3180/disclaude/issues/new?');
    expect(result).not.toContain('[打开预填');
  });

  it('keeps the original error and gives explicit manual guidance when generation fails', () => {
    const result = appendFailureReportLink('ORIGINAL ERROR', record, '0.6.0', false, 'invalid');
    expect(result).toContain('ORIGINAL ERROR');
    expect(result).toContain('生成失败');
    expect(result).toContain('https://github.com/hs3180/disclaude/issues/new');
  });
});
