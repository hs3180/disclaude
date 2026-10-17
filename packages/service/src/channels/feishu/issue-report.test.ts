import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { ChatFailureRecord, GitHubIssueClient, GitHubIssueResult } from '@disclaude/core';
import { FeishuIssueReport, composeIssueDraft } from './issue-report.js';

const record: ChatFailureRecord = {
  chatId: 'chat-1',
  diagnosticId: '44444444-4444-4444-8444-444444444444',
  failureClass: 'provider-turn-failed',
  detail: 'Provider aborted the turn; Bearer synthetic-report-secret',
  timestamp: '2026-10-17T16:00:00.000Z',
  backend: 'codex',
  sessionId: 'session-9',
  sourceMessageId: 'om-source',
};

function fixture(ensureIssue: GitHubIssueClient['ensureIssue'] = vi.fn()) {
  const patch = vi.fn().mockResolvedValue({ code: 0 });
  const reply = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'card-1' } });
  const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'card-1' } });
  const client = { im: { message: { patch, reply, create } } } as unknown as Client;
  const issueClient = { ensureIssue } as unknown as GitHubIssueClient;
  const report = new FeishuIssueReport(client, () => issueClient);
  const start = (
    target: { chatId: string; threadRootId?: string; actorId?: string } = {
      chatId: 'chat-1',
      actorId: 'alice',
    }
  ) => report.start(record, target);
  const confirm = (note?: string) => ({
    operator: { open_id: 'alice' },
    context: { open_chat_id: 'chat-1', open_message_id: 'card-1' },
    action: { name: buttonName(), form_value: note === undefined ? {} : { note } },
  });
  const buttonName = () => {
    const card = JSON.parse(
      create.mock.calls[0]?.[0]?.data?.content ?? reply.mock.calls[0]?.[0]?.data?.content
    );
    const form = card.body.elements.find((e: { tag: string }) => e.tag === 'form');
    return form.elements.find((e: { tag: string }) => e.tag === 'button').name;
  };
  const click = (op: string) => ({
    operator: { open_id: 'alice' },
    context: { open_chat_id: 'chat-1', open_message_id: 'card-1' },
    action: { name: buttonName(), value: { op } },
  });
  const lastCard = () => JSON.parse(patch.mock.calls.at(-1)![0].data.content);
  return { report, start, confirm, click, lastCard, patch, reply, create, ensureIssue };
}

describe('FeishuIssueReport', () => {
  it('sends a thread-reply confirmation card with the sanitized summary', async () => {
    const f = fixture();
    await f.start({ chatId: 'chat-1', threadRootId: 'om-thread', actorId: 'alice' });
    expect(f.reply.mock.calls[0][0].path.message_id).toBe('om-thread');
    const card = JSON.parse(f.reply.mock.calls[0][0].data.content);
    expect(JSON.stringify(card)).toContain(record.diagnosticId);
    expect(JSON.stringify(card)).toContain('待确认');
    expect(JSON.stringify(card)).not.toContain('synthetic-report-secret');
  });

  it('submits on confirm, passes the note, and paints the issue link', async () => {
    const ensureIssue = vi.fn().mockResolvedValue({
      ok: true,
      status: 'created',
      issueUrl: 'https://github.com/hs3180/disclaude/issues/5430',
      issueNumber: 5430,
    } satisfies GitHubIssueResult);
    const f = fixture(ensureIssue);
    await f.start();
    await f.report.submit(f.confirm('复现：断网后重试'));
    expect(ensureIssue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        diagnosticId: record.diagnosticId,
        body: expect.stringContaining('复现：断网后重试'),
      })
    );
    expect(JSON.stringify(f.lastCard())).toContain(
      'https://github.com/hs3180/disclaude/issues/5430'
    );
    expect(JSON.stringify(f.lastCard())).toContain('已提交');
    // Re-click after success does not submit again.
    await f.report.submit(f.confirm());
    expect(ensureIssue).toHaveBeenCalledTimes(1);
  });

  it('ignores other users and other chats', async () => {
    const ensureIssue = vi.fn();
    const f = fixture(ensureIssue);
    await f.start();
    await f.report.submit({ ...f.confirm(), operator: { open_id: 'mallory' } });
    await f.report.submit({
      ...f.confirm(),
      context: { open_chat_id: 'chat-2', open_message_id: 'card-1' },
    });
    expect(ensureIssue).not.toHaveBeenCalled();
  });

  it('keeps the report and offers retry after an explicit failure', async () => {
    const ensureIssue = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        kind: 'auth',
        error: 'HTTP 401',
      } satisfies GitHubIssueResult)
      .mockResolvedValueOnce({
        ok: true,
        status: 'created',
        issueUrl: 'https://github.com/hs3180/disclaude/issues/5431',
        issueNumber: 5431,
      } satisfies GitHubIssueResult);
    const f = fixture(ensureIssue);
    await f.start();
    await f.report.submit(f.confirm('first note'));
    const failedCard = f.lastCard();
    expect(JSON.stringify(failedCard)).toContain('鉴权失败');
    expect(JSON.stringify(failedCard)).toContain('重试提交');
    // Failure was reported as failure — no success claim anywhere.
    expect(JSON.stringify(failedCard)).not.toContain('已提交');
    await f.report.submit(f.click('retry'));
    expect(ensureIssue).toHaveBeenCalledTimes(2);
    // The note from the failed attempt is preserved on retry.
    expect(ensureIssue.mock.calls[1][0].body).toContain('first note');
    expect(JSON.stringify(f.lastCard())).toContain(
      'https://github.com/hs3180/disclaude/issues/5431'
    );
  });

  it('cancel stops without submitting', async () => {
    const ensureIssue = vi.fn();
    const f = fixture(ensureIssue);
    await f.start();
    await f.report.submit(f.click('cancel'));
    expect(JSON.stringify(f.lastCard())).toContain('已取消');
    expect(ensureIssue).not.toHaveBeenCalled();
  });

  it('fails explicitly when GitHub reporting is not configured', async () => {
    const patch = vi.fn().mockResolvedValue({ code: 0 });
    const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'card-1' } });
    const client = { im: { message: { patch, create } } } as unknown as Client;
    const report = new FeishuIssueReport(client, () => undefined);
    await report.start(record, { chatId: 'chat-1', actorId: 'alice' });
    const card = JSON.parse(create.mock.calls[0][0].data.content);
    const form = card.body.elements.find((e: { tag: string }) => e.tag === 'form');
    await report.submit({
      operator: { open_id: 'alice' },
      context: { open_chat_id: 'chat-1', open_message_id: 'card-1' },
      action: {
        name: form.elements.find((e: { tag: string }) => e.tag === 'button').name,
        form_value: {},
      },
    });
    const last = JSON.parse(patch.mock.calls.at(-1)![0].data.content);
    expect(JSON.stringify(last)).toContain('GitHub 上报未配置');
    expect(JSON.stringify(last)).not.toContain('已提交');
  });
});

describe('composeIssueDraft', () => {
  it('embeds the diagnostic id, sanitized detail and user note', () => {
    const draft = composeIssueDraft(
      record,
      '现象如描述；Authorization: Bearer synthetic-note-secret'
    );
    expect(draft.title).toContain('provider-turn-failed');
    expect(draft.title).toContain('(diag 44444444)');
    expect(draft.body).toContain(record.diagnosticId);
    expect(draft.body).toContain('Provider aborted the turn; [REDACTED AUTH]');
    expect(draft.body).toContain('现象如描述');
    expect(draft.body).not.toContain('synthetic-note-secret');
  });

  it('marks a missing note explicitly instead of inventing one', () => {
    expect(composeIssueDraft(record, undefined).body).toContain('（未填写）');
  });
});
