/**
 * Tests for Channel Loader system (Issue #1422).
 *
 * Tests dynamic channel loading from `.disclaude/channels.yaml`.
 * Uses a real temporary directory for file I/O tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import {
  ChannelLoader,
  findDisclaudeDir,
  findDynamicChannelsFile,
  readDynamicChannelsFile,
  writeDynamicChannel,
  removeDynamicChannel,
  DYNAMIC_CHANNELS_FILENAME,
} from './channel-loader.js';
import { ChannelRegistry } from './channel-plugin.js';

describe('findDisclaudeDir', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(resolve(tmpdir(), 'disclaude-test-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('should return undefined when .disclaude does not exist', () => {
    expect(findDisclaudeDir(workspaceDir)).toBeUndefined();
  });

  it('should find .disclaude directory', () => {
    mkdirSync(resolve(workspaceDir, '.disclaude'));
    const result = findDisclaudeDir(workspaceDir);
    expect(result).toBe(resolve(workspaceDir, '.disclaude'));
  });
});

describe('findDynamicChannelsFile', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(resolve(tmpdir(), 'disclaude-test-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('should return undefined when no files exist', () => {
    expect(findDynamicChannelsFile(workspaceDir)).toBeUndefined();
  });

  it('should find channels.yaml in .disclaude', () => {
    mkdirSync(resolve(workspaceDir, '.disclaude'));
    writeFileSync(resolve(workspaceDir, '.disclaude', DYNAMIC_CHANNELS_FILENAME), '');
    const result = findDynamicChannelsFile(workspaceDir);
    expect(result).toBe(resolve(workspaceDir, '.disclaude', DYNAMIC_CHANNELS_FILENAME));
  });
});

describe('readDynamicChannelsFile', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(resolve(tmpdir(), 'disclaude-test-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('should return null when file does not exist', () => {
    expect(readDynamicChannelsFile(workspaceDir)).toBeNull();
  });

  it('should parse valid channels.yaml', () => {
    mkdirSync(resolve(workspaceDir, '.disclaude'));
    writeFileSync(
      resolve(workspaceDir, '.disclaude', DYNAMIC_CHANNELS_FILENAME),
      `
channels:
  wechat:
    enabled: true
    module: "@disclaude/wechat-channel"
    config:
      baseUrl: "https://bot0.weidbot.qq.com"
  custom:
    enabled: false
    module: "./channels/custom"
`
    );

    const result = readDynamicChannelsFile(workspaceDir);
    expect(result).not.toBeNull();
    expect(result!.channels!.wechat.enabled).toBe(true);
    expect(result!.channels!.wechat.module).toBe('@disclaude/wechat-channel');
    expect(result!.channels!.wechat.config).toEqual({ baseUrl: 'https://bot0.weidbot.qq.com' });
    expect(result!.channels!.custom.enabled).toBe(false);
  });

  it('should return null for empty file', () => {
    mkdirSync(resolve(workspaceDir, '.disclaude'));
    writeFileSync(resolve(workspaceDir, '.disclaude', DYNAMIC_CHANNELS_FILENAME), '');
    expect(readDynamicChannelsFile(workspaceDir)).toBeNull();
  });

  it('should return null for file without channels key', () => {
    mkdirSync(resolve(workspaceDir, '.disclaude'));
    writeFileSync(resolve(workspaceDir, '.disclaude', DYNAMIC_CHANNELS_FILENAME), 'foo: bar\n');
    expect(readDynamicChannelsFile(workspaceDir)).toBeNull();
  });
});

describe('writeDynamicChannel', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(resolve(tmpdir(), 'disclaude-test-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('should create .disclaude directory and channels.yaml', () => {
    writeDynamicChannel('wechat', '@disclaude/wechat-channel', { baseUrl: 'https://example.com' }, workspaceDir);

    expect(existsSync(resolve(workspaceDir, '.disclaude'))).toBe(true);
    expect(existsSync(resolve(workspaceDir, '.disclaude', DYNAMIC_CHANNELS_FILENAME))).toBe(true);

    const result = readDynamicChannelsFile(workspaceDir);
    expect(result!.channels!.wechat.module).toBe('@disclaude/wechat-channel');
    expect(result!.channels!.wechat.enabled).toBe(true);
    expect(result!.channels!.wechat.config).toEqual({ baseUrl: 'https://example.com' });
  });

  it('should append to existing channels.yaml', () => {
    // Write first channel
    writeDynamicChannel('wechat', '@disclaude/wechat-channel', undefined, workspaceDir);
    // Write second channel
    writeDynamicChannel('custom', './channels/custom', { key: 'value' }, workspaceDir);

    const result = readDynamicChannelsFile(workspaceDir);
    expect(Object.keys(result!.channels!)).toHaveLength(2);
    expect(result!.channels!.wechat.module).toBe('@disclaude/wechat-channel');
    expect(result!.channels!.custom.module).toBe('./channels/custom');
    expect(result!.channels!.custom.config).toEqual({ key: 'value' });
  });

  it('should update existing channel', () => {
    writeDynamicChannel('wechat', '@disclaude/wechat-channel', undefined, workspaceDir);
    writeDynamicChannel('wechat', '@disclaude/wechat-channel-v2', { updated: true }, workspaceDir);

    const result = readDynamicChannelsFile(workspaceDir);
    expect(Object.keys(result!.channels!)).toHaveLength(1);
    expect(result!.channels!.wechat.module).toBe('@disclaude/wechat-channel-v2');
    expect(result!.channels!.wechat.config).toEqual({ updated: true });
  });
});

describe('removeDynamicChannel', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(resolve(tmpdir(), 'disclaude-test-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('should return false when file does not exist', () => {
    expect(removeDynamicChannel('wechat', workspaceDir)).toBe(false);
  });

  it('should return false for unknown channel', () => {
    writeDynamicChannel('other', '@disclaude/other', undefined, workspaceDir);
    expect(removeDynamicChannel('wechat', workspaceDir)).toBe(false);
  });

  it('should remove a channel from the file', () => {
    writeDynamicChannel('wechat', '@disclaude/wechat', undefined, workspaceDir);
    writeDynamicChannel('custom', './channels/custom', undefined, workspaceDir);

    expect(removeDynamicChannel('wechat', workspaceDir)).toBe(true);

    const result = readDynamicChannelsFile(workspaceDir);
    expect(Object.keys(result!.channels!)).toHaveLength(1);
    expect(result!.channels!.wechat).toBeUndefined();
    expect(result!.channels!.custom).toBeDefined();
  });
});

describe('ChannelLoader', () => {
  let workspaceDir: string;
  let registry: ChannelRegistry;

  beforeEach(() => {
    workspaceDir = mkdtempSync(resolve(tmpdir(), 'disclaude-test-'));
    registry = new ChannelRegistry();
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('should return empty array when no config file', async () => {
      const loader = new ChannelLoader(registry, workspaceDir);
      const ids = await loader.load();
      expect(ids).toEqual([]);
    });

    it('should register enabled channels from config', async () => {
      mkdirSync(resolve(workspaceDir, '.disclaude'));
      writeFileSync(
        resolve(workspaceDir, '.disclaude', DYNAMIC_CHANNELS_FILENAME),
        `
channels:
  wechat:
    enabled: true
    module: "@disclaude/wechat-channel"
  custom:
    enabled: true
    module: "./channels/custom"
`
      );

      const loader = new ChannelLoader(registry, workspaceDir);
      const ids = await loader.load();
      expect(ids).toEqual(['wechat', 'custom']);
      expect(registry.has('wechat')).toBe(true);
      expect(registry.has('custom')).toBe(true);
    });

    it('should skip disabled channels', async () => {
      mkdirSync(resolve(workspaceDir, '.disclaude'));
      writeFileSync(
        resolve(workspaceDir, '.disclaude', DYNAMIC_CHANNELS_FILENAME),
        `
channels:
  wechat:
    enabled: true
    module: "@disclaude/wechat-channel"
  custom:
    enabled: false
    module: "./channels/custom"
`
      );

      const loader = new ChannelLoader(registry, workspaceDir);
      const ids = await loader.load();
      expect(ids).toEqual(['wechat']);
      expect(registry.has('wechat')).toBe(true);
      expect(registry.has('custom')).toBe(false);
    });

    it('should skip channels without module field', async () => {
      mkdirSync(resolve(workspaceDir, '.disclaude'));
      writeFileSync(
        resolve(workspaceDir, '.disclaude', DYNAMIC_CHANNELS_FILENAME),
        `
channels:
  bad:
    enabled: true
  good:
    enabled: true
    module: "@disclaude/good"
`
      );

      const loader = new ChannelLoader(registry, workspaceDir);
      const ids = await loader.load();
      expect(ids).toEqual(['good']);
    });
  });

  describe('listChannels', () => {
    it('should return empty array when no config', () => {
      const loader = new ChannelLoader(registry, workspaceDir);
      expect(loader.listChannels()).toEqual([]);
    });

    it('should list all configured channels', () => {
      mkdirSync(resolve(workspaceDir, '.disclaude'));
      writeFileSync(
        resolve(workspaceDir, '.disclaude', DYNAMIC_CHANNELS_FILENAME),
        `
channels:
  wechat:
    enabled: true
    module: "@disclaude/wechat-channel"
  custom:
    enabled: false
    module: "./channels/custom"
`
      );

      const loader = new ChannelLoader(registry, workspaceDir);
      const channels = loader.listChannels();
      expect(channels).toHaveLength(2);
      expect(channels[0]).toEqual({ id: 'wechat', enabled: true, module: '@disclaude/wechat-channel' });
      expect(channels[1]).toEqual({ id: 'custom', enabled: false, module: './channels/custom' });
    });
  });

  describe('getWorkspaceDir', () => {
    it('should return the configured workspace directory', () => {
      const loader = new ChannelLoader(registry, workspaceDir);
      expect(loader.getWorkspaceDir()).toBe(workspaceDir);
    });
  });
});

describe('DYNAMIC_CHANNELS_FILENAME', () => {
  it('should be channels.yaml', () => {
    expect(DYNAMIC_CHANNELS_FILENAME).toBe('channels.yaml');
  });
});
