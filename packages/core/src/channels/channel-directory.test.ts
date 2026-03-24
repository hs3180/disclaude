/**
 * Tests for Channel Directory Manager.
 *
 * @module channels/channel-directory.test
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveChannelsDir,
  resolveChannelDir,
  resolveChannelConfigPath,
  validateChannelId,
  parseChannelConfig,
  serializeChannelConfig,
  addChannel,
  removeChannel,
  setChannelEnabled,
  getChannel,
  listChannels,
} from './channel-directory.js';

describe('ChannelDirectory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveChannelsDir', () => {
    it('should resolve to .disclaude/channels/ under base dir', () => {
      const result = resolveChannelsDir(tmpDir);
      expect(result).toBe(path.resolve(tmpDir, '.disclaude', 'channels'));
    });

    it('should use cwd when no base dir provided', () => {
      const result = resolveChannelsDir();
      expect(result).toContain('.disclaude');
      expect(result).toContain('channels');
    });
  });

  describe('resolveChannelDir', () => {
    it('should resolve channel directory path', () => {
      const result = resolveChannelDir('wechat', tmpDir);
      expect(result).toBe(path.resolve(tmpDir, '.disclaude', 'channels', 'wechat'));
    });
  });

  describe('resolveChannelConfigPath', () => {
    it('should resolve channel.yaml path', () => {
      const result = resolveChannelConfigPath('wechat', tmpDir);
      expect(result).toBe(path.resolve(tmpDir, '.disclaude', 'channels', 'wechat', 'channel.yaml'));
    });
  });

  describe('validateChannelId', () => {
    it('should accept valid channel IDs', () => {
      expect(() => validateChannelId('wechat')).not.toThrow();
      expect(() => validateChannelId('my-channel')).not.toThrow();
      expect(() => validateChannelId('channel_123')).not.toThrow();
      expect(() => validateChannelId('Channel')).not.toThrow();
    });

    it('should reject empty string', () => {
      expect(() => validateChannelId('')).toThrow('non-empty string');
    });

    it('should reject IDs starting with non-alphanumeric', () => {
      expect(() => validateChannelId('-bad')).toThrow('Invalid channel ID');
      expect(() => validateChannelId('_bad')).toThrow('Invalid channel ID');
    });

    it('should reject IDs with special characters', () => {
      expect(() => validateChannelId('bad/id')).toThrow('Invalid channel ID');
      expect(() => validateChannelId('bad.id')).toThrow('Invalid channel ID');
      expect(() => validateChannelId('bad id')).toThrow('Invalid channel ID');
    });

    it('should reject reserved IDs', () => {
      // '.' and '..' are rejected by the regex pattern first
      expect(() => validateChannelId('.')).toThrow();
      expect(() => validateChannelId('..')).toThrow();
      // 'templates' and '_shared' pass regex but are reserved
      expect(() => validateChannelId('templates')).toThrow('reserved');
      expect(() => validateChannelId('_shared')).toThrow('reserved');
    });
  });

  describe('parseChannelConfig', () => {
    it('should parse a valid channel.yaml', () => {
      const configPath = path.join(tmpDir, 'channel.yaml');
      fs.writeFileSync(configPath, [
        'id: wechat',
        'name: WeChat Channel',
        'module: "@disclaude/wechat-channel"',
        'enabled: true',
        'version: "1.0.0"',
        'description: "WeChat integration"',
        'config:',
        '  baseUrl: "https://bot0.weidbot.qq.com"',
        '  token: "test-token"',
      ].join('\n'), 'utf-8');

      const manifest = parseChannelConfig(configPath);
      expect(manifest.id).toBe('wechat');
      expect(manifest.name).toBe('WeChat Channel');
      expect(manifest.module).toBe('@disclaude/wechat-channel');
      expect(manifest.enabled).toBe(true);
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.description).toBe('WeChat integration');
      expect(manifest.config).toEqual({
        baseUrl: 'https://bot0.weidbot.qq.com',
        token: 'test-token',
      });
    });

    it('should default enabled to true when not specified', () => {
      const configPath = path.join(tmpDir, 'channel.yaml');
      fs.writeFileSync(configPath, [
        'id: test',
        'name: Test',
        'module: "./test-module"',
      ].join('\n'), 'utf-8');

      const manifest = parseChannelConfig(configPath);
      expect(manifest.enabled).toBe(true);
    });

    it('should default enabled to true when explicitly false', () => {
      const configPath = path.join(tmpDir, 'channel.yaml');
      fs.writeFileSync(configPath, [
        'id: test',
        'name: Test',
        'module: "./test-module"',
        'enabled: false',
      ].join('\n'), 'utf-8');

      const manifest = parseChannelConfig(configPath);
      expect(manifest.enabled).toBe(false);
    });

    it('should throw for missing id', () => {
      const configPath = path.join(tmpDir, 'channel.yaml');
      fs.writeFileSync(configPath, 'name: Test\nmodule: "./test"', 'utf-8');

      expect(() => parseChannelConfig(configPath)).toThrow('missing or invalid "id"');
    });

    it('should throw for missing module', () => {
      const configPath = path.join(tmpDir, 'channel.yaml');
      fs.writeFileSync(configPath, 'id: test\nname: Test', 'utf-8');

      expect(() => parseChannelConfig(configPath)).toThrow('missing or invalid "module"');
    });

    it('should throw for non-existent file', () => {
      expect(() => parseChannelConfig('/nonexistent/channel.yaml')).toThrow();
    });

    it('should handle minimal config', () => {
      const configPath = path.join(tmpDir, 'channel.yaml');
      fs.writeFileSync(configPath, 'id: x\nname: X\nmodule: x', 'utf-8');

      const manifest = parseChannelConfig(configPath);
      expect(manifest.version).toBeUndefined();
      expect(manifest.description).toBeUndefined();
      expect(manifest.author).toBeUndefined();
      expect(manifest.config).toBeUndefined();
    });
  });

  describe('serializeChannelConfig', () => {
    it('should serialize a full manifest', () => {
      const manifest = {
        id: 'wechat',
        name: 'WeChat Channel',
        module: '@disclaude/wechat-channel',
        enabled: true,
        version: '1.0.0',
        description: 'WeChat integration',
        author: 'test',
        config: { baseUrl: 'https://example.com' },
      };

      const yamlStr = serializeChannelConfig(manifest);
      expect(yamlStr).toContain('id: wechat');
      expect(yamlStr).toContain('name: WeChat Channel');
      expect(yamlStr).toContain('@disclaude/wechat-channel');
      expect(yamlStr).toContain('enabled: true');
      expect(yamlStr).toContain('version: 1.0.0');
      expect(yamlStr).toContain('description: WeChat integration');
      expect(yamlStr).toContain('author: test');
      expect(yamlStr).toContain('baseUrl: https://example.com');
    });

    it('should not include optional fields when undefined', () => {
      const manifest = {
        id: 'test',
        name: 'Test',
        module: './test',
        enabled: true,
      };

      const yamlStr = serializeChannelConfig(manifest);
      expect(yamlStr).not.toContain('version:');
      expect(yamlStr).not.toContain('description:');
      expect(yamlStr).not.toContain('author:');
      expect(yamlStr).not.toContain('config:');
    });
  });

  describe('addChannel', () => {
    it('should create channel directory and channel.yaml', () => {
      addChannel('wechat', '@disclaude/wechat-channel', {
        name: 'WeChat Channel',
        config: { baseUrl: 'https://example.com' },
      }, tmpDir);

      const channelDir = resolveChannelDir('wechat', tmpDir);
      const configPath = resolveChannelConfigPath('wechat', tmpDir);

      expect(fs.existsSync(channelDir)).toBe(true);
      expect(fs.existsSync(configPath)).toBe(true);

      const manifest = parseChannelConfig(configPath);
      expect(manifest.id).toBe('wechat');
      expect(manifest.name).toBe('WeChat Channel');
      expect(manifest.module).toBe('@disclaude/wechat-channel');
      expect(manifest.config).toEqual({ baseUrl: 'https://example.com' });
    });

    it('should default name to channelId when not provided', () => {
      addChannel('test', './test', {}, tmpDir);

      const manifest = parseChannelConfig(resolveChannelConfigPath('test', tmpDir));
      expect(manifest.name).toBe('test');
    });

    it('should not use description as name fallback', () => {
      addChannel('sms', './sms', {
        description: 'SMS Channel',
      }, tmpDir);

      const manifest = parseChannelConfig(resolveChannelConfigPath('sms', tmpDir));
      expect(manifest.name).toBe('sms');
      expect(manifest.description).toBe('SMS Channel');
    });

    it('should reject duplicate channel', () => {
      addChannel('test', './test', {}, tmpDir);

      expect(() => addChannel('test', './test2', {}, tmpDir)).toThrow('already exists');
    });

    it('should reject invalid channel ID', () => {
      expect(() => addChannel('../escape', './test', {}, tmpDir)).toThrow('Invalid channel ID');
    });

    it('should reject empty module', () => {
      expect(() => addChannel('test', '', {}, tmpDir)).toThrow('non-empty string');
    });

    it('should default enabled to true', () => {
      addChannel('test', './test', {}, tmpDir);

      const manifest = parseChannelConfig(resolveChannelConfigPath('test', tmpDir));
      expect(manifest.enabled).toBe(true);
    });

    it('should respect enabled: false option', () => {
      addChannel('test', './test', { enabled: false }, tmpDir);

      const manifest = parseChannelConfig(resolveChannelConfigPath('test', tmpDir));
      expect(manifest.enabled).toBe(false);
    });

    it('should create parent directories if needed', () => {
      addChannel('test', './test', {}, tmpDir);

      expect(fs.existsSync(path.resolve(tmpDir, '.disclaude', 'channels'))).toBe(true);
    });

    it('should clean up directory on write failure', () => {
      const channelDir = resolveChannelDir('cleanup-test', tmpDir);
      const channelsDir = resolveChannelsDir(tmpDir);
      fs.mkdirSync(channelsDir, { recursive: true });
      // Pre-create the directory to make mkdir succeed
      fs.mkdirSync(channelDir, { recursive: true });

      // Make the directory read-only so writeFileSync fails
      fs.chmodSync(channelDir, 0o444);

      try {
        expect(() => addChannel('cleanup-test', './test', {}, tmpDir)).toThrow();
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(channelDir, 0o755);
      }

      // After write failure, the directory should be cleaned up
      // so addChannel can be retried
      expect(fs.existsSync(channelDir)).toBe(false);

      // Verify retry succeeds
      addChannel('cleanup-test', './test', {}, tmpDir);
      expect(fs.existsSync(channelDir)).toBe(true);
      expect(fs.existsSync(resolveChannelConfigPath('cleanup-test', tmpDir))).toBe(true);
    });
  });

  describe('removeChannel', () => {
    it('should remove channel directory', () => {
      addChannel('test', './test', {}, tmpDir);
      expect(fs.existsSync(resolveChannelDir('test', tmpDir))).toBe(true);

      removeChannel('test', tmpDir);
      expect(fs.existsSync(resolveChannelDir('test', tmpDir))).toBe(false);
    });

    it('should throw for non-existent channel', () => {
      expect(() => removeChannel('nonexistent', tmpDir)).toThrow('does not exist');
    });

    it('should throw for directory without channel.yaml', () => {
      const channelsDir = resolveChannelsDir(tmpDir);
      fs.mkdirSync(channelsDir, { recursive: true });
      fs.mkdirSync(path.join(channelsDir, 'not-a-channel'), { recursive: true });

      expect(() => removeChannel('not-a-channel', tmpDir)).toThrow('does not contain channel.yaml');
    });

    it('should reject invalid channel ID', () => {
      expect(() => removeChannel('../escape', tmpDir)).toThrow('Invalid channel ID');
    });
  });

  describe('setChannelEnabled', () => {
    it('should enable a disabled channel', () => {
      addChannel('test', './test', { enabled: false }, tmpDir);

      setChannelEnabled('test', true, tmpDir);

      const manifest = parseChannelConfig(resolveChannelConfigPath('test', tmpDir));
      expect(manifest.enabled).toBe(true);
    });

    it('should disable an enabled channel', () => {
      addChannel('test', './test', { enabled: true }, tmpDir);

      setChannelEnabled('test', false, tmpDir);

      const manifest = parseChannelConfig(resolveChannelConfigPath('test', tmpDir));
      expect(manifest.enabled).toBe(false);
    });

    it('should throw for non-existent channel', () => {
      expect(() => setChannelEnabled('nonexistent', true, tmpDir)).toThrow('does not exist');
    });
  });

  describe('getChannel', () => {
    it('should return channel entry for existing channel', () => {
      addChannel('wechat', '@disclaude/wechat', { name: 'WeChat' }, tmpDir);

      const entry = getChannel('wechat', tmpDir);
      expect(entry).toBeDefined();
      expect(entry!.valid).toBe(true);
      expect(entry!.manifest.id).toBe('wechat');
      expect(entry!.manifest.name).toBe('WeChat');
      expect(entry!.manifest.module).toBe('@disclaude/wechat');
    });

    it('should return undefined for non-existent channel', () => {
      const entry = getChannel('nonexistent', tmpDir);
      expect(entry).toBeUndefined();
    });

    it('should return invalid entry for corrupted config', () => {
      const channelsDir = resolveChannelsDir(tmpDir);
      fs.mkdirSync(path.join(channelsDir, 'bad'), { recursive: true });
      fs.writeFileSync(path.join(channelsDir, 'bad', 'channel.yaml'), 'invalid: [yaml', 'utf-8');

      const entry = getChannel('bad', tmpDir);
      expect(entry).toBeDefined();
      expect(entry!.valid).toBe(false);
      expect(entry!.error).toBeDefined();
    });

    it('should return invalid entry when YAML id does not match directory name', () => {
      const channelsDir = resolveChannelsDir(tmpDir);
      fs.mkdirSync(path.join(channelsDir, 'mismatch'), { recursive: true });
      fs.writeFileSync(
        path.join(channelsDir, 'mismatch', 'channel.yaml'),
        'id: different-id\nname: Different\nmodule: ./test',
        'utf-8',
      );

      const entry = getChannel('mismatch', tmpDir);
      expect(entry).toBeDefined();
      expect(entry!.valid).toBe(false);
      expect(entry!.error).toContain('does not match directory name');
    });
  });

  describe('listChannels', () => {
    it('should return empty result for non-existent directory', () => {
      const result = listChannels(tmpDir);
      expect(result.channels).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.enabled).toBe(0);
      expect(result.disabled).toBe(0);
      expect(result.invalid).toBe(0);
    });

    it('should list all channels', () => {
      addChannel('feishu', './feishu', { name: 'Feishu' }, tmpDir);
      addChannel('wechat', './wechat', { name: 'WeChat' }, tmpDir);
      addChannel('rest', './rest', { name: 'REST', enabled: false }, tmpDir);

      const result = listChannels(tmpDir);
      expect(result.total).toBe(3);
      expect(result.enabled).toBe(2);
      expect(result.disabled).toBe(1);
      expect(result.invalid).toBe(0);

      const ids = result.channels.map(c => c.manifest.id).sort();
      expect(ids).toEqual(['feishu', 'rest', 'wechat']);
    });

    it('should skip directories without channel.yaml', () => {
      addChannel('valid', './valid', {}, tmpDir);

      // Create a non-channel directory
      const channelsDir = resolveChannelsDir(tmpDir);
      fs.mkdirSync(path.join(channelsDir, 'not-a-channel'), { recursive: true });

      const result = listChannels(tmpDir);
      expect(result.total).toBe(1);
      expect(result.channels[0].manifest.id).toBe('valid');
    });

    it('should skip hidden directories', () => {
      addChannel('valid', './valid', {}, tmpDir);

      // Create a hidden directory
      const channelsDir = resolveChannelsDir(tmpDir);
      fs.mkdirSync(path.join(channelsDir, '.hidden'), { recursive: true });
      fs.writeFileSync(path.join(channelsDir, '.hidden', 'channel.yaml'), 'id: .hidden\nname: Hidden\nmodule: ./hidden', 'utf-8');

      const result = listChannels(tmpDir);
      expect(result.total).toBe(1);
    });

    it('should skip directories with invalid channel IDs', () => {
      addChannel('valid', './valid', {}, tmpDir);

      // Create a directory with invalid ID (starts with hyphen)
      const channelsDir = resolveChannelsDir(tmpDir);
      fs.mkdirSync(path.join(channelsDir, '-invalid'), { recursive: true });
      fs.writeFileSync(path.join(channelsDir, '-invalid', 'channel.yaml'), 'id: -invalid\nname: Invalid\nmodule: ./test', 'utf-8');

      const result = listChannels(tmpDir);
      expect(result.total).toBe(1);
    });

    it('should handle mixed valid and invalid channels', () => {
      addChannel('valid', './valid', {}, tmpDir);

      // Create a channel with corrupted config (missing required fields)
      const channelsDir = resolveChannelsDir(tmpDir);
      fs.mkdirSync(path.join(channelsDir, 'corrupted'), { recursive: true });
      fs.writeFileSync(path.join(channelsDir, 'corrupted', 'channel.yaml'), 'name: broken\n', 'utf-8');

      const result = listChannels(tmpDir);
      expect(result.total).toBe(2);
      expect(result.enabled).toBe(1);
      expect(result.disabled).toBe(0);
      expect(result.invalid).toBe(1);

      const validEntry = result.channels.find(c => c.manifest.id === 'valid');
      const corruptedEntry = result.channels.find(c => c.manifest.id === 'corrupted');

      expect(validEntry).toBeDefined();
      expect(validEntry!.valid).toBe(true);
      expect(corruptedEntry).toBeDefined();
      expect(corruptedEntry!.valid).toBe(false);
      expect(corruptedEntry!.error).toBeDefined();
    });

    it('should detect YAML id mismatch with directory name', () => {
      addChannel('valid', './valid', {}, tmpDir);

      // Create a channel where YAML id doesn't match directory name
      const channelsDir = resolveChannelsDir(tmpDir);
      fs.mkdirSync(path.join(channelsDir, 'mismatch'), { recursive: true });
      fs.writeFileSync(
        path.join(channelsDir, 'mismatch', 'channel.yaml'),
        'id: wrong-id\nname: Wrong\nmodule: ./test',
        'utf-8',
      );

      const result = listChannels(tmpDir);
      expect(result.total).toBe(2);
      expect(result.invalid).toBe(1);

      const mismatchEntry = result.channels.find(c => c.manifest.id === 'wrong-id');
      expect(mismatchEntry).toBeDefined();
      expect(mismatchEntry!.valid).toBe(false);
      expect(mismatchEntry!.error).toContain('does not match directory name');
    });
  });
});
