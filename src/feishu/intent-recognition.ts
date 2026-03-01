/**
 * IntentRecognition - Simple intent recognition service.
 *
 * Uses keyword matching to detect user intents from messages.
 * This is a lightweight alternative to LLM-based intent recognition.
 *
 * @see Issue #347 - Dynamic admin mode setup
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('IntentRecognition');

/**
 * Recognized intents.
 */
export enum Intent {
  /** User wants to enable admin mode */
  ENABLE_ADMIN = 'enable_admin',
  /** User wants to disable admin mode */
  DISABLE_ADMIN = 'disable_admin',
  /** User is asking a question */
  QUESTION = 'question',
  /** User is giving a command */
  COMMAND = 'command',
  /** No specific intent detected */
  UNKNOWN = 'unknown',
}

/**
 * Intent recognition result.
 */
export interface IntentResult {
  /** Recognized intent */
  intent: Intent;
  /** Confidence level (0-1) */
  confidence: number;
  /** Extracted entities (if any) */
  entities?: Record<string, string>;
}

/**
 * Intent recognition patterns.
 *
 * IMPORTANT: Order matters! More specific patterns should come first.
 * DISABLE_ADMIN patterns must be checked before ENABLE_ADMIN patterns
 * to avoid false matches (e.g., "exit admin mode" matching "admin mode").
 */
const INTENT_PATTERNS: {
  intent: Intent;
  patterns: RegExp[];
  confidence: number;
}[] = [
  // DISABLE_ADMIN must come first (more specific patterns)
  {
    intent: Intent.DISABLE_ADMIN,
    patterns: [
      /关闭.*管理员/i,
      /禁用.*管理员/i,
      /退出.*管理员/i,
      /退出.*管理模式/i,
      /disable.*admin/i,
      /stop.*admin/i,
      /exit.*admin/i,
      /end.*admin/i,
      /关闭管理员模式/i,
      /退出管理员模式/i,
    ],
    confidence: 0.9,
  },
  // ENABLE_ADMIN patterns (checked after DISABLE_ADMIN)
  {
    intent: Intent.ENABLE_ADMIN,
    patterns: [
      /开启.*管理员/i,
      /启用.*管理员/i,
      /打开.*管理员/i,
      /进入.*管理员/i,
      /enable.*admin/i,
      /start.*admin/i,
      /开启管理员模式/i,
      /^管理员模式$/i, // Exact match only to avoid conflicts
    ],
    confidence: 0.9,
  },
  {
    intent: Intent.QUESTION,
    patterns: [
      /\?$/,
      /？$/,
      /^(what|how|why|when|where|who|which)/i,
      /^(什么|怎么|为什么|何时|哪里|谁|哪个)/,
    ],
    confidence: 0.6,
  },
  {
    intent: Intent.COMMAND,
    patterns: [
      /^(please|请)/i,
      /^(run|execute|do|make|create|delete|remove|update)/i,
      /^(运行|执行|做|创建|删除|移除|更新)/,
    ],
    confidence: 0.7,
  },
];

/**
 * Recognize intent from message text.
 *
 * @param text - Message text to analyze
 * @returns Intent recognition result
 */
export function recognizeIntent(text: string): IntentResult {
  const trimmedText = text.trim();

  if (!trimmedText) {
    return { intent: Intent.UNKNOWN, confidence: 1.0 };
  }

  // Special handling for question patterns that might conflict with action patterns
  // e.g., "如何开启管理员" should be a question, not an enable action
  if (/^(how\s+to|如何|怎样)/i.test(trimmedText)) {
    return { intent: Intent.QUESTION, confidence: 0.8 };
  }

  // Check each intent pattern
  for (const { intent, patterns, confidence } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(trimmedText)) {
        logger.debug({ intent, text: trimmedText.substring(0, 50) }, 'Intent recognized');
        return { intent, confidence };
      }
    }
  }

  // No pattern matched
  return { intent: Intent.UNKNOWN, confidence: 0.5 };
}

/**
 * Check if message indicates admin mode intent.
 *
 * @param text - Message text to check
 * @returns True if message indicates admin mode intent
 */
export function isAdminModeIntent(text: string): boolean {
  const result = recognizeIntent(text);
  return result.intent === Intent.ENABLE_ADMIN || result.intent === Intent.DISABLE_ADMIN;
}

/**
 * Check if message indicates enable admin mode.
 *
 * @param text - Message text to check
 * @returns True if message indicates enabling admin mode
 */
export function isEnableAdminIntent(text: string): boolean {
  const result = recognizeIntent(text);
  return result.intent === Intent.ENABLE_ADMIN;
}

/**
 * Check if message indicates disable admin mode.
 *
 * @param text - Message text to check
 * @returns True if message indicates disabling admin mode
 */
export function isDisableAdminIntent(text: string): boolean {
  const result = recognizeIntent(text);
  return result.intent === Intent.DISABLE_ADMIN;
}
