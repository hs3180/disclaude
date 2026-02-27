/**
 * Tests for Message Router (src/messaging/)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MessageRouter,
  RoutedOutputAdapter,
  SimpleUserOutputAdapter,
  MessageLevel,
  DEFAULT_USER_LEVELS,
  mapAgentMessageTypeToLevel,
  createDefaultRouteConfig,
  type IMessageSender,
  type MessageRouteConfig,
} from './index.js';

describe('Message Level Types', () => {
  describe('MessageLevel enum', () => {
    it('should have all expected levels', () => {
      expect(MessageLevel.DEBUG).toBe('debug');
      expect(MessageLevel.PROGRESS).toBe('progress');
      expect(MessageLevel.INFO).toBe('info');
      expect(MessageLevel.NOTICE).toBe('notice');
      expect(MessageLevel.IMPORTANT).toBe('important');
      expect(MessageLevel.ERROR).toBe('error');
      expect(MessageLevel.RESULT).toBe('result');
    });
  });

  describe('DEFAULT_USER_LEVELS', () => {
    it('should include notice, important, error, result', () => {
      expect(DEFAULT_USER_LEVELS).toContain(MessageLevel.NOTICE);
      expect(DEFAULT_USER_LEVELS).toContain(MessageLevel.IMPORTANT);
      expect(DEFAULT_USER_LEVELS).toContain(MessageLevel.ERROR);
      expect(DEFAULT_USER_LEVELS).toContain(MessageLevel.RESULT);
    });

    it('should not include debug, progress, info', () => {
      expect(DEFAULT_USER_LEVELS).not.toContain(MessageLevel.DEBUG);
      expect(DEFAULT_USER_LEVELS).not.toContain(MessageLevel.PROGRESS);
      expect(DEFAULT_USER_LEVELS).not.toContain(MessageLevel.INFO);
    });
  });

  describe('mapAgentMessageTypeToLevel', () => {
    it('should map tool_progress to PROGRESS', () => {
      expect(mapAgentMessageTypeToLevel('tool_progress')).toBe(MessageLevel.PROGRESS);
    });

    it('should map tool_use to DEBUG', () => {
      expect(mapAgentMessageTypeToLevel('tool_use')).toBe(MessageLevel.DEBUG);
    });

    it('should map tool_result to DEBUG', () => {
      expect(mapAgentMessageTypeToLevel('tool_result')).toBe(MessageLevel.DEBUG);
    });

    it('should map error to ERROR', () => {
      expect(mapAgentMessageTypeToLevel('error')).toBe(MessageLevel.ERROR);
    });

    it('should map result to RESULT', () => {
      expect(mapAgentMessageTypeToLevel('result')).toBe(MessageLevel.RESULT);
    });

    it('should map completion message to DEBUG', () => {
      expect(mapAgentMessageTypeToLevel('result', '✅ Complete')).toBe(MessageLevel.DEBUG);
    });

    it('should map notification to NOTICE', () => {
      expect(mapAgentMessageTypeToLevel('notification')).toBe(MessageLevel.NOTICE);
    });

    it('should map task_completion to RESULT', () => {
      expect(mapAgentMessageTypeToLevel('task_completion')).toBe(MessageLevel.RESULT);
    });

    it('should map max_iterations_warning to IMPORTANT', () => {
      expect(mapAgentMessageTypeToLevel('max_iterations_warning')).toBe(MessageLevel.IMPORTANT);
    });

    it('should map status to INFO', () => {
      expect(mapAgentMessageTypeToLevel('status')).toBe(MessageLevel.INFO);
    });

    it('should map text to INFO', () => {
      expect(mapAgentMessageTypeToLevel('text')).toBe(MessageLevel.INFO);
    });
  });
});

describe('MessageRouter', () => {
  let mockSender: IMessageSender;
  let router: MessageRouter;

  beforeEach(() => {
    mockSender = {
      sendText: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('with admin chat configured', () => {
    beforeEach(() => {
      const config: MessageRouteConfig = {
        adminChatId: 'admin-chat-id',
        userChatId: 'user-chat-id',
        userMessageLevels: DEFAULT_USER_LEVELS,
      };
      router = new MessageRouter({ config, sender: mockSender });
    });

    it('should route DEBUG to admin only', async () => {
      await router.route({ content: 'Debug message', level: MessageLevel.DEBUG });
      expect(mockSender.sendText).toHaveBeenCalledTimes(1);
      expect(mockSender.sendText).toHaveBeenCalledWith('admin-chat-id', 'Debug message');
    });

    it('should route PROGRESS to admin only', async () => {
      await router.route({ content: 'Progress message', level: MessageLevel.PROGRESS });
      expect(mockSender.sendText).toHaveBeenCalledTimes(1);
      expect(mockSender.sendText).toHaveBeenCalledWith('admin-chat-id', 'Progress message');
    });

    it('should route ERROR to both admin and user', async () => {
      await router.route({ content: 'Error message', level: MessageLevel.ERROR });
      expect(mockSender.sendText).toHaveBeenCalledTimes(2);
      expect(mockSender.sendText).toHaveBeenCalledWith('admin-chat-id', 'Error message');
      expect(mockSender.sendText).toHaveBeenCalledWith('user-chat-id', 'Error message');
    });

    it('should route RESULT to both admin and user', async () => {
      await router.route({ content: 'Result message', level: MessageLevel.RESULT });
      expect(mockSender.sendText).toHaveBeenCalledTimes(2);
    });

    it('should route NOTICE to both admin and user', async () => {
      await router.route({ content: 'Notice message', level: MessageLevel.NOTICE });
      expect(mockSender.sendText).toHaveBeenCalledTimes(2);
    });

    it('should get correct targets for each level', () => {
      expect(router.getTargets(MessageLevel.DEBUG)).toEqual(['admin-chat-id']);
      expect(router.getTargets(MessageLevel.PROGRESS)).toEqual(['admin-chat-id']);
      expect(router.getTargets(MessageLevel.ERROR)).toEqual(['admin-chat-id', 'user-chat-id']);
      expect(router.getTargets(MessageLevel.RESULT)).toEqual(['admin-chat-id', 'user-chat-id']);
    });

    it('should check user visibility correctly', () => {
      expect(router.isUserVisible(MessageLevel.DEBUG)).toBe(false);
      expect(router.isUserVisible(MessageLevel.PROGRESS)).toBe(false);
      expect(router.isUserVisible(MessageLevel.ERROR)).toBe(true);
      expect(router.isUserVisible(MessageLevel.RESULT)).toBe(true);
    });

    it('should have admin chat configured', () => {
      expect(router.hasAdminChat()).toBe(true);
      expect(router.getAdminChatId()).toBe('admin-chat-id');
    });

    it('should return user chat ID', () => {
      expect(router.getUserChatId()).toBe('user-chat-id');
    });
  });

  describe('without admin chat', () => {
    beforeEach(() => {
      const config: MessageRouteConfig = {
        userChatId: 'user-chat-id',
        userMessageLevels: DEFAULT_USER_LEVELS,
      };
      router = new MessageRouter({ config, sender: mockSender });
    });

    it('should route all user-visible messages to user chat', async () => {
      await router.route({ content: 'Result', level: MessageLevel.RESULT });
      expect(mockSender.sendText).toHaveBeenCalledWith('user-chat-id', 'Result');
    });

    it('should not route debug messages when no admin', async () => {
      await router.route({ content: 'Debug', level: MessageLevel.DEBUG });
      expect(mockSender.sendText).not.toHaveBeenCalled();
    });

    it('should not have admin chat', () => {
      expect(router.hasAdminChat()).toBe(false);
      expect(router.getAdminChatId()).toBeUndefined();
    });
  });

  describe('with same admin and user chat', () => {
    beforeEach(() => {
      const config: MessageRouteConfig = {
        adminChatId: 'same-chat-id',
        userChatId: 'same-chat-id',
        userMessageLevels: DEFAULT_USER_LEVELS,
      };
      router = new MessageRouter({ config, sender: mockSender });
    });

    it('should send message only once', async () => {
      await router.route({ content: 'Error', level: MessageLevel.ERROR });
      expect(mockSender.sendText).toHaveBeenCalledTimes(1);
      expect(mockSender.sendText).toHaveBeenCalledWith('same-chat-id', 'Error');
    });
  });

  describe('with custom user levels', () => {
    beforeEach(() => {
      const config: MessageRouteConfig = {
        adminChatId: 'admin-chat-id',
        userChatId: 'user-chat-id',
        userMessageLevels: [MessageLevel.ERROR, MessageLevel.RESULT], // Only errors and results
      };
      router = new MessageRouter({ config, sender: mockSender });
    });

    it('should not route NOTICE to user', async () => {
      await router.route({ content: 'Notice', level: MessageLevel.NOTICE });
      expect(mockSender.sendText).toHaveBeenCalledTimes(1);
      expect(mockSender.sendText).toHaveBeenCalledWith('admin-chat-id', 'Notice');
    });

    it('should route ERROR to both', async () => {
      await router.route({ content: 'Error', level: MessageLevel.ERROR });
      expect(mockSender.sendText).toHaveBeenCalledTimes(2);
    });
  });

  describe('update methods', () => {
    beforeEach(() => {
      const config = createDefaultRouteConfig('user-chat-id');
      router = new MessageRouter({ config, sender: mockSender });
    });

    it('should update user levels', () => {
      router.setUserLevels([MessageLevel.ERROR]);
      expect(router.isUserVisible(MessageLevel.ERROR)).toBe(true);
      expect(router.isUserVisible(MessageLevel.RESULT)).toBe(false);
    });

    it('should update admin chat ID', () => {
      expect(router.hasAdminChat()).toBe(false);
      router.setAdminChatId('new-admin-id');
      expect(router.hasAdminChat()).toBe(true);
      expect(router.getAdminChatId()).toBe('new-admin-id');
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      const config: MessageRouteConfig = {
        adminChatId: 'admin-chat-id',
        userChatId: 'user-chat-id',
      };
      router = new MessageRouter({ config, sender: mockSender });
    });

    it('should continue sending to other targets on error', async () => {
      mockSender.sendText = vi.fn()
        .mockRejectedValueOnce(new Error('Failed to admin'))
        .mockResolvedValueOnce(undefined);

      await router.route({ content: 'Error', level: MessageLevel.ERROR });

      // Should attempt to send to both, even though first failed
      expect(mockSender.sendText).toHaveBeenCalledTimes(2);
    });
  });
});

describe('createDefaultRouteConfig', () => {
  it('should create config with user chat ID', () => {
    const config = createDefaultRouteConfig('my-chat-id');
    expect(config.userChatId).toBe('my-chat-id');
  });

  it('should include default user levels', () => {
    const config = createDefaultRouteConfig('my-chat-id');
    expect(config.userMessageLevels).toEqual(DEFAULT_USER_LEVELS);
  });

  it('should include default task lifecycle settings', () => {
    const config = createDefaultRouteConfig('my-chat-id');
    expect(config.showTaskLifecycle?.showStart).toBe(false);
    expect(config.showTaskLifecycle?.showProgress).toBe(false);
    expect(config.showTaskLifecycle?.showComplete).toBe(true);
  });

  it('should include default error settings', () => {
    const config = createDefaultRouteConfig('my-chat-id');
    expect(config.errors?.showStack).toBe(false);
    expect(config.errors?.showDetails).toBe('admin');
  });
});

describe('RoutedOutputAdapter', () => {
  let mockRouter: { route: ReturnType<typeof vi.fn>; getTargets: ReturnType<typeof vi.fn>; getUserChatId: ReturnType<typeof vi.fn> };
  let adapter: RoutedOutputAdapter;

  beforeEach(() => {
    mockRouter = {
      route: vi.fn().mockResolvedValue(undefined),
      getTargets: vi.fn().mockReturnValue(['user-chat-id']),
      getUserChatId: vi.fn().mockReturnValue('user-chat-id'),
    };
    adapter = new RoutedOutputAdapter({ router: mockRouter as any });
  });

  it('should route message with mapped level', async () => {
    await adapter.write('Task completed', 'result');
    expect(mockRouter.route).toHaveBeenCalledWith({
      content: 'Task completed',
      level: MessageLevel.RESULT,
      metadata: { originalType: 'result' },
    });
  });

  it('should skip empty content', async () => {
    await adapter.write('   ', 'text');
    expect(mockRouter.route).not.toHaveBeenCalled();
  });

  it('should track user message sent', async () => {
    mockRouter.getTargets.mockReturnValue(['user-chat-id']);

    expect(adapter.hasSentUserMessage()).toBe(false);
    await adapter.write('Hello', 'result');
    expect(adapter.hasSentUserMessage()).toBe(true);
  });

  it('should not track if user not in targets', async () => {
    mockRouter.getTargets.mockReturnValue(['admin-chat-id']);
    mockRouter.getUserChatId.mockReturnValue('user-chat-id');

    await adapter.write('Debug', 'tool_progress');

    expect(adapter.hasSentUserMessage()).toBe(false);
  });

  it('should reset tracking', async () => {
    mockRouter.getTargets.mockReturnValue(['user-chat-id']);

    await adapter.write('Hello', 'result');
    expect(adapter.hasSentUserMessage()).toBe(true);

    adapter.resetTracking();
    expect(adapter.hasSentUserMessage()).toBe(false);
  });

  it('should include tool name in metadata', async () => {
    await adapter.write('Running command', 'tool_progress', { toolName: 'Bash' });
    expect(mockRouter.route).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { toolName: 'Bash', originalType: 'tool_progress' },
      })
    );
  });
});

describe('SimpleUserOutputAdapter', () => {
  let mockSendText: ReturnType<typeof vi.fn>;
  let adapter: SimpleUserOutputAdapter;

  beforeEach(() => {
    mockSendText = vi.fn().mockResolvedValue(undefined);
    adapter = new SimpleUserOutputAdapter(mockSendText, 'chat-id');
  });

  it('should send text to chat', async () => {
    await adapter.write('Hello', 'text');
    expect(mockSendText).toHaveBeenCalledWith('chat-id', 'Hello');
  });

  it('should skip empty content', async () => {
    await adapter.write('', 'text');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('should ignore message type', async () => {
    await adapter.write('Error', 'error');
    expect(mockSendText).toHaveBeenCalledWith('chat-id', 'Error');
  });
});
