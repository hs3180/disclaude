/**
 * Tests for DebugChatService.
 *
 * @see Issue #487 - Debug chat configuration commands
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DebugChatService } from './debug-chat-service.js';

describe('DebugChatService', () => {
  let tempDir: string;
  let testFilePath: string;
  let service: DebugChatService;

  beforeEach(() => {
    // Create a temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-chat-service-test-'));
    testFilePath = path.join(tempDir, 'debug-chat.json');
    service = new DebugChatService({ filePath: testFilePath });
  });

  afterEach(() => {
    // Cleanup temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('setDebugChat', () => {
    it('should set debug chat', () => {
      const previousChatId = service.setDebugChat('oc_test123');

      expect(previousChatId).toBeNull();
      expect(service.getDebugChat()).toBe('oc_test123');
    });

    it('should return previous chat ID when overwriting', () => {
      service.setDebugChat('oc_first');
      const previousChatId = service.setDebugChat('oc_second');

      expect(previousChatId).toBe('oc_first');
      expect(service.getDebugChat()).toBe('oc_second');
    });

    it('should persist config to file', () => {
      service.setDebugChat('oc_test123');

      // Create a new service instance to verify persistence
      const newService = new DebugChatService({ filePath: testFilePath });
      expect(newService.getDebugChat()).toBe('oc_test123');
    });
  });

  describe('getDebugChat', () => {
    it('should return null when not set', () => {
      expect(service.getDebugChat()).toBeNull();
    });

    it('should return chat ID when set', () => {
      service.setDebugChat('oc_test123');
      expect(service.getDebugChat()).toBe('oc_test123');
    });
  });

  describe('clearDebugChat', () => {
    it('should clear debug chat', () => {
      service.setDebugChat('oc_test123');
      const previousChatId = service.clearDebugChat();

      expect(previousChatId).toBe('oc_test123');
      expect(service.getDebugChat()).toBeNull();
    });

    it('should return null when clearing non-existent config', () => {
      const previousChatId = service.clearDebugChat();
      expect(previousChatId).toBeNull();
    });

    it('should remove file when clearing', () => {
      service.setDebugChat('oc_test123');
      expect(fs.existsSync(testFilePath)).toBe(true);

      service.clearDebugChat();
      expect(fs.existsSync(testFilePath)).toBe(false);
    });
  });

  describe('isDebugChat', () => {
    it('should return true for debug chat', () => {
      service.setDebugChat('oc_test123');
      expect(service.isDebugChat('oc_test123')).toBe(true);
    });

    it('should return false for non-debug chat', () => {
      service.setDebugChat('oc_test123');
      expect(service.isDebugChat('oc_other')).toBe(false);
    });

    it('should return false when not set', () => {
      expect(service.isDebugChat('oc_test123')).toBe(false);
    });
  });

  describe('persistence', () => {
    it('should handle corrupted file gracefully', () => {
      // Write invalid JSON
      fs.writeFileSync(testFilePath, 'not valid json');

      // Should not throw and start with null config
      const newService = new DebugChatService({ filePath: testFilePath });
      expect(newService.getDebugChat()).toBeNull();
    });

    it('should handle missing file gracefully', () => {
      const missingPath = path.join(tempDir, 'nonexistent', 'debug-chat.json');
      const newService = new DebugChatService({ filePath: missingPath });

      // Should start with null config
      expect(newService.getDebugChat()).toBeNull();
    });

    it('should create directory if not exists', () => {
      const nestedPath = path.join(tempDir, 'nested', 'dir', 'debug-chat.json');
      const newService = new DebugChatService({ filePath: nestedPath });

      newService.setDebugChat('oc_test');

      expect(fs.existsSync(nestedPath)).toBe(true);
    });

    it('should handle file with empty chatId', () => {
      // Write config with empty chatId
      fs.writeFileSync(testFilePath, JSON.stringify({ chatId: '' }));

      const newService = new DebugChatService({ filePath: testFilePath });
      expect(newService.getDebugChat()).toBeNull();
    });
  });

  describe('getFilePath', () => {
    it('should return the configured file path', () => {
      expect(service.getFilePath()).toBe(testFilePath);
    });
  });
});
