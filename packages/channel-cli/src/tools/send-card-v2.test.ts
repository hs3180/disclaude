import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transformCardTables } from '../utils/table-converter.js';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  sendCard: send,
}));
vi.mock('./channel-api-utils.js', () => ({
  getChannelApiClient: () => 'client',
  isChannelApiAvailable: () => Promise.resolve(true),
  getChannelApiErrorMessage: (_type: unknown, error: string) => error,
  buildChannelApiFallbackHint: () => '',
}));
vi.mock('./callback-manager.js', () => ({ invokeMessageSentCallback: vi.fn() }));
import { send_card } from './send-card.js';

describe('static v2 card transport with real validation', () => {
  beforeEach(() => send.mockReset().mockResolvedValue({ success: true }));

  it('preserves schema, body, header and component-specific fields', async () => {
    const card = {
      schema: '2.0', config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: 'Daily digest' } },
      body: { elements: [{ tag: 'column_set', columns: [{ tag: 'column', width: 'weighted', weight: 1,
        elements: [{ tag: 'markdown', content: '**Finding**' }] }] }] },
    };
    const snapshot = structuredClone(card);
    const result = await send_card({ card: transformCardTables(card), chatId: 'oc_test', parentMessageId: 'om_parent' });
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith('client', 'oc_test', snapshot, 'om_parent', undefined);
    expect(card).toEqual(snapshot);
  });

  it('rejects an invalid v2 body before invoking transport', async () => {
    const result = await send_card({ card: { schema: '2.0', body: { elements: 'bad' } }, chatId: 'oc_test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('body.elements');
    expect(send).not.toHaveBeenCalled();
  });
});
