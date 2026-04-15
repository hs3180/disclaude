/**
 * Tests for MentionDetector.
 *
 * Tests bot mention detection in group chat messages.
 * Issue #1617: Improves unit test coverage for mention-detector.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @disclaude/core logger
vi.mock('@disclaude/core', async () => {
  const actual = await vi.importActual<typeof import('@disclaude/core')>('@disclaude/core');
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

import { MentionDetector } from './mention-detector.js';
import type { FeishuMessageEvent } from '@disclaude/core';

function createMockClient(response: Record<string, unknown>) {
  return {
    request: vi.fn().mockResolvedValue(response),
  } as unknown as import('@larksuiteoapi/node-sdk').Client;
}

type Mention = NonNullable<FeishuMessageEvent['message']['mentions']>[number];

function mention(openId: string, key = ''): Mention {
  return {
    id: { open_id: openId, union_id: '', user_id: '' },
    key,
    name: '',
    tenant_key: '',
  };
}

describe('MentionDetector', () => {
  let detector: MentionDetector;

  beforeEach(() => {
    detector = new MentionDetector();
  });

  describe('setClient', () => {
    it('should set the client', () => {
      const client = createMockClient({});
      detector.setClient(client);
      // No error thrown
    });
  });

  describe('fetchBotInfo', () => {
    it('should fetch and store bot info from API', async () => {
      const client = createMockClient({
        bot: { open_id: 'ou_bot123', app_id: 'cli_app456' },
      });
      detector.setClient(client);

      await detector.fetchBotInfo();

      const botInfo = detector.getBotInfo();
      expect(botInfo).toEqual({
        open_id: 'ou_bot123',
        app_id: 'cli_app456',
      });
    });

    it('should warn and not set botInfo when client is not initialized', async () => {
      // No client set
      await detector.fetchBotInfo();

      expect(detector.getBotInfo()).toBeUndefined();
    });

    it('should warn when response has no bot.open_id', async () => {
      const client = createMockClient({
        bot: {},
        code: 0,
        msg: 'success',
      });
      detector.setClient(client);

      await detector.fetchBotInfo();

      expect(detector.getBotInfo()).toBeUndefined();
    });

    it('should warn when response has no bot field', async () => {
      const client = createMockClient({
        code: 1,
        msg: 'error',
      });
      detector.setClient(client);

      await detector.fetchBotInfo();

      expect(detector.getBotInfo()).toBeUndefined();
    });

    it('should handle API request error gracefully', async () => {
      const client = {
        request: vi.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as import('@larksuiteoapi/node-sdk').Client;
      detector.setClient(client);

      // Should not throw
      await detector.fetchBotInfo();

      expect(detector.getBotInfo()).toBeUndefined();
    });

    it('should handle non-Error thrown values', async () => {
      const client = {
        request: vi.fn().mockRejectedValue('string error'),
      } as unknown as import('@larksuiteoapi/node-sdk').Client;
      detector.setClient(client);

      // Should not throw
      await detector.fetchBotInfo();

      expect(detector.getBotInfo()).toBeUndefined();
    });

    it('should store bot info with only open_id when app_id is missing', async () => {
      const client = createMockClient({
        bot: { open_id: 'ou_bot789' },
      });
      detector.setClient(client);

      await detector.fetchBotInfo();

      const botInfo = detector.getBotInfo();
      expect(botInfo).toEqual({
        open_id: 'ou_bot789',
        app_id: undefined,
      });
    });
  });

  describe('isBotMentioned', () => {
    it('should return false when no mentions provided', () => {
      expect(detector.isBotMentioned(undefined)).toBe(false);
    });

    it('should return false when mentions array is empty', () => {
      expect(detector.isBotMentioned([])).toBe(false);
    });

    it('should match bot by open_id when botInfo is available', async () => {
      const client = createMockClient({
        bot: { open_id: 'ou_bot123', app_id: 'cli_app456' },
      });
      detector.setClient(client);
      await detector.fetchBotInfo();

      const mentions = [
        mention('ou_other_user', '@other'),
        mention('ou_bot123', '@bot'),
      ];

      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should match bot by app_id when botInfo is available', async () => {
      const client = createMockClient({
        bot: { open_id: 'ou_bot123', app_id: 'cli_app456' },
      });
      detector.setClient(client);
      await detector.fetchBotInfo();

      const mentions = [
        mention('cli_app456', '@bot'),
      ];

      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should return false when no mention matches botInfo', async () => {
      const client = createMockClient({
        bot: { open_id: 'ou_bot123', app_id: 'cli_app456' },
      });
      detector.setClient(client);
      await detector.fetchBotInfo();

      const mentions = [
        mention('ou_other_user', '@other'),
      ];

      expect(detector.isBotMentioned(mentions)).toBe(false);
    });

    it('should use fallback pattern: open_id starting with cli_', () => {
      // No botInfo set — fallback mode
      const mentions = [
        mention('cli_something', '@bot'),
      ];

      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should use fallback pattern: key containing bot', () => {
      // No botInfo set — fallback mode
      const mentions = [
        mention('ou_random', '@_bot'),
      ];

      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should return false in fallback mode when no pattern matches', () => {
      // No botInfo set — fallback mode
      const mentions = [
        mention('ou_random', '@user'),
      ];

      expect(detector.isBotMentioned(mentions)).toBe(false);
    });

    it('should handle mentions with missing id field', () => {
      // No botInfo — fallback mode
      const mentions = [
        { id: undefined, key: '@bot', name: '', tenant_key: '' } as unknown as Mention,
      ];

      // Key contains 'bot' → true
      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should handle mentions with empty open_id', async () => {
      const client = createMockClient({
        bot: { open_id: 'ou_bot123' },
      });
      detector.setClient(client);
      await detector.fetchBotInfo();

      const mentions = [
        mention('', '@someone'),
      ];

      expect(detector.isBotMentioned(mentions)).toBe(false);
    });
  });

  describe('getBotInfo', () => {
    it('should return undefined before fetchBotInfo is called', () => {
      expect(detector.getBotInfo()).toBeUndefined();
    });

    it('should return stored bot info after fetch', async () => {
      const client = createMockClient({
        bot: { open_id: 'ou_test', app_id: 'cli_test' },
      });
      detector.setClient(client);
      await detector.fetchBotInfo();

      expect(detector.getBotInfo()).toEqual({
        open_id: 'ou_test',
        app_id: 'cli_test',
      });
    });
  });
});
