/**
 * Feedback Command - Submit user feedback as GitHub Issue.
 *
 * This command triggers a feedback submission workflow:
 * 1. Receives user feedback content
 * 2. Checks for sensitive information patterns (regex only, no sanitization)
 * 3. Returns a prompt for the Agent to handle actual sanitization and issue creation
 *
 * Usage:
 *   /feedback 这个功能太难用了，每次都要点好几次
 *   /feedback  (analyzes recent conversation for potential issues)
 *
 * Issue #930: /feedback command for quick issue submission
 */

import type { Command, CommandContext, CommandResult } from '../types.js';

/**
 * Sensitive information patterns to check (NOT sanitize).
 * The Agent will handle actual sanitization via queryOnce.
 */
const SENSITIVE_PATTERNS = [
  { pattern: /ou_[a-f0-9]+/gi, name: 'User ID' },
  { pattern: /oc_[a-f0-9]+/gi, name: 'Chat ID' },
  { pattern: /cli-[a-f0-9]+/gi, name: 'Message ID' },
  { pattern: /[\w.-]+@[\w.-]+\.\w+/gi, name: 'Email' },
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, name: 'IP Address' },
  { pattern: /token[=:]\s*\S+/gi, name: 'Token' },
  { pattern: /api[_-]?key[=:]\s*\S+/gi, name: 'API Key' },
  { pattern: /password[=:]\s*\S+/gi, name: 'Password' },
  { pattern: /secret[=:]\s*\S+/gi, name: 'Secret' },
];

/**
 * Check text for sensitive information patterns.
 * Returns list of detected pattern names.
 */
function checkSensitiveInfo(text: string): string[] {
  const detected: string[] = [];
  for (const { pattern, name } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      detected.push(name);
    }
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
  }
  return detected;
}

/**
 * Feedback Command - Submit user feedback as GitHub Issue.
 *
 * This command follows the principle:
 * - Only use regex to CHECK for sensitive info (no sanitization)
 * - Let the Agent handle sanitization via queryOnce
 * - Return a prompt for the Agent to process
 */
export class FeedbackCommand implements Command {
  readonly name = 'feedback';
  readonly category = 'skill' as const;
  readonly description = '提交反馈给开发者';
  readonly usage = 'feedback [反馈内容]';

  execute(context: CommandContext): CommandResult {
    const { args, rawText, chatId } = context;

    // Extract feedback content from args or rawText
    const feedbackContent = args.length > 0
      ? rawText.replace(/^\/feedback\s+/i, '').trim()
      : '';

    // Check for sensitive information
    const sensitiveDetected = checkSensitiveInfo(feedbackContent);

    if (feedbackContent.length === 0) {
      // No feedback provided - ask user to describe their feedback
      return {
        success: true,
        message: `📢 **提交反馈**

请描述您遇到的问题或建议。

**用法:**
- \`/feedback <问题描述>\` - 直接描述您的反馈
- \`/feedback 这个功能太难用了，每次都要点好几次\`

我们将分析您的反馈，脱敏处理后提交到官方仓库。`,
      };
    }

    // Build the agent prompt for handling feedback
    let agentPrompt = `用户想要提交反馈给 disclaude 开发者。

**用户反馈内容:**
${feedbackContent}

**Chat ID:** ${chatId}

请执行以下操作:
1. 分析用户反馈，理解问题的核心
2. 对反馈内容进行脱敏处理（替换用户ID、聊天ID、邮箱、IP地址等敏感信息）
3. 使用 \`gh issue create\` 命令在 hs3180/disclaude 仓库创建 issue
   - 标题格式: \`[User Feedback] <简短描述>\`
   - 添加标签: \`user-feedback\`
4. 告诉用户 issue 已创建的链接`;

    if (sensitiveDetected.length > 0) {
      agentPrompt = `⚠️ **检测到可能的敏感信息**: ${sensitiveDetected.join(', ')}

请特别注意脱敏处理！

---

${agentPrompt}`;
    }

    // Return a prompt that the Agent will process
    return {
      success: true,
      message: `📢 **反馈提交中...**

${agentPrompt}`,
    };
  }
}
