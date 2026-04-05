/**
 * Unit tests for Passive Mode Chat File Sync.
 *
 * Issue #2018: Temporary chats should disable passive mode by default.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassiveModeManager } from './passive-mode.js';
import { syncPassiveModeFromChatFiles } from './passive-mode-chat-sync.js';

describe('PassiveModeChatSync', () => {
  let tempDir: string;
  let manager: PassiveModeManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-sync-test-'));
    manager = new PassiveModeManager();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('syncPassiveModeFromChatFiles', () => {
    it('should disable passive mode for active chat with passiveMode: false', () => {
      // Create an active chat file with passiveMode: false
      const chatFile = {
        id: 'test-chat',
        status: 'active',
        chatId: 'oc_newgroup',
        createdAt: new Date().toISOString(),
        passiveMode: false,
      };
      fs.writeFileSync(
        path.join(tempDir, 'test-chat.json'),
        JSON.stringify(chatFile, null, 2),
      );

      const count = syncPassiveModeFromChatFiles(tempDir, manager);
      expect(count).toBe(1);
      expect(manager.isPassiveModeDisabled('oc_newgroup')).toBe(true);
    });

    it('should NOT disable passive mode for active chat with passiveMode: true', () => {
      const chatFile = {
        id: 'test-chat',
        status: 'active',
        chatId: 'oc_normal_group',
        createdAt: new Date().toISOString(),
        passiveMode: true,
      };
      fs.writeFileSync(
        path.join(tempDir, 'test-chat.json'),
        JSON.stringify(chatFile, null, 2),
      );

      const count = syncPassiveModeFromChatFiles(tempDir, manager);
      expect(count).toBe(0);
      expect(manager.isPassiveModeDisabled('oc_normal_group')).toBe(false);
    });

    it('should default to passive mode disabled when passiveMode is undefined', () => {
      // When passiveMode is undefined, it should NOT disable passive mode
      // (undefined means "use default" = passive mode enabled)
      const chatFile = {
        id: 'test-chat',
        status: 'active',
        chatId: 'oc_default_group',
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(tempDir, 'test-chat.json'),
        JSON.stringify(chatFile, null, 2),
      );

      const count = syncPassiveModeFromChatFiles(tempDir, manager);
      expect(count).toBe(0);
      expect(manager.isPassiveModeDisabled('oc_default_group')).toBe(false);
    });

    it('should skip pending chats (not yet activated)', () => {
      const chatFile = {
        id: 'pending-chat',
        status: 'pending',
        chatId: null,
        createdAt: new Date().toISOString(),
        passiveMode: false,
      };
      fs.writeFileSync(
        path.join(tempDir, 'pending-chat.json'),
        JSON.stringify(chatFile, null, 2),
      );

      const count = syncPassiveModeFromChatFiles(tempDir, manager);
      expect(count).toBe(0);
    });

    it('should skip expired chats', () => {
      const chatFile = {
        id: 'old-chat',
        status: 'active',
        chatId: 'oc_old_group',
        createdAt: '2020-01-01T00:00:00Z',
        passiveMode: false,
      };
      fs.writeFileSync(
        path.join(tempDir, 'old-chat.json'),
        JSON.stringify(chatFile, null, 2),
      );

      const count = syncPassiveModeFromChatFiles(tempDir, manager);
      expect(count).toBe(0);
    });

    it('should skip active chat without chatId', () => {
      const chatFile = {
        id: 'no-chatid',
        status: 'active',
        chatId: null,
        createdAt: new Date().toISOString(),
        passiveMode: false,
      };
      fs.writeFileSync(
        path.join(tempDir, 'no-chatid.json'),
        JSON.stringify(chatFile, null, 2),
      );

      const count = syncPassiveModeFromChatFiles(tempDir, manager);
      expect(count).toBe(0);
    });

    it('should handle non-existent directory gracefully', () => {
      const count = syncPassiveModeFromChatFiles('/non/existent/path', manager);
      expect(count).toBe(0);
    });

    it('should skip corrupted JSON files', () => {
      fs.writeFileSync(path.join(tempDir, 'corrupt.json'), 'not valid json');
      fs.writeFileSync(path.join(tempDir, 'valid.json'), JSON.stringify({
        id: 'valid-chat',
        status: 'active',
        chatId: 'oc_valid',
        createdAt: new Date().toISOString(),
        passiveMode: false,
      }, null, 2));

      const count = syncPassiveModeFromChatFiles(tempDir, manager);
      expect(count).toBe(1);
      expect(manager.isPassiveModeDisabled('oc_valid')).toBe(true);
    });

    it('should skip non-JSON files', () => {
      fs.writeFileSync(path.join(tempDir, 'readme.txt'), 'Hello');
      fs.writeFileSync(path.join(tempDir, 'script.sh'), '#!/bin/bash');

      const count = syncPassiveModeFromChatFiles(tempDir, manager);
      expect(count).toBe(0);
    });

    it('should handle multiple active chats', () => {
      const chats = [
        { id: 'chat1', status: 'active', chatId: 'oc_1', passiveMode: false },
        { id: 'chat2', status: 'active', chatId: 'oc_2', passiveMode: true },
        { id: 'chat3', status: 'active', chatId: 'oc_3', passiveMode: false },
        { id: 'chat4', status: 'pending', chatId: null, passiveMode: false },
      ];

      for (const chat of chats) {
        fs.writeFileSync(
          path.join(tempDir, `${chat.id}.json`),
          JSON.stringify({ ...chat, createdAt: new Date().toISOString() }, null, 2),
        );
      }

      const count = syncPassiveModeFromChatFiles(tempDir, manager);
      expect(count).toBe(2);
      expect(manager.isPassiveModeDisabled('oc_1')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_2')).toBe(false);
      expect(manager.isPassiveModeDisabled('oc_3')).toBe(true);
    });

    it('should not re-apply passive mode if already set', () => {
      const chatFile = {
        id: 'test-chat',
        status: 'active',
        chatId: 'oc_existing',
        createdAt: new Date().toISOString(),
        passiveMode: false,
      };
      fs.writeFileSync(
        path.join(tempDir, 'test-chat.json'),
        JSON.stringify(chatFile, null, 2),
      );

      // First sync
      const count1 = syncPassiveModeFromChatFiles(tempDir, manager);
      expect(count1).toBe(1);

      // Second sync — should not re-apply
      const count2 = syncPassiveModeFromChatFiles(tempDir, manager);
      expect(count2).toBe(0);
    });

    it('should not override manually enabled passive mode', () => {
      // Pre-set passive mode as disabled
      manager.setPassiveModeDisabled('oc_manual', true);

      const chatFile = {
        id: 'manual-chat',
        status: 'active',
        chatId: 'oc_manual',
        createdAt: new Date().toISOString(),
        passiveMode: true,
      };
      fs.writeFileSync(
        path.join(tempDir, 'manual-chat.json'),
        JSON.stringify(chatFile, null, 2),
      );

      const count = syncPassiveModeFromChatFiles(tempDir, manager);
      expect(count).toBe(0);
      // Manual setting should be preserved
      expect(manager.isPassiveModeDisabled('oc_manual')).toBe(true);
    });
  });
});
