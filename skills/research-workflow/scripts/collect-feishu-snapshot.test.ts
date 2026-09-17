import { describe, expect, it, vi } from 'vitest';
import { collectFeishuSnapshot } from './collect-feishu-snapshot.mjs';
import { transition } from './state.mjs';

const document = { ok: true, data: { document: { document_id: 'doc', revision_id: 3, content: 'Keep `ß` and $(literal)\n' } } };
const page = (items: unknown[], more = false, token = '', extra = {}) =>
  ({ ok: true, data: { file_token: 'doc', has_more: more, page_token: token, items, ...extra } });
const reply = (id: string) => ({ reply_id: id, content: { elements: [{ type: 'text_run', text_run: { text: id + '\n' } }] } });
const start = '2026-09-18T00:00:00.000Z', end = '2026-09-18T00:00:10.000Z';

describe('live complete snapshot collection', () => {
  it('records completion after all comment/reply pages without changing their text', async () => {
    const responses = [document, page([{ comment_id: 'c1' }], true, 'c-next'), page([{ comment_id: 'c2' }]),
      page([reply('r1')], true, 'r-next', { comment_id: 'c1' }), page([reply('r2')], false, '', { comment_id: 'c1' }),
      page([reply('r3')], false, '', { comment_id: 'c2' })];
    const run = vi.fn(async (_args: string[]) => responses.shift());
    const now = vi.fn(() => { if (run.mock.calls.length) expect(responses).toHaveLength(0); return run.mock.calls.length ? end : start; });
    const result = await collectFeishuSnapshot('doc', 'bot', { run, now });
    expect(result.body).toBe(document.data.document.content);
    expect(result.comments).toEqual([{ id: 'c1:r1', body: 'r1\n' }, { id: 'c1:r2', body: 'r2\n' }, { id: 'c2:r3', body: 'r3\n' }]);
    expect(result.collection).toEqual({ startedAt: start, completedAt: end });
    expect(run.mock.calls[2][0]).toEqual(expect.arrayContaining(['--page-token', 'c-next']));
    expect(run.mock.calls[4][0]).toEqual(expect.arrayContaining(['--page-token', 'r-next']));
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('does not emit a completion timestamp after a failed page', async () => {
    const run = vi.fn().mockResolvedValueOnce(document).mockRejectedValueOnce(new Error('permission denied'));
    const now = vi.fn(() => start);
    await expect(collectFeishuSnapshot('doc', 'user', { run, now })).rejects.toThrow('permission denied');
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('stops repeated pagination tokens and rejects mismatched reply threads', async () => {
    const run = vi.fn().mockResolvedValueOnce(document).mockResolvedValue(page([], true, 'same'));
    await expect(collectFeishuSnapshot('doc', 'bot', { run })).rejects.toThrow('invalid_or_repeated_page_token');
    expect(run).toHaveBeenCalledTimes(3);
    const wrong = vi.fn().mockResolvedValueOnce(document).mockResolvedValueOnce(page([{ comment_id: 'c' }]))
      .mockResolvedValueOnce(page([reply('r')], false, '', { comment_id: 'other' }));
    await expect(collectFeishuSnapshot('doc', 'bot', { run: wrong })).rejects.toThrow('reply_thread_mismatch');
  });

  it('requires an explicit identity and treats a reversed clock as failure', async () => {
    const run = vi.fn().mockResolvedValueOnce(document).mockResolvedValueOnce(page([]));
    await expect(collectFeishuSnapshot('doc', undefined, { run })).rejects.toThrow('explicit_identity');
    expect(run).not.toHaveBeenCalled();
    const now = vi.fn().mockReturnValueOnce(end).mockReturnValueOnce(start);
    await expect(collectFeishuSnapshot('doc', 'user', { run, now })).rejects.toThrow('invalid_collection_clock');
  });

  it('keeps the observed collection time through sync and clears it for untimed legacy snapshots', () => {
    const initial = transition(null, 'init', { taskId: 'task', documentId: 'doc' });
    const snapshot = { documentId: 'doc', revision: '3', body: 'body', comments: [], complete: true };
    const timed = transition(initial, 'sync', { ...snapshot, collection: { startedAt: start, completedAt: end } });
    expect(timed.documentCollection.completedAt).toBe(end);
    expect(transition(timed, 'sync', { ...snapshot, revision: '4' }).documentCollection).toBeNull();
    expect(() => transition(timed, 'sync', { ...snapshot, collection: { startedAt: end, completedAt: start } })).toThrow('invalid_collection_time');
    expect(timed.documentCollection.completedAt).toBe(end);
  });
});
