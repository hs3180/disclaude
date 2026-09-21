import { describe, expect, it, vi } from 'vitest';
import { changedDocumentFeedback, createDocumentWriter, documentToken } from './document-source.js';

describe('Research document source', () => {
  it('accepts only HTTPS docx links', () => {
    expect(documentToken('https://example.feishu.cn/docx/AbC123')).toBe('AbC123');
    expect(() => documentToken('https://example.feishu.cn/wiki/AbC123')).toThrow(/docx/);
    expect(() => documentToken('http://example.feishu.cn/docx/AbC123')).toThrow(/HTTPS/);
  });

  it('turns document body/comment changes into traceable pending feedback', () => {
    const previous = {
      token: 'doc',
      revision: 1,
      body: 'old',
      comments: [{ id: 'c1', text: '旧意见' }],
      fingerprint: 'old',
      syncedAt: '2026-01-01T00:00:00Z',
    };
    const next = {
      token: 'doc',
      revision: 2,
      body: 'new',
      comments: [
        { id: 'c1', text: '新意见' },
        { id: 'c2', text: '新增意见' },
      ],
      fingerprint: 'new',
      syncedAt: '2026-01-02T00:00:00Z',
    };
    const changes = changedDocumentFeedback(previous, next);
    expect(changes.map((change) => change.key)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('body:'),
        expect.stringContaining('comment:c1:'),
        expect.stringContaining('comment:c2:'),
      ])
    );
  });

  it('uses the document revision and client token when appending a result block', async () => {
    const create = vi.fn().mockResolvedValue({ code: 0, data: { document_revision_id: 3 } });
    const writer = createDocumentWriter({
      docx: { documentBlockChildren: { create } },
    } as never);

    await expect(writer('doc-token', 2, '[Research result]', 'client-token')).resolves.toEqual({
      revision: 3,
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        children: [
          {
            block_type: 2,
            text: { elements: [{ text_run: { content: '[Research result]' } }] },
          },
        ],
      },
      params: { document_revision_id: 2, client_token: 'client-token' },
      path: { document_id: 'doc-token', block_id: 'doc-token' },
    });
  });
});
