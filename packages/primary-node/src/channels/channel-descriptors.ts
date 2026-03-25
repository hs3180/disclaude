/**
 * Built-in Channel Descriptors (basic, without wiring hooks).
 *
 * @deprecated Use `WiredChannelDescriptor` from `wired-descriptors.ts` instead.
 * These basic descriptors lack the wiring hooks (createCallbacks, createMessageHandler,
 * setup) required by `ChannelLifecycleManager.createAndWireByType()`.
 *
 * Issue #1594 Phase 3: Production code uses `BUILTIN_WIRED_DESCRIPTORS` for
 * config-driven channel creation. These basic descriptors are kept for backward
 * compatibility and for use with `ChannelRegistry` (type catalog only, no wiring).
 *
 * @module channels/channel-descriptors
 */

import type { ChannelDescriptor } from '@disclaude/core';
import { RestChannel, type RestChannelConfig } from './rest-channel.js';
import { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';
import { WeChatChannel, type WeChatChannelConfig } from './wechat/index.js';

/**
 * REST Channel descriptor.
 */
export const REST_CHANNEL_DESCRIPTOR: ChannelDescriptor<RestChannelConfig> = {
  type: 'rest',
  name: 'REST API',
  factory: (config) => new RestChannel(config),
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
  factory: (config) => new FeishuChannel(config),
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
 */
export const WECHAT_CHANNEL_DESCRIPTOR: ChannelDescriptor<WeChatChannelConfig> = {
  type: 'wechat',
  name: 'WeChat',
  factory: (config) => new WeChatChannel(config),
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
 * All built-in channel descriptors for bulk registration.
 *
 * @example
 * ```typescript
 * import { ChannelRegistry } from '@disclaude/core';
 * import { BUILTIN_CHANNEL_DESCRIPTORS } from '../channels/channel-descriptors.js';
 *
 * const registry = new ChannelRegistry();
 * for (const descriptor of BUILTIN_CHANNEL_DESCRIPTORS) {
 *   registry.register(descriptor);
 * }
 * ```
 */
export const BUILTIN_CHANNEL_DESCRIPTORS: ChannelDescriptor[] = [
  REST_CHANNEL_DESCRIPTOR,
  FEISHU_CHANNEL_DESCRIPTOR,
  WECHAT_CHANNEL_DESCRIPTOR,
];
