import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BroadcastChatService } from './broadcast-chat-service.js';

describe('BroadcastChatService', () => {
  let tempDir: string;
  let service: BroadcastChatService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-test-'));
    service = new BroadcastChatService({ workspaceDir: tempDir });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('loadBroadcastChats', () => {
    it('should return empty array when file does not exist', () => {
      const chats = service.loadBroadcastChats();
      expect(chats).toEqual([]);
    });

    it('should load chats from MD file', () => {
      const mdContent = `# 广播群配置

此文件由 disclaude 自动管理。

## 广播群列表

<!-- BROADCAST_LIST_START -->
### Test Chat
- **Chat ID**: \`oc_test123\`
- **描述**: A test chat
- **添加时间**: 2024-01-01T00:00:00Z
<!-- BROADCAST_LIST_END -->
`;
      fs.writeFileSync(path.join(tempDir, 'broadcast-chats.md'), mdContent);

      const chats = service.loadBroadcastChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].chatId).toBe('oc_test123');
      expect(chats[0].name).toBe('Test Chat');
      expect(chats[0].description).toBe('A test chat');
    });

    it('should use cache for subsequent loads', () => {
      const chats1 = service.loadBroadcastChats();
      const chats2 = service.loadBroadcastChats();
      expect(chats1).toBe(chats2); // Same reference due to cache
    });
  });

  describe('isBroadcastChat', () => {
    it('should return false for non-broadcast chat', () => {
      expect(service.isBroadcastChat('oc_unknown')).toBe(false);
    });

    it('should return true for broadcast chat', () => {
      service.addBroadcastChat('oc_test', 'Test Chat');
      expect(service.isBroadcastChat('oc_test')).toBe(true);
    });
  });

  describe('addBroadcastChat', () => {
    it('should add a new broadcast chat', () => {
      const result = service.addBroadcastChat('oc_new', 'New Chat', 'Description');
      expect(result).toBe(true);

      const chats = service.loadBroadcastChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].chatId).toBe('oc_new');
      expect(chats[0].name).toBe('New Chat');
      expect(chats[0].description).toBe('Description');
    });

    it('should return false if chat already exists', () => {
      service.addBroadcastChat('oc_existing', 'Existing Chat');
      const result = service.addBroadcastChat('oc_existing', 'Another Name');
      expect(result).toBe(false);
    });

    it('should create MD file with correct format', () => {
      service.addBroadcastChat('oc_test', 'Test Chat', 'Test description');

      const filePath = path.join(tempDir, 'broadcast-chats.md');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('# 广播群配置');
      expect(content).toContain('oc_test');
      expect(content).toContain('Test Chat');
    });
  });

  describe('removeBroadcastChat', () => {
    it('should remove an existing broadcast chat', () => {
      service.addBroadcastChat('oc_to_remove', 'To Remove');
      const result = service.removeBroadcastChat('oc_to_remove');
      expect(result).toBe(true);
      expect(service.isBroadcastChat('oc_to_remove')).toBe(false);
    });

    it('should return false if chat does not exist', () => {
      const result = service.removeBroadcastChat('oc_nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('should clear the cache', () => {
      service.addBroadcastChat('oc_test', 'Test');
      service.loadBroadcastChats();
      service.clearCache();

      // After clearing cache, should reload from file
      const chats = service.loadBroadcastChats();
      expect(chats).toHaveLength(1);
    });
  });

  describe('MD file format', () => {
    it('should handle multiple chats', () => {
      service.addBroadcastChat('oc_chat1', 'Chat 1', 'First chat');
      service.addBroadcastChat('oc_chat2', 'Chat 2', 'Second chat');

      const chats = service.loadBroadcastChats();
      expect(chats).toHaveLength(2);
    });

    it('should handle chat without description', () => {
      service.addBroadcastChat('oc_no_desc', 'No Description');

      const chats = service.loadBroadcastChats();
      expect(chats[0].description).toBeUndefined();
    });
  });
});
