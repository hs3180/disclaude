/**
 * Tests for Discussion End Detector.
 *
 * @see Issue #1229 - 智能会话结束 - 判断讨论何时可以关闭
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectDiscussionEnd,
  removeTriggerPhrase,
  handleDiscussionEnd,
  processDiscussionEnd,
  type DiscussionEndResult,
} from './discussion-end-detector.js';

// Mock dependencies
vi.mock('../../platforms/feishu/chat-ops.js', () => ({
  dissolveChat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../platforms/feishu/group-service.js', () => ({
  getGroupService: vi.fn(() => ({
    getGroup: vi.fn((chatId: string) => {
      if (chatId === 'managed-group') {
        return {
          chatId: 'managed-group',
          name: 'Test Group',
          createdAt: Date.now(),
          initialMembers: [],
        };
      }
      return undefined;
    }),
    unregisterGroup: vi.fn().mockReturnValue(true),
  })),
}));

describe('detectDiscussionEnd', () => {
  it('should detect standard [DISCUSSION_END] trigger', () => {
    const content = '讨论结束 [DISCUSSION_END]';
    const result = detectDiscussionEnd(content);

    expect(result.detected).toBe(true);
    expect(result.type).toBe('standard');
    expect(result.triggerPhrase).toBe('[DISCUSSION_END]');
  });

  it('should detect [DISCUSSION_END:summary=xxx] with summary', () => {
    const content = '讨论结束 [DISCUSSION_END:summary=我们决定使用方案A]';
    const result = detectDiscussionEnd(content);

    expect(result.detected).toBe(true);
    expect(result.type).toBe('standard');
    expect(result.summary).toBe('我们决定使用方案A');
    expect(result.triggerPhrase).toBe('[DISCUSSION_END:summary=我们决定使用方案A]');
  });

  it('should detect [DISCUSSION_END:timeout] trigger', () => {
    const content = '讨论超时 [DISCUSSION_END:timeout]';
    const result = detectDiscussionEnd(content);

    expect(result.detected).toBe(true);
    expect(result.type).toBe('timeout');
    expect(result.triggerPhrase).toBe('[DISCUSSION_END:timeout]');
  });

  it('should detect [DISCUSSION_END:abandoned] trigger', () => {
    const content = '讨论被放弃 [DISCUSSION_END:abandoned]';
    const result = detectDiscussionEnd(content);

    expect(result.detected).toBe(true);
    expect(result.type).toBe('abandoned');
    expect(result.triggerPhrase).toBe('[DISCUSSION_END:abandoned]');
  });

  it('should return not detected for content without trigger', () => {
    const content = '这是一条普通消息';
    const result = detectDiscussionEnd(content);

    expect(result.detected).toBe(false);
    expect(result.type).toBe('standard');
  });

  it('should return not detected for empty content', () => {
    const result1 = detectDiscussionEnd('');
    const result2 = detectDiscussionEnd(null as unknown as string);
    const result3 = detectDiscussionEnd(undefined as unknown as string);

    expect(result1.detected).toBe(false);
    expect(result2.detected).toBe(false);
    expect(result3.detected).toBe(false);
  });

  it('should detect trigger at the beginning of message', () => {
    const content = '[DISCUSSION_END] 这是总结';
    const result = detectDiscussionEnd(content);

    expect(result.detected).toBe(true);
    expect(result.type).toBe('standard');
  });

  it('should detect trigger in the middle of message', () => {
    const content = '感谢大家的参与！[DISCUSSION_END] 再见';
    const result = detectDiscussionEnd(content);

    expect(result.detected).toBe(true);
    expect(result.type).toBe('standard');
  });
});

describe('removeTriggerPhrase', () => {
  it('should remove standard trigger phrase', () => {
    const content = '讨论结束 [DISCUSSION_END]';
    const result: DiscussionEndResult = {
      detected: true,
      type: 'standard',
      triggerPhrase: '[DISCUSSION_END]',
    };
    const cleaned = removeTriggerPhrase(content, result);

    expect(cleaned).toBe('讨论结束');
  });

  it('should remove trigger with summary', () => {
    const content = '讨论结束 [DISCUSSION_END:summary=使用方案A]';
    const result: DiscussionEndResult = {
      detected: true,
      type: 'standard',
      summary: '使用方案A',
      triggerPhrase: '[DISCUSSION_END:summary=使用方案A]',
    };
    const cleaned = removeTriggerPhrase(content, result);

    expect(cleaned).toBe('讨论结束');
  });

  it('should remove timeout trigger', () => {
    const content = '讨论超时 [DISCUSSION_END:timeout]';
    const result: DiscussionEndResult = {
      detected: true,
      type: 'timeout',
      triggerPhrase: '[DISCUSSION_END:timeout]',
    };
    const cleaned = removeTriggerPhrase(content, result);

    expect(cleaned).toBe('讨论超时');
  });

  it('should return original content if no trigger detected', () => {
    const content = '这是一条普通消息';
    const result: DiscussionEndResult = {
      detected: false,
      type: 'standard',
    };
    const cleaned = removeTriggerPhrase(content, result);

    expect(cleaned).toBe(content);
  });

  it('should handle multiple triggers in content', () => {
    const content = '讨论结束 [DISCUSSION_END] [DISCUSSION_END:timeout]';
    const result: DiscussionEndResult = {
      detected: true,
      type: 'standard',
      triggerPhrase: '[DISCUSSION_END]',
    };
    const cleaned = removeTriggerPhrase(content, result);

    // Should remove both triggers
    expect(cleaned).toBe('讨论结束');
  });
});

describe('handleDiscussionEnd', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should dissolve group after delay', async () => {
    const { dissolveChat } = await import('../../platforms/feishu/chat-ops.js');
    const mockDissolveChat = vi.mocked(dissolveChat);

    const result: DiscussionEndResult = {
      detected: true,
      type: 'standard',
      summary: '测试总结',
    };

    const promise = handleDiscussionEnd('test-chat-id', result, {
      client: {} as unknown as ReturnType<typeof import('@larksuiteoapi/node-sdk').newClient>,
      dissolutionDelay: 1000,
    });

    // Fast-forward time
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(mockDissolveChat).toHaveBeenCalledWith(expect.anything(), 'test-chat-id');
  });

  it('should unregister managed group', async () => {
    const { dissolveChat } = await import('../../platforms/feishu/chat-ops.js');
    const mockDissolveChat = vi.mocked(dissolveChat);

    const result: DiscussionEndResult = {
      detected: true,
      type: 'standard',
    };

    const promise = handleDiscussionEnd('managed-group', result, {
      client: {} as unknown as ReturnType<typeof import('@larksuiteoapi/node-sdk').newClient>,
      dissolutionDelay: 0,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(mockDissolveChat).toHaveBeenCalled();
    // The mock getGroupService returns a managed group for 'managed-group'
    // and unregisterGroup is called on it
  });
});

describe('processDiscussionEnd', () => {
  it('should return detection result', async () => {
    const content = '讨论结束 [DISCUSSION_END]';
    const client = {} as unknown as ReturnType<typeof import('@larksuiteoapi/node-sdk').newClient>;

    const result = await processDiscussionEnd('test-chat-id', content, client);

    expect(result.detected).toBe(true);
    expect(result.type).toBe('standard');
  });

  it('should return not detected for normal content', async () => {
    const content = '这是一条普通消息';
    const client = {} as unknown as ReturnType<typeof import('@larksuiteoapi/node-sdk').newClient>;

    const result = await processDiscussionEnd('test-chat-id', content, client);

    expect(result.detected).toBe(false);
  });
});
