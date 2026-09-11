/**
 * Channels module - Communication channel abstractions.
 *
 * This module provides a unified interface for different messaging platforms.
 * Each channel implements the IChannel interface, allowing the PrimaryNode
 * to work with any platform.
 *
 * @module channels
 */
export { DEFAULT_CHANNEL_CAPABILITIES } from "../../../core/dist/index.js";
// Base class
export { BaseChannel } from "../../../core/dist/index.js";
// REST Channel (Issue #1040)
export { RestChannel } from './rest-channel.js';
// Feishu Channel (Issue #1040 - migrated from src/channels)
export { FeishuChannel } from './feishu-channel.js';
// WeChat Channel (Issue #1473 - MVP: Auth + Send Message)
export { WeChatChannel } from './wechat/index.js';
// Wired Channel Descriptors (Issue #1594 Phase 2)
export { REST_WIRED_DESCRIPTOR, FEISHU_WIRED_DESCRIPTOR, } from './wired-descriptors.js';
