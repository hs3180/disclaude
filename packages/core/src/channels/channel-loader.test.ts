/**
 * Tests for Channel Loader.
 *
 * @module channels/channel-loader.test
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChannelLoader } from './channel-loader.js';
import { addChannel } from './channel-directory.js';

describe('ChannelLoader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-loader-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should use provided baseDir', () => {
      const loader = new ChannelLoader({ baseDir: tmpDir });
      expect(loader.getChannelsDir()).toContain(tmpDir);
    });

    it('should default to cwd when no baseDir provided', () => {
      const loader = new ChannelLoader();
      expect(loader.getChannelsDir()).toContain('.disclaude');
    });
  });

  describe('load', () => {
    it('should return empty array when no channels exist', () => {
      const loader = new ChannelLoader({ baseDir: tmpDir });
      const channels = loader.load();
      expect(channels).toEqual([]);
    });

    it('should load all enabled channels', () => {
      addChannel('feishu', './feishu', { name: 'Feishu' }, tmpDir);
      addChannel('wechat', './wechat', { name: 'WeChat' }, tmpDir);

      const loader = new ChannelLoader({ baseDir: tmpDir });
      const channels = loader.load();

      expect(channels.length).toBe(2);
      const ids = channels.map(c => c.manifest.id).sort();
      expect(ids).toEqual(['feishu', 'wechat']);
    });

    it('should skip disabled channels by default', () => {
      addChannel('enabled', './enabled', {}, tmpDir);
      addChannel('disabled', './disabled', { enabled: false }, tmpDir);

      const loader = new ChannelLoader({ baseDir: tmpDir });
      const channels = loader.load();

      expect(channels.length).toBe(1);
      expect(channels[0].manifest.id).toBe('enabled');
    });

    it('should include disabled channels when skipDisabled is false', () => {
      addChannel('enabled', './enabled', {}, tmpDir);
      addChannel('disabled', './disabled', { enabled: false }, tmpDir);

      const loader = new ChannelLoader({ baseDir: tmpDir, skipDisabled: false });
      const channels = loader.load();

      expect(channels.length).toBe(2);
    });

    it('should include invalid channels with error info', () => {
      addChannel('valid', './valid', {}, tmpDir);

      // Create corrupted channel (missing required fields)
      const channelsDir = path.resolve(tmpDir, '.disclaude', 'channels');
      fs.mkdirSync(path.join(channelsDir, 'corrupted'), { recursive: true });
      fs.writeFileSync(path.join(channelsDir, 'corrupted', 'channel.yaml'), 'name: broken\n', 'utf-8');

      const loader = new ChannelLoader({ baseDir: tmpDir });
      const channels = loader.load();

      expect(channels.length).toBe(2);
      const valid = channels.find(c => c.manifest.id === 'valid');
      const corrupted = channels.find(c => c.manifest.id === 'corrupted');

      expect(valid!.valid).toBe(true);
      expect(corrupted!.valid).toBe(false);
      expect(corrupted!.error).toBeDefined();
    });
  });

  describe('loadOne', () => {
    it('should load a specific channel by ID', () => {
      addChannel('wechat', '@disclaude/wechat', { name: 'WeChat' }, tmpDir);

      const loader = new ChannelLoader({ baseDir: tmpDir });
      const channel = loader.loadOne('wechat');

      expect(channel).toBeDefined();
      expect(channel!.manifest.id).toBe('wechat');
      expect(channel!.manifest.module).toBe('@disclaude/wechat');
      expect(channel!.valid).toBe(true);
    });

    it('should return undefined for non-existent channel', () => {
      const loader = new ChannelLoader({ baseDir: tmpDir });
      const channel = loader.loadOne('nonexistent');

      expect(channel).toBeUndefined();
    });

    it('should return undefined for disabled channel when skipDisabled is true', () => {
      addChannel('disabled', './disabled', { enabled: false }, tmpDir);

      const loader = new ChannelLoader({ baseDir: tmpDir, skipDisabled: true });
      const channel = loader.loadOne('disabled');

      expect(channel).toBeUndefined();
    });

    it('should return disabled channel when skipDisabled is false', () => {
      addChannel('disabled', './disabled', { enabled: false }, tmpDir);

      const loader = new ChannelLoader({ baseDir: tmpDir, skipDisabled: false });
      const channel = loader.loadOne('disabled');

      expect(channel).toBeDefined();
      expect(channel!.manifest.enabled).toBe(false);
    });

    it('should return invalid channel with error', () => {
      const channelsDir = path.resolve(tmpDir, '.disclaude', 'channels');
      fs.mkdirSync(path.join(channelsDir, 'bad'), { recursive: true });
      fs.writeFileSync(path.join(channelsDir, 'bad', 'channel.yaml'), 'name: broken\n', 'utf-8');

      const loader = new ChannelLoader({ baseDir: tmpDir });
      const channel = loader.loadOne('bad');

      expect(channel).toBeDefined();
      expect(channel!.valid).toBe(false);
      expect(channel!.error).toBeDefined();
    });
  });

  describe('hasChannel', () => {
    it('should return true for existing channel', () => {
      addChannel('test', './test', {}, tmpDir);

      const loader = new ChannelLoader({ baseDir: tmpDir });
      expect(loader.hasChannel('test')).toBe(true);
    });

    it('should return false for non-existent channel', () => {
      const loader = new ChannelLoader({ baseDir: tmpDir });
      expect(loader.hasChannel('nonexistent')).toBe(false);
    });
  });

  describe('getManifest', () => {
    it('should return manifest for existing channel', () => {
      addChannel('wechat', '@disclaude/wechat', {
        name: 'WeChat',
        version: '1.0.0',
      }, tmpDir);

      const loader = new ChannelLoader({ baseDir: tmpDir });
      const manifest = loader.getManifest('wechat');

      expect(manifest).toBeDefined();
      expect(manifest!.id).toBe('wechat');
      expect(manifest!.name).toBe('WeChat');
      expect(manifest!.module).toBe('@disclaude/wechat');
      expect(manifest!.version).toBe('1.0.0');
    });

    it('should return undefined for non-existent channel', () => {
      const loader = new ChannelLoader({ baseDir: tmpDir });
      const manifest = loader.getManifest('nonexistent');

      expect(manifest).toBeUndefined();
    });
  });
});
