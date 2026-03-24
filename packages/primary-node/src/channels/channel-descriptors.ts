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
import { RestChannel, type RestChannelConfig } from './rest-channel.js';
import { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';

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
] as const;
