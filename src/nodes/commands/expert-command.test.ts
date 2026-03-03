/**
 * Tests for Expert Command.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExpertCommand } from './expert-command.js';
import type { CommandContext, CommandResult } from './types.js';

// Mock ExpertRegistry
const mockRegistry = {
  register: vi.fn(),
  addSkill: vi.fn(),
  removeSkill: vi.fn(),
  setAvailability: vi.fn(),
  getProfile: vi.fn(),
  getAll: vi.fn(),
};

vi.mock('../../human-loop/index.js', () => ({
  getExpertRegistry: () => mockRegistry,
}));

describe('ExpertCommand', () => {
  let command: ExpertCommand;

  beforeEach(() => {
    vi.clearAllMocks();
    command = new ExpertCommand();
  });

  describe('metadata', () => {
    it('should have correct name and category', () => {
      expect(command.name).toBe('expert');
      expect(command.category).toBe('expert');
      expect(command.description).toContain('专家');
    });
  });

  describe('execute', () => {
    const createMockContext = (args: string[], userId = 'ou_test_user'): CommandContext => ({
      chatId: 'oc_test_chat',
      userId,
      args,
      rawText: args.join(' '),
    });

    it('should show help when no subcommand provided', async () => {
      const context = createMockContext([]);
      const result = await command.execute(context);

      expect(result.success).toBe(true);
      expect(result.message).toContain('专家管理指令');
      expect(result.message).toContain('register');
      expect(result.message).toContain('skills');
    });

    it('should return error for unknown subcommand', async () => {
      const context = createMockContext(['unknown']);
      const result = await command.execute(context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('未知的子命令');
    });

    describe('register', () => {
      it('should register a new expert', async () => {
        mockRegistry.register.mockResolvedValue({ success: true, isNew: true });

        const context = createMockContext(['register', 'Test', 'User']);
        const result = await command.execute(context);

        expect(result.success).toBe(true);
        expect(result.message).toContain('注册成功');
        expect(mockRegistry.register).toHaveBeenCalledWith('ou_test_user', 'Test User');
      });

      it('should handle already registered expert', async () => {
        mockRegistry.register.mockResolvedValue({ success: true, isNew: false });

        const context = createMockContext(['register', 'Test', 'User']);
        const result = await command.execute(context);

        expect(result.success).toBe(true);
        expect(result.message).toContain('已注册');
      });

      it('should use default name if not provided', async () => {
        mockRegistry.register.mockResolvedValue({ success: true, isNew: true });

        const context = createMockContext(['register']);
        const result = await command.execute(context);

        expect(result.success).toBe(true);
        expect(mockRegistry.register).toHaveBeenCalledWith('ou_test_user', expect.stringContaining('专家_'));
      });
    });

    describe('profile', () => {
      it('should show expert profile', async () => {
        mockRegistry.getProfile.mockResolvedValue({
          open_id: 'ou_test_user',
          name: 'Test User',
          skills: [{ name: 'React', level: 4 }],
        });

        const context = createMockContext(['profile']);
        const result = await command.execute(context);

        expect(result.success).toBe(true);
        expect(result.message).toContain('专家档案');
        expect(result.message).toContain('Test User');
      });

      it('should show error if not registered', async () => {
        mockRegistry.getProfile.mockResolvedValue(undefined);

        const context = createMockContext(['profile']);
        const result = await command.execute(context);

        expect(result.success).toBe(false);
        expect(result.error).toContain('还未注册');
      });
    });

    describe('skills add', () => {
      it('should add a new skill', async () => {
        mockRegistry.addSkill.mockResolvedValue({ success: true, isUpdate: false });

        const context = createMockContext(['skills', 'add', 'React', '4', 'frontend']);
        const result = await command.execute(context);

        expect(result.success).toBe(true);
        expect(result.message).toContain('添加成功');
        expect(mockRegistry.addSkill).toHaveBeenCalledWith('ou_test_user', {
          name: 'React',
          level: 4,
          tags: ['frontend'],
        });
      });

      it('should update existing skill', async () => {
        mockRegistry.addSkill.mockResolvedValue({ success: true, isUpdate: true });

        const context = createMockContext(['skills', 'add', 'React', '5']);
        const result = await command.execute(context);

        expect(result.success).toBe(true);
        expect(result.message).toContain('更新');
      });

      it('should fail with invalid level', async () => {
        const context = createMockContext(['skills', 'add', 'React', '6']);
        const result = await command.execute(context);

        expect(result.success).toBe(false);
        expect(result.error).toContain('1-5');
      });

      it('should fail with missing arguments', async () => {
        const context = createMockContext(['skills', 'add', 'React']);
        const result = await command.execute(context);

        expect(result.success).toBe(false);
        expect(result.error).toContain('用法');
      });
    });

    describe('skills remove', () => {
      it('should remove a skill', async () => {
        mockRegistry.removeSkill.mockResolvedValue({ success: true });

        const context = createMockContext(['skills', 'remove', 'React']);
        const result = await command.execute(context);

        expect(result.success).toBe(true);
        expect(result.message).toContain('已移除');
        expect(mockRegistry.removeSkill).toHaveBeenCalledWith('ou_test_user', 'React');
      });

      it('should fail if skill not found', async () => {
        mockRegistry.removeSkill.mockResolvedValue({ success: false, error: '未找到' });

        const context = createMockContext(['skills', 'remove', 'NonExistent']);
        const result = await command.execute(context);

        expect(result.success).toBe(false);
        expect(result.error).toContain('未找到');
      });
    });

    describe('availability', () => {
      it('should set availability', async () => {
        mockRegistry.setAvailability.mockResolvedValue({ success: true });

        const context = createMockContext(['availability', 'weekdays', '10:00-18:00']);
        const result = await command.execute(context);

        expect(result.success).toBe(true);
        expect(result.message).toContain('可用时间已设置');
      });

      it('should fail with missing arguments', async () => {
        const context = createMockContext(['availability']);
        const result = await command.execute(context);

        expect(result.success).toBe(false);
        expect(result.error).toContain('用法');
      });
    });

    describe('list', () => {
      it('should list all experts', async () => {
        mockRegistry.getAll.mockResolvedValue([
          { open_id: 'ou_expert_1', name: 'Expert One', skills: [{ name: 'React', level: 4 }] },
          { open_id: 'ou_expert_2', name: 'Expert Two', skills: [] },
        ]);

        const context = createMockContext(['list']);
        const result = await command.execute(context);

        expect(result.success).toBe(true);
        expect(result.message).toContain('专家列表');
        expect(result.message).toContain('Expert One');
        expect(result.message).toContain('Expert Two');
      });

      it('should show empty message when no experts', async () => {
        mockRegistry.getAll.mockResolvedValue([]);

        const context = createMockContext(['list']);
        const result = await command.execute(context);

        expect(result.success).toBe(true);
        expect(result.message).toContain('暂无注册专家');
      });
    });

    describe('userId validation', () => {
      it('should fail if userId is missing', async () => {
        const context: CommandContext = {
          chatId: 'oc_test_chat',
          userId: undefined,
          args: ['register'],
          rawText: 'register',
        };

        const result = await command.execute(context);

        expect(result.success).toBe(false);
        expect(result.error).toContain('用户 ID');
      });

      it('should allow list without userId', async () => {
        mockRegistry.getAll.mockResolvedValue([]);

        const context: CommandContext = {
          chatId: 'oc_test_chat',
          userId: undefined,
          args: ['list'],
          rawText: 'list',
        };

        const result = await command.execute(context);

        expect(result.success).toBe(true);
      });
    });
  });
});
