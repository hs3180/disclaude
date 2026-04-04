/**
 * PassiveModeManager tests.
 *
 * Tests in-memory behavior and file-based persistence.
 * Issue #2018: File-based persistence for passive mode state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassiveModeManager } from './passive-mode.js';

describe('PassiveModeManager', () => {
  describe('in-memory behavior (no persistence)', () => {
    let manager: PassiveModeManager;

    beforeEach(() => {
      manager = new PassiveModeManager();
    });

    it('should default to passive mode enabled (isPassiveModeDisabled returns false)', () => {
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(false);
    });

    it('should disable passive mode for a chat', () => {
      manager.setPassiveModeDisabled('oc_test', true);
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(true);
    });

    it('should re-enable passive mode for a chat', () => {
      manager.setPassiveModeDisabled('oc_test', true);
      manager.setPassiveModeDisabled('oc_test', false);
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(false);
    });

    it('should track multiple chats independently', () => {
      manager.setPassiveModeDisabled('oc_chat1', true);
      manager.setPassiveModeDisabled('oc_chat2', true);

      expect(manager.isPassiveModeDisabled('oc_chat1')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_chat2')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_chat3')).toBe(false);

      manager.setPassiveModeDisabled('oc_chat1', false);
      expect(manager.isPassiveModeDisabled('oc_chat1')).toBe(false);
      expect(manager.isPassiveModeDisabled('oc_chat2')).toBe(true);
    });

    it('should return all chats with passive mode disabled', () => {
      manager.setPassiveModeDisabled('oc_chat1', true);
      manager.setPassiveModeDisabled('oc_chat2', true);

      const chats = manager.getPassiveModeDisabledChats();
      expect(chats).toContain('oc_chat1');
      expect(chats).toContain('oc_chat2');
      expect(chats).toHaveLength(2);
    });

    it('should return empty array when no chats have passive mode disabled', () => {
      expect(manager.getPassiveModeDisabledChats()).toEqual([]);
    });

    it('should handle setPassiveModeDisabled(false) for non-existent chat gracefully', () => {
      expect(() => manager.setPassiveModeDisabled('oc_nonexistent', false)).not.toThrow();
      expect(manager.isPassiveModeDisabled('oc_nonexistent')).toBe(false);
    });
  });

  describe('file-based persistence', () => {
    let tmpDir: string;
    let configPath: string;
    let manager: PassiveModeManager;

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passive-mode-test-'));
      configPath = path.join(tmpDir, 'passive-mode.json');
      manager = new PassiveModeManager({ configPath });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should init without error when no config file exists', async () => {
      await manager.init();
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(false);
    });

    it('should load existing state from config file on init', async () => {
      // Pre-create the config file
      fs.writeFileSync(configPath, JSON.stringify({
        'oc_chat1': true,
        'oc_chat2': true,
      }, null, 2), 'utf-8');

      await manager.init();

      expect(manager.isPassiveModeDisabled('oc_chat1')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_chat2')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_chat3')).toBe(false);
    });

    it('should save state to file when setPassiveModeDisabled is called', async () => {
      await manager.init();
      manager.setPassiveModeDisabled('oc_test', true);

      const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(content['oc_test']).toBe(true);
    });

    it('should remove chat from file when passive mode is re-enabled', async () => {
      await manager.init();
      manager.setPassiveModeDisabled('oc_test', true);
      manager.setPassiveModeDisabled('oc_test', false);

      const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(content['oc_test']).toBeUndefined();
    });

    it('should handle multiple chats in persistence', async () => {
      await manager.init();
      manager.setPassiveModeDisabled('oc_chat1', true);
      manager.setPassiveModeDisabled('oc_chat2', true);
      manager.setPassiveModeDisabled('oc_chat3', true);
      manager.setPassiveModeDisabled('oc_chat2', false);

      const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(content['oc_chat1']).toBe(true);
      expect(content['oc_chat2']).toBeUndefined();
      expect(content['oc_chat3']).toBe(true);
    });

    it('should write valid JSON to file (atomic write)', async () => {
      await manager.init();
      manager.setPassiveModeDisabled('oc_test', true);

      // Verify the file is valid JSON
      const raw = fs.readFileSync(configPath, 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();

      // Verify no tmp file remains
      const tmpFile = configPath + '.tmp';
      expect(fs.existsSync(tmpFile)).toBe(false);
    });

    it('should create directory if it does not exist', async () => {
      const nestedPath = path.join(tmpDir, 'nested', 'dir', 'passive-mode.json');
      const nestedManager = new PassiveModeManager({ configPath: nestedPath });

      await nestedManager.init();
      nestedManager.setPassiveModeDisabled('oc_test', true);

      expect(fs.existsSync(nestedPath)).toBe(true);
    });

    it('should be idempotent when init is called multiple times', async () => {
      await manager.init();
      manager.setPassiveModeDisabled('oc_test', true);
      await manager.init();

      expect(manager.isPassiveModeDisabled('oc_test')).toBe(true);
    });

    it('should ignore invalid values in config file', async () => {
      fs.writeFileSync(configPath, JSON.stringify({
        'oc_valid': true,
        'oc_invalid_false': false,
        'oc_invalid_string': 'true',
        'oc_invalid_number': 1,
      }, null, 2), 'utf-8');

      await manager.init();

      expect(manager.isPassiveModeDisabled('oc_valid')).toBe(true);
      expect(manager.isPassiveModeDisabled('oc_invalid_false')).toBe(false);
      expect(manager.isPassiveModeDisabled('oc_invalid_string')).toBe(false);
      expect(manager.isPassiveModeDisabled('oc_invalid_number')).toBe(false);
    });

    it('should handle corrupted JSON gracefully on init', async () => {
      fs.writeFileSync(configPath, 'not valid json {{{', 'utf-8');

      // Should not throw, just log error
      await manager.init();
      expect(manager.isPassiveModeDisabled('oc_test')).toBe(false);
    });

    it('should persist across manager instances (simulating restart)', async () => {
      // First instance: set state
      await manager.init();
      manager.setPassiveModeDisabled('oc_chat1', true);
      manager.setPassiveModeDisabled('oc_chat2', true);

      // Second instance: load state
      const manager2 = new PassiveModeManager({ configPath });
      await manager2.init();

      expect(manager2.isPassiveModeDisabled('oc_chat1')).toBe(true);
      expect(manager2.isPassiveModeDisabled('oc_chat2')).toBe(true);
      expect(manager2.isPassiveModeDisabled('oc_chat3')).toBe(false);
    });

    it('should not persist when no configPath is provided', async () => {
      const noPersistManager = new PassiveModeManager();
      await noPersistManager.init();
      noPersistManager.setPassiveModeDisabled('oc_test', true);

      expect(noPersistManager.isPassiveModeDisabled('oc_test')).toBe(true);
      expect(fs.existsSync(configPath)).toBe(false);
    });

    it('should support cross-process state simulation (bash writes, node reads)', async () => {
      // Simulate bash script writing to the file
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        'oc_bash_created': true,
      }, null, 2), 'utf-8');

      // Node.js manager reads the state
      await manager.init();
      expect(manager.isPassiveModeDisabled('oc_bash_created')).toBe(true);
    });

    it('should handle empty config file', async () => {
      fs.writeFileSync(configPath, '{}', 'utf-8');

      await manager.init();
      expect(manager.getPassiveModeDisabledChats()).toEqual([]);
    });
  });
});
