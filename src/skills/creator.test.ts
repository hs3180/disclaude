/**
 * Tests for Skill Creator.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createSkillFromChat, listUserSkills, deleteUserSkill } from './creator.js';

// Mock the messageLogger
vi.mock('../feishu/message-logger.js', () => ({
  messageLogger: {
    getChatHistory: vi.fn(),
  },
}));

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(),
  },
}));

import { messageLogger } from '../feishu/message-logger.js';
import { Config } from '../config/index.js';

describe('SkillCreator', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create temp directory for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-creator-test-'));
    vi.mocked(Config.getWorkspaceDir).mockReturnValue(tempDir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('createSkillFromChat', () => {
    it('should create a skill from chat history', async () => {
      const mockHistory = `
# Chat Message Log: test-chat-id

---

## [2024-01-01T00:00:00.000Z] 📥 User

**Sender**: user123
**Type**: text

以后所有代码都用 TypeScript 写

---

## [2024-01-01T00:01:00.000Z] 📤 Bot

**Sender**: bot
**Type**: text

好的，我会记住这个偏好。

---
`;

      vi.mocked(messageLogger.getChatHistory).mockResolvedValue(mockHistory);

      const result = await createSkillFromChat({
        name: 'my-code-style',
        chatId: 'test-chat-id',
      });

      expect(result.success).toBe(true);
      expect(result.skillPath).toContain('my-code-style');
      expect(result.skillPath).toContain('SKILL.md');

      // Verify file was created
      const content = await fs.readFile(result.skillPath!, 'utf-8');
      expect(content).toContain('name: my-code-style');
      expect(content).toContain('user-invocable: true');
    });

    it('should fail when name is empty', async () => {
      const result = await createSkillFromChat({
        name: '',
        chatId: 'test-chat-id',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should fail when no chat history exists', async () => {
      vi.mocked(messageLogger.getChatHistory).mockResolvedValue('');

      const result = await createSkillFromChat({
        name: 'test-skill',
        chatId: 'empty-chat-id',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No chat history');
    });

    it('should fail when skill already exists', async () => {
      const mockHistory = 'Some chat content';
      vi.mocked(messageLogger.getChatHistory).mockResolvedValue(mockHistory);

      // Create skill first time
      const result1 = await createSkillFromChat({
        name: 'existing-skill',
        chatId: 'test-chat-id',
      });
      expect(result1.success).toBe(true);

      // Try to create same skill again
      const result2 = await createSkillFromChat({
        name: 'existing-skill',
        chatId: 'test-chat-id',
      });
      expect(result2.success).toBe(false);
      expect(result2.error).toContain('already exists');
    });

    it('should sanitize skill name', async () => {
      vi.mocked(messageLogger.getChatHistory).mockResolvedValue('Some content');

      const result = await createSkillFromChat({
        name: 'My Cool Skill!!!',
        chatId: 'test-chat-id',
      });

      expect(result.success).toBe(true);
      expect(result.skillPath).toContain('my-cool-skill');
    });

    it('should use custom description if provided', async () => {
      vi.mocked(messageLogger.getChatHistory).mockResolvedValue('Some content');

      const result = await createSkillFromChat({
        name: 'custom-desc-skill',
        chatId: 'test-chat-id',
        description: 'Custom skill description',
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(result.skillPath!, 'utf-8');
      expect(content).toContain('description: Custom skill description');
    });
  });

  describe('listUserSkills', () => {
    it('should return empty array when no skills exist', async () => {
      const skills = await listUserSkills();
      expect(skills).toEqual([]);
    });

    it('should list created skills', async () => {
      vi.mocked(messageLogger.getChatHistory).mockResolvedValue('Content');

      await createSkillFromChat({ name: 'skill-one', chatId: 'chat-1' });
      await createSkillFromChat({ name: 'skill-two', chatId: 'chat-2' });

      const skills = await listUserSkills();
      expect(skills).toContain('skill-one');
      expect(skills).toContain('skill-two');
    });
  });

  describe('deleteUserSkill', () => {
    it('should delete an existing skill', async () => {
      vi.mocked(messageLogger.getChatHistory).mockResolvedValue('Content');

      await createSkillFromChat({ name: 'to-delete', chatId: 'chat-1' });

      const result = await deleteUserSkill('to-delete');
      expect(result.success).toBe(true);

      const skills = await listUserSkills();
      expect(skills).not.toContain('to-delete');
    });

    it('should fail when skill does not exist', async () => {
      const result = await deleteUserSkill('non-existent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
