/**
 * Tests for FeishuAdapter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(),
}));

import { FeishuAdapter } from './feishu-adapter.js';
import type { FeishuClientProvider } from './feishu-adapter.js';

function createMockClient() {
  return {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({ data: { message_id: 'feishu_msg_1' } }),
        reply: vi.fn().mockResolvedValue({ data: { message_id: 'feishu_reply_1' } }),
        patch: vi.fn().mockResolvedValue({}),
        get: vi.fn(),
      },
    },
  };
}

describe('FeishuAdapter', () => {
  let adapter: FeishuAdapter;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    adapter = new FeishuAdapter();
    adapter.setClient(mockClient as any);
  });

  describe('canHandle', () => {
    it('should handle oc_ (group) chat IDs', () => {
      expect(adapter.canHandle('oc_abc123')).toBe(true);
    });

    it('should handle ou_ (user) chat IDs', () => {
      expect(adapter.canHandle('ou_abc123')).toBe(true);
    });

    it('should handle on_ (bot) chat IDs', () => {
      expect(adapter.canHandle('on_abc123')).toBe(true);
    });

    it('should not handle other prefixes', () => {
      expect(adapter.canHandle('cli-123')).toBe(false);
      expect(adapter.canHandle('rest-123')).toBe(false);
      expect(adapter.canHandle('12345678-1234-1234-1234-123456789012')).toBe(false);
      expect(adapter.canHandle('')).toBe(false);
    });
  });

  describe('convert', () => {
    it('should convert text message', () => {
      const message = {
        chatId: 'oc_1',
        content: { type: 'text', text: 'Hello' },
      } as any;

      const result = adapter.convert(message);
      expect(result).toEqual({
        msg_type: 'text',
        content: JSON.stringify({ text: 'Hello' }),
      });
    });

    it('should convert markdown message to card', () => {
      const message = {
        chatId: 'oc_1',
        content: { type: 'markdown', text: '**bold**' },
      } as any;

      const result = adapter.convert(message);
      expect(result).toEqual({
        msg_type: 'interactive',
        content: expect.any(String),
      });

      const parsed = JSON.parse((result as any).content);
      expect(parsed.config.wide_screen_mode).toBe(true);
      expect(parsed.elements[0].tag).toBe('markdown');
    });

    it('should convert card message', () => {
      const message = {
        chatId: 'oc_1',
        content: {
          type: 'card',
          title: 'Test',
          sections: [{ type: 'text', content: 'Body' }],
        },
      } as any;

      const result = adapter.convert(message);
      expect((result as any).msg_type).toBe('interactive');

      const parsed = JSON.parse((result as any).content);
      expect(parsed.header.title.content).toBe('Test');
    });

    it('should convert file message', () => {
      const message = {
        chatId: 'oc_1',
        content: { type: 'file', path: '/tmp/test.pdf' },
      } as any;

      const result = adapter.convert(message);
      expect(result).toEqual({
        msg_type: 'file',
        content: JSON.stringify({ file_path: '/tmp/test.pdf' }),
      });
    });

    it('should convert done message with success', () => {
      const message = {
        chatId: 'oc_1',
        content: { type: 'done', success: true, message: 'Done!' },
      } as any;

      const result = adapter.convert(message);
      expect((result as any).msg_type).toBe('text');
      const parsed = JSON.parse((result as any).content);
      expect(parsed.text).toContain('Done!');
    });

    it('should convert done message with failure', () => {
      const message = {
        chatId: 'oc_1',
        content: { type: 'done', success: false, error: 'Failed!' },
      } as any;

      const result = adapter.convert(message);
      const parsed = JSON.parse((result as any).content);
      expect(parsed.text).toContain('Failed!');
    });

    it('should throw for unsupported content type', () => {
      const message = {
        chatId: 'oc_1',
        content: { type: 'unknown_type' },
      } as any;

      expect(() => adapter.convert(message)).toThrow('Unsupported content type');
    });
  });

  describe('convertCard', () => {
    it('should convert card with subtitle', () => {
      const message = {
        chatId: 'oc_1',
        content: {
          type: 'card',
          title: 'Title',
          subtitle: 'Subtitle',
          sections: [],
        },
      } as any;

      const result = adapter.convert(message);
      const parsed = JSON.parse((result as any).content);
      expect(parsed.header.subtitle.content).toBe('Subtitle');
    });

    it('should convert card with theme', () => {
      const message = {
        chatId: 'oc_1',
        content: {
          type: 'card',
          title: 'Title',
          theme: 'red',
          sections: [],
        },
      } as any;

      const result = adapter.convert(message);
      const parsed = JSON.parse((result as any).content);
      expect(parsed.header.template).toBe('red');
    });

    it('should default to blue theme', () => {
      const message = {
        chatId: 'oc_1',
        content: {
          type: 'card',
          title: 'Title',
          sections: [],
        },
      } as any;

      const result = adapter.convert(message);
      const parsed = JSON.parse((result as any).content);
      expect(parsed.header.template).toBe('blue');
    });

    it('should convert fields sections', () => {
      const message = {
        chatId: 'oc_1',
        content: {
          type: 'card',
          title: 'Title',
          sections: [{
            type: 'fields',
            fields: [{ label: 'Key', value: 'Val' }],
          }],
        },
      } as any;

      const result = adapter.convert(message);
      const parsed = JSON.parse((result as any).content);
      expect(parsed.elements[0].tag).toBe('div');
      expect(parsed.elements[0].fields[0].text.content).toContain('Key');
      expect(parsed.elements[0].fields[0].text.content).toContain('Val');
    });

    it('should convert image sections', () => {
      const message = {
        chatId: 'oc_1',
        content: {
          type: 'card',
          title: 'Title',
          sections: [{ type: 'image', imageUrl: 'img_key_123' }],
        },
      } as any;

      const result = adapter.convert(message);
      const parsed = JSON.parse((result as any).content);
      expect(parsed.elements[0].tag).toBe('img');
      expect(parsed.elements[0].img_key).toBe('img_key_123');
    });

    it('should convert actions with button type', () => {
      const message = {
        chatId: 'oc_1',
        content: {
          type: 'card',
          title: 'Title',
          sections: [],
          actions: [{ type: 'button', label: 'Click', value: 'click_val', style: 'primary' }],
        },
      } as any;

      const result = adapter.convert(message);
      const parsed = JSON.parse((result as any).content);
      expect(parsed.card_link.tag).toBe('button');
      expect(parsed.card_link.text.content).toBe('Click');
    });

    it('should convert actions with danger style', () => {
      const message = {
        chatId: 'oc_1',
        content: {
          type: 'card',
          title: 'Title',
          sections: [],
          actions: [{ type: 'button', label: 'Delete', value: 'del', style: 'danger' }],
        },
      } as any;

      const result = adapter.convert(message);
      const parsed = JSON.parse((result as any).content);
      expect(parsed.card_link.type).toBe('danger');
    });

    it('should convert select action', () => {
      const message = {
        chatId: 'oc_1',
        content: {
          type: 'card',
          title: 'Title',
          sections: [],
          actions: [{
            type: 'select',
            label: 'Choose',
            options: [
              { label: 'A', value: 'a' },
              { label: 'B', value: 'b' },
            ],
          }],
        },
      } as any;

      const result = adapter.convert(message);
      const parsed = JSON.parse((result as any).content);
      expect(parsed.card_link.tag).toBe('select_static');
    });

    it('should convert link action', () => {
      const message = {
        chatId: 'oc_1',
        content: {
          type: 'card',
          title: 'Title',
          sections: [],
          actions: [{ type: 'link', label: 'Open', value: 'link_val', url: 'https://example.com' }],
        },
      } as any;

      const result = adapter.convert(message);
      const parsed = JSON.parse((result as any).content);
      expect(parsed.card_link.tag).toBe('action');
    });
  });

  describe('send', () => {
    it('should send message via create API', async () => {
      const message = {
        chatId: 'oc_1',
        content: { type: 'text', text: 'Hello' },
      } as any;

      const result = await adapter.send(message);
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('feishu_msg_1');
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_1',
          msg_type: 'text',
          content: expect.any(String),
        },
      });
    });

    it('should send via reply API when threadId is provided', async () => {
      const message = {
        chatId: 'oc_1',
        threadId: 'parent_msg_id',
        content: { type: 'text', text: 'Reply' },
      } as any;

      const result = await adapter.send(message);
      expect(result.success).toBe(true);
      expect(mockClient.im.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'parent_msg_id' },
        data: { msg_type: 'text', content: expect.any(String) },
      });
    });

    it('should handle send errors', async () => {
      mockClient.im.message.create.mockRejectedValue(new Error('API Error'));
      const message = {
        chatId: 'oc_1',
        content: { type: 'text', text: 'Hello' },
      } as any;

      const result = await adapter.send(message);
      expect(result.success).toBe(false);
      expect(result.error).toBe('API Error');
    });

    it('should throw when no client set', async () => {
      const noClientAdapter = new FeishuAdapter();
      const message = {
        chatId: 'oc_1',
        content: { type: 'text', text: 'Hello' },
      } as any;

      const result = await noClientAdapter.send(message);
      expect(result.success).toBe(false);
      expect(result.error).toContain('client provider');
    });
  });

  describe('update', () => {
    it('should update card message', async () => {
      const message = {
        chatId: 'oc_1',
        content: { type: 'card', title: 'Updated', sections: [] },
      } as any;

      const result = await adapter.update('msg_id', message);
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg_id');
      expect(mockClient.im.message.patch).toHaveBeenCalled();
    });

    it('should reject updating non-card messages', async () => {
      const message = {
        chatId: 'oc_1',
        content: { type: 'text', text: 'Hello' },
      } as any;

      const result = await adapter.update('msg_id', message);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Only card messages');
    });

    it('should handle update errors', async () => {
      mockClient.im.message.patch.mockRejectedValue(new Error('Update failed'));
      const message = {
        chatId: 'oc_1',
        content: { type: 'card', title: 'T', sections: [] },
      } as any;

      const result = await adapter.update('msg_id', message);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Update failed');
    });
  });

  describe('setClientProvider', () => {
    it('should use client provider for getClient', async () => {
      const provider: FeishuClientProvider = {
        getClient: () => mockClient as any,
      };
      adapter = new FeishuAdapter({ clientProvider: provider });

      const message = {
        chatId: 'oc_1',
        content: { type: 'text', text: 'Hello' },
      } as any;

      await adapter.send(message);
      expect(mockClient.im.message.create).toHaveBeenCalled();
    });

    it('should reset cached client when setting new provider', () => {
      const provider1: FeishuClientProvider = {
        getClient: () => createMockClient() as any,
      };
      const provider2: FeishuClientProvider = {
        getClient: () => mockClient as any,
      };
      adapter = new FeishuAdapter({ clientProvider: provider1 });
      adapter.setClientProvider(provider2);

      // Should use provider2's client
      adapter.send({
        chatId: 'oc_1',
        content: { type: 'text', text: 'Hello' },
      } as any);

      expect(mockClient.im.message.create).toHaveBeenCalled();
    });
  });

  describe('capabilities', () => {
    it('should have correct capabilities', () => {
      expect(adapter.capabilities.supportsCard).toBe(true);
      expect(adapter.capabilities.supportsThread).toBe(true);
      expect(adapter.capabilities.supportsFile).toBe(true);
      expect(adapter.capabilities.supportsMarkdown).toBe(true);
      expect(adapter.capabilities.supportsUpdate).toBe(true);
      expect(adapter.capabilities.supportsDelete).toBe(true);
      expect(adapter.capabilities.maxMessageLength).toBe(30000);
    });
  });

  describe('name', () => {
    it('should be feishu', () => {
      expect(adapter.name).toBe('feishu');
    });
  });
});
