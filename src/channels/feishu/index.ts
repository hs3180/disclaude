/**
 * Feishu Channel Modules.
 *
 * Exports modular components for Feishu channel implementation.
 */

export { PassiveModeManager } from './passive-mode.js';
export { MentionDetector, type BotInfo } from './mention-detector.js';
export { WelcomeHandler } from './welcome-handler.js';
export {
  extractOpenId,
  isGroupChat,
  parseTextContent,
  getChatHistoryContext,
  parseMessageEvent,
  type ParsedMessageEvent,
} from './message-handler.js';
export type {
  FeishuChannelConfig,
  FilterResult,
  MessageContext,
} from './types.js';
