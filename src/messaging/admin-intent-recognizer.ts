/**
 * Admin Intent Recognizer - Recognizes user intent for admin mode management.
 *
 * This module provides intent recognition for Issue #347:
 * - Detect when user wants to enable admin mode
 * - Detect when user wants to disable admin mode
 *
 * @see Issue #347
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('AdminIntentRecognizer');

/**
 * Admin intent types.
 */
export enum AdminIntent {
  /** User wants to enable admin mode */
  ENABLE = 'enable',
  /** User wants to disable admin mode */
  DISABLE = 'disable',
  /** No admin-related intent detected */
  NONE = 'none',
}

/**
 * Result of intent recognition.
 */
export interface AdminIntentResult {
  /** Recognized intent */
  intent: AdminIntent;
  /** Confidence level (0-1) */
  confidence: number;
  /** Matched keywords */
  matchedKeywords: string[];
}

// Keywords for enabling admin mode
const ENABLE_KEYWORDS = [
  // Chinese
  '接收所有消息',
  '接收所有操作消息',
  '接收操作日志',
  '开启调试模式',
  '开启管理员模式',
  '开启详细日志',
  '我要看日志',
  '我要看详细执行过程',
  '显示详细信息',
  '开启详细模式',
  '成为管理员',
  // English
  'receive all messages',
  'enable admin mode',
  'enable debug mode',
  'show all logs',
  'show detailed logs',
  'verbose mode',
  'debug mode on',
  'i want to see logs',
  'receive operational messages',
];

// Keywords for disabling admin mode
const DISABLE_KEYWORDS = [
  // Chinese
  '停止接收操作消息',
  '停止接收消息',
  '关闭调试模式',
  '关闭管理员模式',
  '关闭详细日志',
  '不需要日志',
  '不需要详细日志',
  '退出管理员',
  // English
  'stop receiving messages',
  'disable admin mode',
  'disable debug mode',
  'hide logs',
  'no more logs',
  'turn off debug',
  'exit admin mode',
];

/**
 * Recognize admin intent from user message.
 *
 * @param message - User message
 * @returns Intent recognition result
 */
export function recognizeAdminIntent(message: string): AdminIntentResult {
  const normalizedMessage = message.toLowerCase().trim();

  // Check for enable keywords
  const enableMatches: string[] = [];
  for (const keyword of ENABLE_KEYWORDS) {
    if (normalizedMessage.includes(keyword.toLowerCase())) {
      enableMatches.push(keyword);
    }
  }

  // Check for disable keywords
  const disableMatches: string[] = [];
  for (const keyword of DISABLE_KEYWORDS) {
    if (normalizedMessage.includes(keyword.toLowerCase())) {
      disableMatches.push(keyword);
    }
  }

  // Determine intent based on matches
  if (enableMatches.length > 0 && disableMatches.length === 0) {
    const confidence = Math.min(0.5 + enableMatches.length * 0.15, 1.0);
    logger.debug({ message: message.substring(0, 50), intent: 'enable', confidence, matches: enableMatches });
    return {
      intent: AdminIntent.ENABLE,
      confidence,
      matchedKeywords: enableMatches,
    };
  }

  if (disableMatches.length > 0 && enableMatches.length === 0) {
    const confidence = Math.min(0.5 + disableMatches.length * 0.15, 1.0);
    logger.debug({ message: message.substring(0, 50), intent: 'disable', confidence, matches: disableMatches });
    return {
      intent: AdminIntent.DISABLE,
      confidence,
      matchedKeywords: disableMatches,
    };
  }

  // Both enable and disable keywords found, or none found
  if (enableMatches.length > 0 && disableMatches.length > 0) {
    logger.debug({ message: message.substring(0, 50) }, 'Conflicting keywords found, returning NONE');
  }

  return {
    intent: AdminIntent.NONE,
    confidence: 0,
    matchedKeywords: [],
  };
}

/**
 * Check if a message is likely an admin mode request.
 *
 * This is a quick check that can be used for filtering.
 *
 * @param message - User message
 * @returns true if the message might be an admin mode request
 */
export function isAdminModeRequest(message: string): boolean {
  const result = recognizeAdminIntent(message);
  return result.intent !== AdminIntent.NONE && result.confidence >= 0.5;
}
