import { describe, expect, it } from 'vitest';
import { renderToolResult } from './tool-result.js';

describe('canonical host tool media', () => {
  it('keeps ordinary JSON unchanged and excludes encoded images from text', () => {
    expect(renderToolResult({ content: 'ordinary business data' })).toEqual({
      text: '{"content":"ordinary business data"}',
      images: [],
    });
    const images = [{ mimeType: 'image/png', data: Buffer.from('png bytes').toString('base64') }];
    expect(
      renderToolResult({
        format: 'disclaude.tool-result.v1',
        data: { cellId: 'plot', sourceHash: 'original' },
        images,
      })
    ).toEqual({ text: '{"cellId":"plot","sourceHash":"original"}', images });
  });

  it.each([
    { data: {}, images: [{ mimeType: 'image/svg+xml', data: 'AAAA' }] },
    { data: {}, images: [{ mimeType: 'image/png', data: 'not base64' }] },
    { data: {}, images: [{ mimeType: 'image/png', data: 'AAAA'.repeat(500001) }] },
    {
      data: {},
      images: Array.from({ length: 5 }, () => ({ mimeType: 'image/png', data: 'AAAA' })),
    },
    { data: null, images: [] },
  ])('rejects malformed or excessive image results', (invalid) => {
    expect(() => renderToolResult({ format: 'disclaude.tool-result.v1', ...invalid })).toThrow();
  });
});
