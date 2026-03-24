/**
 * Built-in Channel Descriptors.
 *
 * Provides ChannelDescriptor instances for all built-in channels (RestChannel,
 * FeishuChannel). These descriptors can be registered with ChannelRegistry
 * to enable configuration-driven dynamic channel creation.
 *
 * @module channels/channel-descriptors
 */

import type { ChannelDescriptor } from '@disclaude/core';
import { ChannelRegistry } from '@disclaude/core';
import { RestChannel, type RestChannelConfig } from './rest-channel.js';
import { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';
import { WeChatChannel, type WeChatChannelConfig } from './wechat/index.js';

/**
 * REST Channel descriptor.
 */
export const REST_CHANNEL_DESCRIPTOR: ChannelDescriptor<RestChannelConfig> = {
  type: 'rest',
  name: 'REST API',
  factory: (config: RestChannelConfig) => new RestChannel(config),
  defaultCapabilities: {
    supportsCard: true,
    supportsThread: false,
    supportsFile: false,
    supportsMarkdown: true,
    supportsMention: false,
    supportsUpdate: false,
    supportedMcpTools: ['send_text', 'send_card', 'send_interactive', 'send_file'],
  },
};

/**
 * Feishu Channel descriptor.
 */
export const FEISHU_CHANNEL_DESCRIPTOR: ChannelDescriptor<FeishuChannelConfig> = {
  type: 'feishu',
  name: 'Feishu',
  factory: (config: FeishuChannelConfig) => new FeishuChannel(config),
  defaultCapabilities: {
    supportsCard: true,
    supportsThread: true,
    supportsFile: true,
    supportsMarkdown: true,
    supportsMention: true,
    supportsUpdate: true,
    supportedMcpTools: ['send_text', 'send_card', 'send_interactive', 'send_file'],
  },
};

/**
 * WeChat Channel descriptor.
 *
 * MVP capabilities: only send_text is supported.
 * Future phases will extend with message listening, media handling, etc.
 *
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1554 - WeChat Channel Dynamic Registration (Phase 1)
 */
export const WECHAT_CHANNEL_DESCRIPTOR: ChannelDescriptor<WeChatChannelConfig> = {
  type: 'wechat',
  name: 'WeChat',
  factory: (config: WeChatChannelConfig) => new WeChatChannel(config),
  defaultCapabilities: {
    supportsCard: false,
    supportsThread: false,
    supportsFile: false,
    supportsMarkdown: false,
    supportsMention: false,
    supportsUpdate: false,
    supportedMcpTools: ['send_text'],
  },
};

/**
 * All built-in channel descriptors.
 *
 * Can be used to bulk-register all built-in channels:
 * ```typescript
 * const registry = new ChannelRegistry();
 * for (const descriptor of BUILTIN_CHANNEL_DESCRIPTORS) {
 *   registry.register(descriptor);
 * }
 * ```
 */
export const BUILTIN_CHANNEL_DESCRIPTORS: readonly ChannelDescriptor[] = [
  REST_CHANNEL_DESCRIPTOR,
  FEISHU_CHANNEL_DESCRIPTOR,
  WECHAT_CHANNEL_DESCRIPTOR,
] as const;

/**
 * Create a ChannelRegistry pre-populated with all built-in channel types.
 *
 * This is the recommended way to obtain a registry for channel creation:
 * ```typescript
 * const registry = getDefaultChannelRegistry();
 * const channel = registry.create('wechat', { baseUrl: '...', token: '...' });
 * ```
 *
 * @returns A ChannelRegistry with rest, feishu, and wechat descriptors registered
 */
export function getDefaultChannelRegistry(): ChannelRegistry {
  const registry = new ChannelRegistry();
  for (const descriptor of BUILTIN_CHANNEL_DESCRIPTORS) {
    registry.register(descriptor);
  }
  return registry;
}
