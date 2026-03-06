/**
 * Tests for create_group MCP tool.
 *
 * @module mcp/tools/create-group.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test_app_id',
    FEISHU_APP_SECRET: 'test_app_secret',
  },
}));

vi.mock('../../platforms/feishu/create-feishu-client.js', () => ({
  createFeishuClient: vi.fn(() => ({})),
}));

vi.mock('../../platforms/feishu/group-service.js', () => ({
  getGroupService: vi.fn(() => ({
    createGroup: vi.fn().mockResolvedValue({
      chatId: 'oc_test_chat_id',
      name: 'Test Group',
      createdAt: Date.now(),
      initialMembers: [],
    }),
  })),
}));

import { create_group } from './create-group.js';

describe('create_group', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a group with topic', async () => {
    const result = await create_group({
      topic: 'Test Group',
    });

    expect(result.success).toBe(true);
    expect(result.chatId).toBe('oc_test_chat_id');
    expect(result.name).toBe('Test Group');
    expect(result.message).toContain('Group created');
  });

  it('should create a group with topic and members', async () => {
    const result = await create_group({
      topic: 'Test Group',
      members: ['ou_user1', 'ou_user2'],
    });

    expect(result.success).toBe(true);
    expect(result.chatId).toBe('oc_test_chat_id');
  });

  it('should create a group without topic (auto-generated name)', async () => {
    const result = await create_group({});

    expect(result.success).toBe(true);
    expect(result.chatId).toBe('oc_test_chat_id');
  });
});
