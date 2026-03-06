/**
 * Feedback Command - Submit user feedback as GitHub Issue.
 *
 * Analyzes user complaints/feedback, sanitizes sensitive data,
 * and creates a GitHub issue in the official repository.
 *
 * Usage:
 *   /feedback 这个功能太难用了，每次都要点好几次
 *   /feedback  (analyzes recent conversation for potential issues)
 *
 * Issue #930: /feedback command for quick issue submission
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Command, CommandContext, CommandResult } from '../types.js';

const execAsync = promisify(exec);

/**
 * Sanitization rules for removing sensitive data.
 */
const SANITIZATION_RULES = [
  { pattern: /ou_[a-f0-9]+/gi, replacement: '[USER_ID]' },
  { pattern: /oc_[a-f0-9]+/gi, replacement: '[CHAT_ID]' },
  { pattern: /cli-[a-f0-9]+/gi, replacement: '[MESSAGE_ID]' },
  { pattern: /[\w.-]+@[\w.-]+\.\w+/gi, replacement: '[EMAIL]' },
  { pattern: /\/[^\s"'`]+\.(ts|js|json|md)/gi, replacement: '[FILE]' },
  { pattern: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi, replacement: '[URL]' },
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP]' },
  { pattern: /token[=:]\s*\S+/gi, replacement: 'token=[TOKEN]' },
  { pattern: /api[_-]?key[=:]\s*\S+/gi, replacement: 'api_key=[API_KEY]' },
  { pattern: /password[=:]\s*\S+/gi, replacement: 'password=[PASSWORD]' },
  { pattern: /secret[=:]\s*\S+/gi, replacement: 'secret=[SECRET]' },
];

/**
 * Sanitize text by replacing sensitive patterns.
 */
function sanitize(text: string): string {
  let result = text;
  for (const rule of SANITIZATION_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/**
 * Extract key issues from conversation history.
 */
function analyzeConversation(history: string): string {
  // Look for error messages, complaints, or problem indicators
  const errorPatterns = [
    /error[:：]\s*.+/gi,
    /失败[:：]\s*.+/gi,
    /不行[:：]\s*.+/gi,
    /问题[:：]\s*.+/gi,
    /bug[:：]\s*.+/gi,
    /无法\s*.+/gi,
    /不能\s*.+/gi,
    /不对[:：]\s*.+/gi,
    /不满意.*/gi,
    /太.+(了|难)/gi,
  ];

  const issues: string[] = [];
  for (const pattern of errorPatterns) {
    const matches = history.match(pattern);
    if (matches) {
      issues.push(...matches);
    }
  }

  if (issues.length > 0) {
    return issues.slice(0, 5).join('\n');
  }

  return '(未检测到明确问题，请手动描述)';
}

/**
 * Create a GitHub issue using gh CLI.
 */
async function createGitHubIssue(title: string, body: string): Promise<{ success: boolean; url?: string; error?: string }> {
  const repo = 'hs3180/disclaude';

  // Escape title and body for shell
  const escapedTitle = title.replace(/"/g, '\\"');
  const escapedBody = body.replace(/"/g, '\\"');

  try {
    const { stdout } = await execAsync(
      `gh issue create --repo ${repo} --title "${escapedTitle}" --body "${escapedBody}" --label "user-feedback"`,
      { timeout: 30000 }
    );

    const url = stdout.trim();
    return { success: true, url };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Feedback Command - Submit user feedback as GitHub Issue.
 */
export class FeedbackCommand implements Command {
  readonly name = 'feedback';
  readonly category = 'feedback' as const;
  readonly description = '提交反馈给开发者';
  readonly usage = 'feedback [反馈内容]';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { args, chatId, services } = context;

    // Get user feedback from args or analyze conversation history
    let feedbackContent: string;
    let isAutoAnalysis = false;

    if (args.length > 0) {
      // User provided explicit feedback
      feedbackContent = args.join(' ');
    } else {
      // Auto-analyze recent conversation
      isAutoAnalysis = true;
      const history = services.getFormattedHistory(chatId, 20);
      feedbackContent = analyzeConversation(history);

      if (feedbackContent === '(未检测到明确问题，请手动描述)') {
        return {
          success: false,
          error: '未能自动检测到问题。请使用 `/feedback <问题描述>` 直接描述您的反馈。',
        };
      }
    }

    // Sanitize feedback content
    const sanitizedFeedback = sanitize(feedbackContent);

    // Get recent conversation history for context
    const history = services.getFormattedHistory(chatId, 10);
    const sanitizedHistory = sanitize(history);

    // Build issue body
    const issueTitle = `[User Feedback] ${sanitizedFeedback.slice(0, 50)}${sanitizedFeedback.length > 50 ? '...' : ''}`;

    const issueBody = `## User Feedback

${isAutoAnalysis ? '_自动分析检测到的问题_' : '_用户直接反馈_'}

### Description
${sanitizedFeedback}

### Interaction Summary
\`\`\`
${sanitizedHistory}
\`\`\`

---
_Issue created via /feedback command_
_Chat ID: ${chatId.slice(0, 8)}..._
_Time: ${new Date().toISOString()}_`;

    // Create GitHub issue
    const result = await createGitHubIssue(issueTitle, issueBody);

    if (result.success) {
      return {
        success: true,
        message: `✅ **反馈已提交**\n\n感谢您的反馈！我们已收到并会尽快处理。\n\n🔗 Issue: ${result.url}`,
      };
    } else {
      return {
        success: false,
        error: `提交反馈失败: ${result.error}\n\n您也可以直接访问 https://github.com/hs3180/disclaude/issues 提交反馈。`,
      };
    }
  }
}
