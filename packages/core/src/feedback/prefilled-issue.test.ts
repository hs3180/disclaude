import { describe, expect, it } from 'vitest';
import type { ChatFailureRecord } from './failure-registry.js';
import {
  createPrefilledIssueDraft,
  createPrefilledIssueUrl,
  MAX_PREFILLED_ISSUE_URL_LENGTH,
} from './prefilled-issue.js';

const record: ChatFailureRecord = {
  chatId: 'oc-private-chat', diagnosticId: 'diag-safe', failureClass: 'provider-stall',
  detail: 'stalled; token=do-not-publish', timestamp: '2026-11-05T14:00:00.000Z',
  backend: 'codex', provider: 'openai', sessionId: 'session-private', sourceMessageId: 'om-private',
};

describe('prefilled issue URL', () => {
  it('prefills bounded diagnostics without credentials, configuration or user identifiers', () => {
    const url = createPrefilledIssueUrl(record, '0.6.0');
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://github.com/hs3180/disclaude/issues/new');
    const body = parsed.searchParams.get('body')!;
    expect(body).toContain('diag-safe');
    expect(body).toContain('2026-11-05T14:00:00.000Z');
    expect(body).toContain('0.6.0');
    expect(body).toContain('codex');
    expect(body).toContain('[REDACTED]');
    expect(`${url}${body}`).not.toContain('do-not-publish');
    for (const id of ['oc-private-chat', 'session-private', 'om-private']) {
      expect(body).not.toContain(id);
    }
  });

  it('handles empty context and bounds very long fields', () => {
    const empty = createPrefilledIssueDraft({ ...record, diagnosticId: '', detail: '' }, '');
    expect(empty.body).toContain('unavailable');
    expect(empty.body).toContain('No error detail was captured.');
    const url = createPrefilledIssueUrl({ ...record, detail: '故障'.repeat(10_000) }, 'v'.repeat(10_000));
    expect(url.length).toBeLessThanOrEqual(MAX_PREFILLED_ISSUE_URL_LENGTH);
  });

  it('fails explicitly for an invalid target instead of returning a malformed URL', () => {
    expect(() => createPrefilledIssueUrl(record, '1', 'not-a-repository')).toThrow('Invalid issue repository');
  });
});
