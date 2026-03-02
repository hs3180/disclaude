/**
 * Tests for BroadcastChatService.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { BroadcastChatService } from './broadcast-chat-service.js';

describe('BroadcastChatService', () => {
  const testWorkspace = '/tmp/test-workspace-broadcast-' + Date.now();
  let service: BroadcastChatService;

  beforeEach(() => {
    // Create test workspace
    if (!fs.existsSync(testWorkspace)) {
      fs.mkdirSync(testWorkspace, { recursive: true });
    }

    // Create a new service instance with test workspace
    service = new BroadcastChatService({ workspaceDir: testWorkspace });
  });

  afterEach(() => {
    // Clean up test workspace
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  describe('loadBroadcastChats', () => {
    it('should return empty array when file does not exist', () => {
      const chats = service.loadBroadcastChats();
      expect(chats).toEqual([]);
    });

    it('should parse broadcast chats from MD file', () => {
      const mdContent = `# 广播群配置

此文件由 disclaude 自动管理。

## 广播群列表

<!-- BROADCAST_LIST_START -->
### 调试日志群
- **Chat ID**: \`oc_test123\`
- **描述**: 接收所有调试消息
- **添加时间**: 2024-01-01T00:00:00Z

### PR 通知群
- **Chat ID**: \`oc_test456\`
- **添加时间**: 2024-01-02T00:00:00Z
<!-- BROADCAST_LIST_END -->
`;

      const testFilePath = path.join(testWorkspace, 'broadcast-chats.md');
      fs.writeFileSync(testFilePath, mdContent, 'utf-8');

      const chats = service.loadBroadcastChats();
      expect(chats).toHaveLength(2);
      expect(chats[0].chatId).toBe('oc_test123');
      expect(chats[0].name).toBe('调试日志群');
      expect(chats[0].description).toBe('接收所有调试消息');
      expect(chats[1].chatId).toBe('oc_test456');
      expect(chats[1].name).toBe('PR 通知群');
      expect(chats[1].description).toBeUndefined();
    });

    it('should return cached result within TTL', async () => {
      const mdContent = `# 广播群配置

<!-- BROADCAST_LIST_START -->
### Test Group
- **Chat ID**: \`oc_cached\`
- **添加时间**: 2024-01-01T00:00:00Z
<!-- BROADCAST_LIST_END -->
`;

      const testFilePath = path.join(testWorkspace, 'broadcast-chats.md');
      fs.writeFileSync(testFilePath, mdContent, 'utf-8');

      // First load
      const chats1 = service.loadBroadcastChats();
      expect(chats1).toHaveLength(1);

      // Modify file
      fs.unlinkSync(testFilePath);

      // Second load (should return cached)
      const chats2 = service.loadBroadcastChats();
      expect(chats2).toHaveLength(1);
    });
  });

  describe('isBroadcastChat', () => {
    it('should return false when chat is not in broadcast list', () => {
      const result = service.isBroadcastChat('oc_not_in_list');
      expect(result).toBe(false);
    });

    it('should return true when chat is in broadcast list', () => {
      const mdContent = `# 广播群配置

<!-- BROADCAST_LIST_START -->
### Test Group
- **Chat ID**: \`oc_broadcast\`
- **添加时间**: 2024-01-01T00:00:00Z
<!-- BROADCAST_LIST_END -->
`;

      const testFilePath = path.join(testWorkspace, 'broadcast-chats.md');
      fs.writeFileSync(testFilePath, mdContent, 'utf-8');
      service.clearCache();

      const result = service.isBroadcastChat('oc_broadcast');
      expect(result).toBe(true);
    });
  });

  describe('addBroadcastChat', () => {
    it('should add a new broadcast chat', () => {
      const result = service.addBroadcastChat(
        'oc_new_chat',
        'New Group',
        'Test description'
      );

      expect(result).toBe(true);

      const chats = service.loadBroadcastChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].chatId).toBe('oc_new_chat');
      expect(chats[0].name).toBe('New Group');
      expect(chats[0].description).toBe('Test description');
      expect(chats[0].addedAt).toBeDefined();
    });

    it('should return false when chat already exists', () => {
      service.addBroadcastChat('oc_existing', 'Existing Group');
      const result = service.addBroadcastChat('oc_existing', 'Another Name');

      expect(result).toBe(false);
    });

    it('should create MD file with correct format', () => {
      service.addBroadcastChat('oc_format_test', 'Format Test Group');

      const testFilePath = path.join(testWorkspace, 'broadcast-chats.md');
      const content = fs.readFileSync(testFilePath, 'utf-8');
      expect(content).toContain('# 广播群配置');
      expect(content).toContain('<!-- BROADCAST_LIST_START -->');
      expect(content).toContain('<!-- BROADCAST_LIST_END -->');
      expect(content).toContain('oc_format_test');
    });

    it('should create workspace directory if not exists', () => {
      // Remove workspace directory
      fs.rmSync(testWorkspace, { recursive: true, force: true });
      expect(fs.existsSync(testWorkspace)).toBe(false);

      // Create new service instance
      const newService = new BroadcastChatService({ workspaceDir: testWorkspace });
      newService.addBroadcastChat('oc_test', 'Test Group');

      expect(fs.existsSync(testWorkspace)).toBe(true);
      expect(fs.existsSync(path.join(testWorkspace, 'broadcast-chats.md'))).toBe(true);
    });
  });

  describe('removeBroadcastChat', () => {
    it('should remove an existing broadcast chat', () => {
      service.addBroadcastChat('oc_to_remove', 'Group to Remove');
      const result = service.removeBroadcastChat('oc_to_remove');

      expect(result).toBe(true);

      const chats = service.loadBroadcastChats();
      expect(chats).toHaveLength(0);
    });

    it('should return false when chat does not exist', () => {
      const result = service.removeBroadcastChat('oc_nonexistent');

      expect(result).toBe(false);
    });

    it('should only remove specified chat', () => {
      service.addBroadcastChat('oc_keep', 'Keep This');
      service.addBroadcastChat('oc_remove', 'Remove This');

      service.removeBroadcastChat('oc_remove');

      const chats = service.loadBroadcastChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].chatId).toBe('oc_keep');
    });
  });

  describe('clearCache', () => {
    it('should force reload from file', () => {
      const mdContent = `# 广播群配置

<!-- BROADCAST_LIST_START -->
### Test Group
- **Chat ID**: \`oc_before_clear\`
- **添加时间**: 2024-01-01T00:00:00Z
<!-- BROADCAST_LIST_END -->
`;

      const testFilePath = path.join(testWorkspace, 'broadcast-chats.md');
      fs.writeFileSync(testFilePath, mdContent, 'utf-8');

      const chats1 = service.loadBroadcastChats();
      expect(chats1[0].chatId).toBe('oc_before_clear');

      // Modify file
      const newContent = mdContent.replace('oc_before_clear', 'oc_after_clear');
      fs.writeFileSync(testFilePath, newContent, 'utf-8');

      // Clear cache and reload
      service.clearCache();
      const chats2 = service.loadBroadcastChats();
      expect(chats2[0].chatId).toBe('oc_after_clear');
    });
  });

  describe('MD file format', () => {
    it('should handle empty description', () => {
      service.addBroadcastChat('oc_no_desc', 'No Description Group');

      const testFilePath = path.join(testWorkspace, 'broadcast-chats.md');
      const content = fs.readFileSync(testFilePath, 'utf-8');

      // Should contain chat ID and name but no description line
      expect(content).toContain('oc_no_desc');
      expect(content).toContain('No Description Group');
    });

    it('should include usage instructions', () => {
      service.addBroadcastChat('oc_test', 'Test');

      const testFilePath = path.join(testWorkspace, 'broadcast-chats.md');
      const content = fs.readFileSync(testFilePath, 'utf-8');

      expect(content).toContain('/broadcast add');
      expect(content).toContain('/broadcast remove');
    });
  });
});
