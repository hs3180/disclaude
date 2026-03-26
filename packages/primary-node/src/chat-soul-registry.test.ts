/**
 * Tests for ChatSoulRegistry.
 *
 * Issue #1228: Discussion focus via SOUL.md personality injection.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatSoulRegistry } from './chat-soul-registry.js';

describe('ChatSoulRegistry', () => {
  let tempDir: string;
  let registry: ChatSoulRegistry;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soul-registry-test-'));
    registry = new ChatSoulRegistry(tempDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('resolveSoulPath', () => {
    it('should resolve built-in "discussion" profile', () => {
      const result = registry.resolveSoulPath('discussion');
      expect(result).toContain('discussion.md');
      expect(result).toContain(tempDir);
    });

    it('should resolve absolute paths as-is', () => {
      const absolutePath = '/tmp/my-soul.md';
      const result = registry.resolveSoulPath(absolutePath);
      expect(result).toBe(absolutePath);
    });

    it('should expand tilde paths', () => {
      const result = registry.resolveSoulPath('~/my-soul.md');
      expect(result).toBe(path.join(os.homedir(), 'my-soul.md'));
    });

    it('should resolve relative paths against workspace', () => {
      const result = registry.resolveSoulPath('my-soul.md', '/workspace');
      expect(result).toBe(path.resolve('/workspace', 'my-soul.md'));
    });

    it('should resolve relative paths without workspace', () => {
      const result = registry.resolveSoulPath('my-soul.md');
      expect(result).toBe(path.resolve('my-soul.md'));
    });

    it('should throw for built-in profile when builtinSoulsDir not configured', () => {
      const noBuiltinRegistry = new ChatSoulRegistry();
      expect(() => noBuiltinRegistry.resolveSoulPath('discussion')).toThrow('builtinSoulsDir not configured');
    });
  });

  describe('registerSoul', () => {
    it('should load and register a soul file', async () => {
      const soulFile = path.join(tempDir, 'custom-soul.md');
      await fs.promises.writeFile(soulFile, 'You are a helpful assistant.');

      const result = await registry.registerSoul('chat-123', soulFile);

      expect(result.content).toBe('You are a helpful assistant.');
      expect(result.resolvedPath).toBe(soulFile);
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(registry.hasSoul('chat-123')).toBe(true);
    });

    it('should register built-in "discussion" profile', async () => {
      const discussionFile = path.join(tempDir, 'discussion.md');
      await fs.promises.writeFile(discussionFile, 'Stay on topic.');

      const result = await registry.registerSoul('chat-456', 'discussion');

      expect(result.content).toBe('Stay on topic.');
      expect(registry.getSoulContent('chat-456')).toBe('Stay on topic.');
    });

    it('should trim whitespace from content', async () => {
      const soulFile = path.join(tempDir, 'soul.md');
      await fs.promises.writeFile(soulFile, '  Content with spaces  \n  ');

      const result = await registry.registerSoul('chat-789', soulFile);
      expect(result.content).toBe('Content with spaces');
    });

    it('should throw for non-existent file', async () => {
      await expect(
        registry.registerSoul('chat-error', '/non/existent/file.md')
      ).rejects.toThrow('Failed to load soul file');
    });

    it('should throw for file exceeding 32KB', async () => {
      const soulFile = path.join(tempDir, 'large-soul.md');
      const largeContent = 'x'.repeat(32 * 1024 + 1);
      await fs.promises.writeFile(soulFile, largeContent);

      await expect(
        registry.registerSoul('chat-large', soulFile)
      ).rejects.toThrow('too large');
    });

    it('should accept files within 32KB', async () => {
      const soulFile = path.join(tempDir, 'exact-soul.md');
      const content = 'x'.repeat(32 * 1024);
      await fs.promises.writeFile(soulFile, content);

      const result = await registry.registerSoul('chat-exact', soulFile);
      expect(result.sizeBytes).toBe(32 * 1024);
    });

    it('should handle Unicode content correctly', async () => {
      const soulFile = path.join(tempDir, 'unicode-soul.md');
      const unicodeContent = '你是一个有帮助的助手 🤖\n专注讨论主题。';
      await fs.promises.writeFile(soulFile, unicodeContent);

      const result = await registry.registerSoul('chat-unicode', soulFile);
      expect(result.content).toBe(unicodeContent.trim());
      expect(result.sizeBytes).toBe(Buffer.byteLength(unicodeContent.trim(), 'utf-8'));
    });
  });

  describe('getSoulContent', () => {
    it('should return undefined for unregistered chatId', () => {
      expect(registry.getSoulContent('unknown')).toBeUndefined();
    });

    it('should return content for registered chatId', async () => {
      const soulFile = path.join(tempDir, 'test.md');
      await fs.promises.writeFile(soulFile, 'Test content');
      await registry.registerSoul('chat-test', soulFile);

      expect(registry.getSoulContent('chat-test')).toBe('Test content');
    });
  });

  describe('unregisterSoul', () => {
    it('should remove soul for a chatId', async () => {
      const soulFile = path.join(tempDir, 'temp.md');
      await fs.promises.writeFile(soulFile, 'Temporary soul');
      await registry.registerSoul('chat-temp', soulFile);

      expect(registry.hasSoul('chat-temp')).toBe(true);
      registry.unregisterSoul('chat-temp');
      expect(registry.hasSoul('chat-temp')).toBe(false);
      expect(registry.getSoulContent('chat-temp')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should clear all registered souls', async () => {
      const soulFile1 = path.join(tempDir, 'soul1.md');
      const soulFile2 = path.join(tempDir, 'soul2.md');
      await fs.promises.writeFile(soulFile1, 'Soul 1');
      await fs.promises.writeFile(soulFile2, 'Soul 2');
      await registry.registerSoul('chat-1', soulFile1);
      await registry.registerSoul('chat-2', soulFile2);

      registry.clear();
      expect(registry.hasSoul('chat-1')).toBe(false);
      expect(registry.hasSoul('chat-2')).toBe(false);
    });
  });
});
