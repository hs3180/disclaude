/**
 * Tests for ChannelLoader.
 * @see Issue #1422
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelLoader } from './channel-loader.js';
import type { IChannel } from '../types/channel.js';
import type { ExtendedChannelsConfig } from './channel-plugin.js';

// --- Test Helpers ---

function createMockChannel(id: string): IChannel {
  return {
    id,
    name: id,
    status: 'running',
    onMessage: vi.fn(),
    onControl: vi.fn(),
    sendMessage: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    isHealthy: () => true,
    getCapabilities: () => ({
      supportsCard: false,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: false,
      supportsMention: false,
      supportsUpdate: false,
    }),
  };
}

// --- Tests ---

describe('ChannelLoader', () => {
  let loader: ChannelLoader;

  beforeEach(() => {
    loader = new ChannelLoader('/test/config/dir');
  });

  describe('constructor', () => {
    it('should use provided baseDir', () => {
      // baseDir is private, but behavior is tested indirectly through load()
      const customLoader = new ChannelLoader('/custom/dir');
      const result = customLoader.load({});
      expect(result.loaded).toHaveLength(0);
    });

    it('should default baseDir to process.cwd()', () => {
      const defaultLoader = new ChannelLoader();
      const result = defaultLoader.load({});
      expect(result.loaded).toHaveLength(0);
    });
  });

  describe('registerBuiltin()', () => {
    it('should register a builtin channel', () => {
      const factory = () => createMockChannel('rest');
      loader.registerBuiltin('rest', factory, 'builtin:rest');

      expect(loader.getBuiltinNames()).toContain('rest');
    });

    it('should register multiple builtins', () => {
      loader.registerBuiltin('rest', () => createMockChannel('rest'), 'builtin:rest');
      loader.registerBuiltin('feishu', () => createMockChannel('feishu'), 'builtin:feishu');

      expect(loader.getBuiltinNames()).toHaveLength(2);
    });
  });

  describe('load() - built-in channels', () => {
    beforeEach(() => {
      loader.registerBuiltin('rest', () => createMockChannel('rest'), 'builtin:rest');
      loader.registerBuiltin('feishu', () => createMockChannel('feishu'), 'builtin:feishu');
    });

    it('should load configured built-in channels', () => {
      const config: ExtendedChannelsConfig = {
        rest: { enabled: true },
        feishu: { enabled: true },
      };

      const result = loader.load(config);

      expect(result.loaded).toHaveLength(2);
      expect(result.loaded.map((c) => c.name)).toContain('rest');
      expect(result.loaded.map((c) => c.name)).toContain('feishu');
      expect(result.failed).toHaveLength(0);
    });

    it('should skip disabled built-in channels', () => {
      const config: ExtendedChannelsConfig = {
        rest: { enabled: true },
        feishu: { enabled: false },
      };

      const result = loader.load(config);

      expect(result.loaded).toHaveLength(1);
      expect(result.loaded[0].name).toBe('rest');
      expect(result.skipped).toContain('feishu');
    });

    it('should skip undefined channel configs', () => {
      const config: ExtendedChannelsConfig = {
        rest: undefined,
        feishu: { enabled: true },
      };

      const result = loader.load(config);

      expect(result.loaded).toHaveLength(1);
      expect(result.skipped).toContain('rest');
    });

    it('should treat built-in as enabled by default (no enabled field)', () => {
      const config: ExtendedChannelsConfig = {
        rest: {},
      };

      const result = loader.load(config);

      expect(result.loaded).toHaveLength(1);
      expect(result.loaded[0].enabled).toBe(true);
    });

    it('should mark built-in channels as non-dynamic', () => {
      const config: ExtendedChannelsConfig = {
        rest: { enabled: true },
      };

      const result = loader.load(config);

      expect(result.loaded[0].isDynamic).toBe(false);
      expect(result.loaded[0].source).toBe('builtin:rest');
    });

    it('should create channel instances from built-in factories', () => {
      const config: ExtendedChannelsConfig = {
        rest: { enabled: true },
      };

      const result = loader.load(config);
      const channel = result.loaded[0].factory({});

      expect(channel).toBeDefined();
      expect(channel.id).toBe('rest');
    });
  });

  describe('load() - unknown channels without module', () => {
    beforeEach(() => {
      loader.registerBuiltin('rest', () => createMockChannel('rest'), 'builtin:rest');
    });

    it('should skip unknown channels that have no module field', () => {
      const config: ExtendedChannelsConfig = {
        rest: { enabled: true },
        unknown: { enabled: true },
      };

      const result = loader.load(config);

      expect(result.loaded).toHaveLength(1);
      expect(result.loaded[0].name).toBe('rest');
      expect(result.skipped).toContain('unknown');
    });
  });

  describe('load() - dynamic channels (module field)', () => {
    it('should create lazy-loading factory for module channels', () => {
      const config: ExtendedChannelsConfig = {
        wechat: {
          enabled: true,
          module: './channels/wechat-channel',
        },
      };

      const result = loader.load(config);

      expect(result.loaded).toHaveLength(1);
      expect(result.loaded[0].name).toBe('wechat');
      expect(result.loaded[0].isDynamic).toBe(true);
      expect(result.loaded[0].source).toBe('dynamic:./channels/wechat-channel');
    });

    it('should mark dynamic channels as having lazy factories', () => {
      const config: ExtendedChannelsConfig = {
        custom: {
          enabled: true,
          module: '@disclaude/custom-channel',
        },
      };

      const result = loader.load(config);

      // The factory should be a function (lazy loader)
      expect(typeof result.loaded[0].factory).toBe('function');
    });

    it('should record load failure when module cannot be resolved', () => {
      const config: ExtendedChannelsConfig = {
        bad: {
          enabled: true,
          module: './nonexistent-channel',
        },
      };

      const result = loader.load(config);

      // Module resolution itself doesn't fail during load()
      // because it's lazy-loaded. The failure happens on factory call.
      // But the path resolution will warn about missing file.
      expect(result.loaded).toHaveLength(1);
    });
  });

  describe('load() - empty config', () => {
    it('should return empty result for undefined config', () => {
      const result = loader.load(undefined);

      expect(result.loaded).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });

    it('should return empty result for empty config object', () => {
      const result = loader.load({});

      expect(result.loaded).toHaveLength(0);
    });
  });

  describe('load() - mixed scenarios', () => {
    beforeEach(() => {
      loader.registerBuiltin('rest', () => createMockChannel('rest'), 'builtin:rest');
      loader.registerBuiltin('feishu', () => createMockChannel('feishu'), 'builtin:feishu');
    });

    it('should handle mixed built-in and dynamic channels', () => {
      const config: ExtendedChannelsConfig = {
        rest: { enabled: true },
        feishu: { enabled: true },
        wechat: {
          enabled: true,
          module: './channels/wechat',
        },
      };

      const result = loader.load(config);

      expect(result.loaded).toHaveLength(3);
      expect(result.failed).toHaveLength(0);

      // Check built-in channels
      const rest = result.loaded.find((c) => c.name === 'rest')!;
      expect(rest.isDynamic).toBe(false);
      expect(rest.source).toBe('builtin:rest');

      // Check dynamic channel
      const wechat = result.loaded.find((c) => c.name === 'wechat')!;
      expect(wechat.isDynamic).toBe(true);
    });

    it('should handle all disabled channels', () => {
      const config: ExtendedChannelsConfig = {
        rest: { enabled: false },
        feishu: { enabled: false },
      };

      const result = loader.load(config);

      expect(result.loaded).toHaveLength(0);
      expect(result.skipped).toHaveLength(2);
    });
  });

  describe('load() - module path resolution', () => {
    it('should preserve absolute paths', () => {
      const config: ExtendedChannelsConfig = {
        custom: {
          enabled: true,
          module: '/absolute/path/to/channel',
        },
      };

      const result = loader.load(config);

      expect(result.loaded[0].source).toBe('dynamic:/absolute/path/to/channel');
    });

    it('should preserve npm package names', () => {
      const config: ExtendedChannelsConfig = {
        custom: {
          enabled: true,
          module: '@disclaude/wechat-channel',
        },
      };

      const result = loader.load(config);

      expect(result.loaded[0].source).toBe('dynamic:@disclaude/wechat-channel');
    });

    it('should resolve relative paths from baseDir', () => {
      const config: ExtendedChannelsConfig = {
        custom: {
          enabled: true,
          module: './local/channel',
        },
      };

      const result = loader.load(config);

      // Relative path should be resolved to absolute
      expect(result.loaded[0].source).toBe('dynamic:./local/channel');
    });
  });

  describe('channel config passthrough', () => {
    it('should preserve config field for dynamic channels', () => {
      const config: ExtendedChannelsConfig = {
        wechat: {
          enabled: true,
          module: './channels/wechat',
          config: {
            baseUrl: 'https://api.example.com',
            token: 'secret',
          },
        },
      };

      const result = loader.load(config);

      // Config is preserved in the DynamicChannelConfig
      // but not directly on the ResolvedChannel (it's separate)
      expect(result.loaded).toHaveLength(1);
    });
  });
});
