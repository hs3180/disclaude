/**
 * Tests for Built-in Channel Descriptors.
 *
 * Tests that all built-in channel descriptors are properly defined
 * and can be used with ChannelRegistry.
 *
 * @see Issue #1553 - ChannelRegistry Infrastructure
 * @see Issue #1554 - WeChat Channel Dynamic Registration
 */

import { describe, it, expect } from 'vitest';
import { ChannelRegistry } from '@disclaude/core';
import {
  REST_CHANNEL_DESCRIPTOR,
  FEISHU_CHANNEL_DESCRIPTOR,
  WECHAT_CHANNEL_DESCRIPTOR,
  BUILTIN_CHANNEL_DESCRIPTORS,
} from './channel-descriptors.js';

describe('Built-in Channel Descriptors', () => {
  describe('REST_CHANNEL_DESCRIPTOR', () => {
    it('should have correct type and name', () => {
      expect(REST_CHANNEL_DESCRIPTOR.type).toBe('rest');
      expect(REST_CHANNEL_DESCRIPTOR.name).toBe('REST API');
    });

    it('should have a factory function', () => {
      expect(typeof REST_CHANNEL_DESCRIPTOR.factory).toBe('function');
    });

    it('should define default capabilities', () => {
      const caps = REST_CHANNEL_DESCRIPTOR.defaultCapabilities;
      expect(caps.supportsCard).toBe(true);
      expect(caps.supportsMarkdown).toBe(true);
      expect(caps.supportsFile).toBe(false);
      expect(caps.supportedMcpTools).toContain('send_text');
      expect(caps.supportedMcpTools).toContain('send_card');
      expect(caps.supportedMcpTools).toContain('send_interactive');
      expect(caps.supportedMcpTools).toContain('send_file');
    });
  });

  describe('FEISHU_CHANNEL_DESCRIPTOR', () => {
    it('should have correct type and name', () => {
      expect(FEISHU_CHANNEL_DESCRIPTOR.type).toBe('feishu');
      expect(FEISHU_CHANNEL_DESCRIPTOR.name).toBe('Feishu');
    });

    it('should have a factory function', () => {
      expect(typeof FEISHU_CHANNEL_DESCRIPTOR.factory).toBe('function');
    });

    it('should define full capabilities', () => {
      const caps = FEISHU_CHANNEL_DESCRIPTOR.defaultCapabilities;
      expect(caps.supportsCard).toBe(true);
      expect(caps.supportsThread).toBe(true);
      expect(caps.supportsFile).toBe(true);
      expect(caps.supportsMarkdown).toBe(true);
      expect(caps.supportsMention).toBe(true);
      expect(caps.supportsUpdate).toBe(true);
      expect(caps.supportedMcpTools).toContain('send_text');
      expect(caps.supportedMcpTools).toContain('send_card');
    });
  });

  describe('WECHAT_CHANNEL_DESCRIPTOR', () => {
    it('should have correct type and name', () => {
      expect(WECHAT_CHANNEL_DESCRIPTOR.type).toBe('wechat');
      expect(WECHAT_CHANNEL_DESCRIPTOR.name).toBe('WeChat');
    });

    it('should have a factory function', () => {
      expect(typeof WECHAT_CHANNEL_DESCRIPTOR.factory).toBe('function');
    });

    it('should define MVP-only capabilities', () => {
      const caps = WECHAT_CHANNEL_DESCRIPTOR.defaultCapabilities;
      // WeChat MVP only supports text
      expect(caps.supportsCard).toBe(false);
      expect(caps.supportsThread).toBe(false);
      expect(caps.supportsFile).toBe(false);
      expect(caps.supportsMarkdown).toBe(false);
      expect(caps.supportsMention).toBe(false);
      expect(caps.supportsUpdate).toBe(false);
      expect(caps.supportedMcpTools).toEqual(['send_text']);
    });

    it('should create a WeChatChannel via factory', () => {
      const channel = WECHAT_CHANNEL_DESCRIPTOR.factory({});
      expect(channel).toBeDefined();
      expect(channel.id).toContain('wechat');
      expect(channel.name).toBe('WeChat');
    });

    it('should create a WeChatChannel with custom config', () => {
      const channel = WECHAT_CHANNEL_DESCRIPTOR.factory({
        baseUrl: 'https://custom.api.example.com',
        token: 'test-token',
        routeTag: 'test-route',
      });
      expect(channel).toBeDefined();
      expect(channel.name).toBe('WeChat');
    });
  });

  describe('BUILTIN_CHANNEL_DESCRIPTORS', () => {
    it('should include all three built-in channels', () => {
      const types = BUILTIN_CHANNEL_DESCRIPTORS.map(d => d.type);
      expect(types).toContain('rest');
      expect(types).toContain('feishu');
      expect(types).toContain('wechat');
    });

    it('should have exactly 3 descriptors', () => {
      expect(BUILTIN_CHANNEL_DESCRIPTORS).toHaveLength(3);
    });

    it('should register all descriptors without conflicts', () => {
      const registry = new ChannelRegistry();
      for (const descriptor of BUILTIN_CHANNEL_DESCRIPTORS) {
        registry.register(descriptor);
      }
      expect(registry.has('rest')).toBe(true);
      expect(registry.has('feishu')).toBe(true);
      expect(registry.has('wechat')).toBe(true);
      expect(registry.getAll()).toHaveLength(3);
    });

    it('should allow creating channels from registry by type', () => {
      const registry = new ChannelRegistry();
      for (const descriptor of BUILTIN_CHANNEL_DESCRIPTORS) {
        registry.register(descriptor);
      }

      // Should be able to create each channel type
      const restChannel = registry.create('rest', { port: 3000 } as any);
      expect(restChannel).toBeDefined();
      expect(restChannel.name).toBe('REST');

      const feishuChannel = registry.create('feishu', { appId: 'test', appSecret: 'test' } as any);
      expect(feishuChannel).toBeDefined();
      expect(feishuChannel.name).toBe('Feishu');

      const wechatChannel = registry.create('wechat', {});
      expect(wechatChannel).toBeDefined();
      expect(wechatChannel.name).toBe('WeChat');
    });

    it('should provide correct capabilities per type', () => {
      const registry = new ChannelRegistry();
      for (const descriptor of BUILTIN_CHANNEL_DESCRIPTORS) {
        registry.register(descriptor);
      }

      const wechatCaps = registry.getCapabilities('wechat');
      expect(wechatCaps.supportedMcpTools).toEqual(['send_text']);
      expect(wechatCaps.supportsCard).toBe(false);

      const feishuCaps = registry.getCapabilities('feishu');
      expect(feishuCaps.supportsCard).toBe(true);
      expect(feishuCaps.supportsThread).toBe(true);
    });
  });
});
