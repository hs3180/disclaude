/**
 * Tests for Built-in Channel Descriptors.
 *
 * Tests ChannelDescriptor instances for all built-in channels (RestChannel,
 * FeishuChannel, WeChatChannel) and the getDefaultChannelRegistry() factory.
 *
 * @module channels/channel-descriptors.test
 * @see Issue #1553 - ChannelRegistry Infrastructure (Phase 0)
 * @see Issue #1554 - WeChat Channel Dynamic Registration (Phase 1)
 */

import { describe, it, expect } from 'vitest';
import {
  REST_CHANNEL_DESCRIPTOR,
  FEISHU_CHANNEL_DESCRIPTOR,
  WECHAT_CHANNEL_DESCRIPTOR,
  BUILTIN_CHANNEL_DESCRIPTORS,
  getDefaultChannelRegistry,
} from './channel-descriptors.js';
import type { ChannelDescriptor } from '@disclaude/core';

describe('Channel Descriptors', () => {
  describe('REST_CHANNEL_DESCRIPTOR', () => {
    it('should have correct type and name', () => {
      expect(REST_CHANNEL_DESCRIPTOR.type).toBe('rest');
      expect(REST_CHANNEL_DESCRIPTOR.name).toBe('REST API');
    });

    it('should have correct capabilities', () => {
      const caps = REST_CHANNEL_DESCRIPTOR.defaultCapabilities;
      expect(caps.supportsCard).toBe(true);
      expect(caps.supportsThread).toBe(false);
      expect(caps.supportsFile).toBe(false);
      expect(caps.supportsMarkdown).toBe(true);
      expect(caps.supportsMention).toBe(false);
      expect(caps.supportsUpdate).toBe(false);
    });

    it('should support all MCP tools', () => {
      const tools = REST_CHANNEL_DESCRIPTOR.defaultCapabilities.supportedMcpTools;
      expect(tools).toEqual(['send_text', 'send_card', 'send_interactive', 'send_file']);
    });

    it('should have a factory function', () => {
      expect(typeof REST_CHANNEL_DESCRIPTOR.factory).toBe('function');
    });
  });

  describe('FEISHU_CHANNEL_DESCRIPTOR', () => {
    it('should have correct type and name', () => {
      expect(FEISHU_CHANNEL_DESCRIPTOR.type).toBe('feishu');
      expect(FEISHU_CHANNEL_DESCRIPTOR.name).toBe('Feishu');
    });

    it('should have full capabilities', () => {
      const caps = FEISHU_CHANNEL_DESCRIPTOR.defaultCapabilities;
      expect(caps.supportsCard).toBe(true);
      expect(caps.supportsThread).toBe(true);
      expect(caps.supportsFile).toBe(true);
      expect(caps.supportsMarkdown).toBe(true);
      expect(caps.supportsMention).toBe(true);
      expect(caps.supportsUpdate).toBe(true);
    });

    it('should support all MCP tools', () => {
      const tools = FEISHU_CHANNEL_DESCRIPTOR.defaultCapabilities.supportedMcpTools;
      expect(tools).toEqual(['send_text', 'send_card', 'send_interactive', 'send_file']);
    });
  });

  describe('WECHAT_CHANNEL_DESCRIPTOR', () => {
    it('should have correct type and name', () => {
      expect(WECHAT_CHANNEL_DESCRIPTOR.type).toBe('wechat');
      expect(WECHAT_CHANNEL_DESCRIPTOR.name).toBe('WeChat');
    });

    it('should have MVP-only capabilities', () => {
      const caps = WECHAT_CHANNEL_DESCRIPTOR.defaultCapabilities;
      expect(caps.supportsCard).toBe(false);
      expect(caps.supportsThread).toBe(false);
      expect(caps.supportsFile).toBe(false);
      expect(caps.supportsMarkdown).toBe(false);
      expect(caps.supportsMention).toBe(false);
      expect(caps.supportsUpdate).toBe(false);
    });

    it('should only support send_text MCP tool', () => {
      const tools = WECHAT_CHANNEL_DESCRIPTOR.defaultCapabilities.supportedMcpTools;
      expect(tools).toEqual(['send_text']);
    });

    it('should have a factory function', () => {
      expect(typeof WECHAT_CHANNEL_DESCRIPTOR.factory).toBe('function');
    });

    it('should create a WeChatChannel instance via factory', () => {
      const channel = WECHAT_CHANNEL_DESCRIPTOR.factory({ baseUrl: 'https://example.com' });
      expect(channel).toBeDefined();
      expect(channel.name).toBe('WeChat');
      // WeChatChannel extends BaseChannel which sets id from config or type
      expect(channel.id).toBe('wechat');
    });

    it('should create WeChatChannel with custom config', () => {
      const channel = WECHAT_CHANNEL_DESCRIPTOR.factory({
        id: 'my-wechat',
        baseUrl: 'https://custom.example.com',
        token: 'test-token',
        routeTag: 'test-route',
      });
      expect(channel.id).toBe('my-wechat');
    });
  });

  describe('BUILTIN_CHANNEL_DESCRIPTORS', () => {
    it('should contain all three built-in channels', () => {
      expect(BUILTIN_CHANNEL_DESCRIPTORS).toHaveLength(3);
    });

    it('should include rest, feishu, and wechat descriptors', () => {
      const types = BUILTIN_CHANNEL_DESCRIPTORS.map((d: ChannelDescriptor) => d.type);
      expect(types).toContain('rest');
      expect(types).toContain('feishu');
      expect(types).toContain('wechat');
    });

    it('should be a readonly array', () => {
      // TypeScript readonly assertion - at runtime it's still an array
      // but the type system prevents mutation
      expect(Array.isArray(BUILTIN_CHANNEL_DESCRIPTORS)).toBe(true);
    });
  });

  describe('getDefaultChannelRegistry()', () => {
    it('should return a ChannelRegistry with all built-in types', () => {
      const registry = getDefaultChannelRegistry();

      expect(registry.size).toBe(3);
      expect(registry.has('rest')).toBe(true);
      expect(registry.has('feishu')).toBe(true);
      expect(registry.has('wechat')).toBe(true);
    });

    it('should return a new instance each time', () => {
      const registry1 = getDefaultChannelRegistry();
      const registry2 = getDefaultChannelRegistry();

      // Different instances
      expect(registry1).not.toBe(registry2);
    });

    it('should create channels via registry', () => {
      const registry = getDefaultChannelRegistry();

      const wechatChannel = registry.create('wechat', { baseUrl: 'https://example.com' } as any);
      expect(wechatChannel).toBeDefined();
      expect(wechatChannel.name).toBe('WeChat');

      const restChannel = registry.create('rest', { port: 3000, host: 'localhost', fileStorageDir: '/tmp' } as any);
      expect(restChannel).toBeDefined();
      expect(restChannel.name).toBe('REST');
    });

    it('should throw for unregistered channel type', () => {
      const registry = getDefaultChannelRegistry();

      expect(() => {
        registry.create('nonexistent', {});
      }).toThrow('Channel type "nonexistent" is not registered');
    });
  });
});
