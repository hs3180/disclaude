/**
 * Channel Adapter interface for platform-agnostic channel configuration.
 *
 * Issue #1499: Decouple Feishu-specific logic from worker-node package.
 *
 * This interface provides a plugin mechanism for channels to inject
 * platform-specific behavior into the agent layer without the agent
 * layer needing to know about specific platforms.
 *
 * Each channel implementation (Feishu, WeChat, Slack, etc.) provides
 * its own ChannelAdapter that returns platform-specific MessageBuilderOptions.
 *
 * @module types/channel-adapter
 */

import type { MessageBuilderOptions } from '../agents/message-builder/types.js';

/**
 * Channel adapter interface for platform-specific agent configuration.
 *
 * Implementations provide channel-specific MessageBuilderOptions that
 * customize how the agent builds its prompt content for each platform.
 *
 * @example
 * ```typescript
 * // Feishu implementation
 * class FeishuChannelAdapter implements ChannelAdapter {
 *   createMessageBuilderOptions(): MessageBuilderOptions {
 *     return {
 *       buildHeader: (ctx) => 'You are responding in a Feishu chat.',
 *       buildPostHistory: (ctx) => buildFeishuMentionSection(ctx),
 *       buildToolsSection: (ctx) => buildFeishuToolsSection(ctx),
 *       buildAttachmentExtra: (ctx) => buildFeishuAttachmentExtra(ctx),
 *     };
 *   }
 * }
 *
 * // WeChat implementation
 * class WeChatChannelAdapter implements ChannelAdapter {
 *   createMessageBuilderOptions(): MessageBuilderOptions {
 *     return {
 *       buildHeader: (ctx) => 'You are responding in a WeChat chat.',
 *     };
 *   }
 * }
 * ```
 */
export interface ChannelAdapter {
  /**
   * Create MessageBuilderOptions for this channel.
   *
   * The returned options customize how the agent builds enhanced
   * prompt content, including platform-specific headers, mention
   * guidance, tool sections, and attachment handling.
   *
   * @returns MessageBuilderOptions with channel-specific callbacks
   */
  createMessageBuilderOptions(): MessageBuilderOptions;
}
