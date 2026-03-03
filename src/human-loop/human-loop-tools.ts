/**
 * Human-in-the-Loop MCP Tools for Issue #532.
 *
 * Provides tools for:
 * - Creating discussion chats
 * - Asking experts for help
 * - @ mentioning users
 *
 * @see Issue #538 - Credit system integration for ask_expert
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import { createFeishuClient } from '../platforms/feishu/create-feishu-client.js';
import { createDiscussionChat } from '../platforms/feishu/chat-ops.js';
import { getExpertRegistry } from './expert-registry.js';
import { getCreditManager } from './credit-manager.js';
import type {
  CreateDiscussionOptions,
  CreateDiscussionResult,
  AskExpertOptions,
  AskExpertResult,
  InteractionButton,
} from './types.js';

const logger = createLogger('HumanLoopTools');

/**
 * Format @mention for Feishu messages.
 *
 * @param openId - User's open_id
 * @returns Formatted mention string
 */
export function formatMention(openId: string): string {
  return `<at user_id="${openId}"></at>`;
}

/**
 * Create a discussion chat and optionally send an initial message.
 *
 * @param options - Discussion creation options
 * @returns Result with chat ID
 */
export async function create_discussion(options: CreateDiscussionOptions): Promise<CreateDiscussionResult> {
  const { topic, members, initialMessage } = options;

  logger.info({ topic, memberCount: members.length }, 'Creating discussion chat');

  try {
    // Get Feishu client
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      return {
        success: false,
        error: 'FEISHU_APP_ID and FEISHU_APP_SECRET must be configured',
      };
    }

    const client = createFeishuClient(appId, appSecret, {
      domain: lark.Domain.Feishu,
    });

    // Create the chat
    const chatId = await createDiscussionChat(client, { topic, members });

    logger.info({ chatId, topic }, 'Discussion chat created');

    // Send initial message if provided
    if (initialMessage) {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: initialMessage }),
        },
      });
      logger.debug({ chatId }, 'Initial message sent');
    }

    return {
      success: true,
      chatId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, topic }, 'Failed to create discussion');
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Ask an expert for help.
 *
 * Finds an expert with the required skill, creates a discussion chat,
 * and sends a question card with interaction buttons.
 *
 * Credit System (Issue #538):
 * - If agentId is provided, checks and deducts credits
 * - Expert's price determines the credit cost
 * - Fails if insufficient balance or daily limit exceeded
 *
 * @param options - Ask expert options
 * @returns Result with chat ID and expert info
 */
export async function ask_expert(options: AskExpertOptions & { agentId?: string }): Promise<AskExpertResult> {
  const { skill, minLevel = 1, question, context, chatId: existingChatId, agentId } = options;

  logger.info({ skill, minLevel, agentId }, 'Looking for expert');

  try {
    // Find expert
    const registry = getExpertRegistry();
    const expert = await registry.findBestMatch(skill, minLevel);

    if (!expert) {
      return {
        success: false,
        error: `No expert found with skill "${skill}" at level ${minLevel} or higher`,
      };
    }

    logger.info({ expertName: expert.name, skill }, 'Expert found');

    // Get expert's price
    const expertPrice = await registry.getPrice(expert.open_id);

    // Credit check and deduction (Issue #538)
    if (agentId && expertPrice > 0) {
      const creditManager = getCreditManager();

      // Check eligibility
      const eligibility = await creditManager.checkConsultationEligibility(agentId, expert.open_id);

      if (!eligibility.allowed) {
        const reasonMessages: Record<string, string> = {
          account_not_found: `积分账户不存在。请联系管理员创建账户: /budget recharge ${agentId} <积分>`,
          insufficient_balance: `积分不足。当前余额: ${eligibility.balance}, 需要: ${eligibility.expertPrice}`,
          daily_limit_exceeded: `已达每日上限。今日剩余: ${eligibility.dailyRemaining}, 需要: ${eligibility.expertPrice}`,
        };
        return {
          success: false,
          error: reasonMessages[eligibility.reason!] || '无法完成咨询',
        };
      }

      // Deduct credits
      const chargeResult = await creditManager.chargeConsultation(
        agentId,
        expert.open_id,
        `咨询技能: ${skill}`
      );

      if (!chargeResult.success) {
        return {
          success: false,
          error: chargeResult.error || '积分扣除失败',
        };
      }

      logger.info(
        { agentId, expertId: expert.open_id, price: expertPrice, newBalance: chargeResult.newBalance },
        'Credits deducted for consultation'
      );
    }

    // Get Feishu client
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      return {
        success: false,
        error: 'FEISHU_APP_ID and FEISHU_APP_SECRET must be configured',
      };
    }

    const client = createFeishuClient(appId, appSecret, {
      domain: lark.Domain.Feishu,
    });

    // Use existing chat or create new one
    let chatId = existingChatId;

    if (!chatId) {
      // Create discussion chat with the expert
      chatId = await createDiscussionChat(client, {
        topic: `专家咨询: ${skill}`,
        members: [expert.open_id],
      });
      logger.info({ chatId, expertName: expert.name }, 'Discussion chat created');
    }

    // Build question message with @mention
    const mention = formatMention(expert.open_id);
    const contextText = context ? `\n\n**背景信息:**\n${context}` : '';
    const priceText = expertPrice > 0 ? `\n\n💰 本次咨询消耗 ${expertPrice} 积分` : '';

    const messageText = `${mention} 你好！我需要你的帮助。\n\n**技能需求:** ${skill}\n**问题:**\n${question}${contextText}${priceText}`;

    // Send the question as text
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: messageText }),
      },
    });

    logger.info({ chatId, expertName: expert.name }, 'Question sent to expert');

    return {
      success: true,
      chatId,
      expert: {
        name: expert.name,
        open_id: expert.open_id,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, skill }, 'Failed to ask expert');
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Build an interactive card with prompt-based buttons.
 *
 * Each button has an associated prompt template that will be injected
 * into the conversation when the user clicks it.
 *
 * @param title - Card title
 * @param content - Card content (markdown)
 * @param buttons - Buttons with prompt templates
 * @returns Feishu card object
 */
export function buildInteractionCard(
  title: string,
  content: string,
  buttons: InteractionButton[]
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
      {
        tag: 'action',
        actions: buttons.map(btn => ({
          tag: 'button',
          text: { tag: 'plain_text', content: btn.label },
          type: 'primary',
          value: {
            action: btn.value,
            prompt: btn.promptTemplate,
          },
        })),
      },
    ],
  };
}

/**
 * Tool definitions for MCP integration.
 */
import { z } from 'zod';
import type { InlineToolDefinition } from '../sdk/index.js';
import { getProvider } from '../sdk/index.js';

/**
 * Helper to create a successful tool result.
 */
function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Human-in-the-Loop MCP tool definitions.
 */
export const humanLoopToolDefinitions: InlineToolDefinition[] = [
  {
    name: 'create_discussion',
    description: `Create a discussion group chat with specified members.

**Use Cases:**
- Create a focused discussion group for a specific topic
- Bring together experts and stakeholders
- Start a new conversation thread

**Features:**
- Creates a new Feishu group chat
- Adds specified members by their open_ids
- Optionally sends an initial message
- Returns the chat ID for follow-up messages

**Note:** Member open_ids must be valid Feishu user IDs (format: ou_xxxx).`,
    parameters: z.object({
      topic: z.string().describe('Chat topic/name (will be shown as group name)'),
      members: z.array(z.string()).describe('Array of member open_ids to invite'),
      initialMessage: z.string().optional().describe('Optional initial message to send to the chat'),
    }),
    handler: async ({ topic, members, initialMessage }) => {
      try {
        const result = await create_discussion({ topic, members, initialMessage });
        if (result.success) {
          return toolSuccess(`✅ Discussion created\nChat ID: ${result.chatId}`);
        } else {
          return toolSuccess(`⚠️ Failed to create discussion: ${result.error}`);
        }
      } catch (error) {
        return toolSuccess(`⚠️ Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'ask_expert',
    description: `Find and ask a human expert for help.

**How it works:**
1. Searches the expert registry for someone with the required skill
2. Checks credit balance if agentId provided and expert has a price
3. Creates a discussion chat (or uses existing one)
4. Sends a question with @mention to the expert

**Credit System (Issue #538):**
- If agentId is provided and expert has a price set, credits will be deducted
- Consultation fails if insufficient balance or daily limit exceeded
- Use /budget commands to manage credits

**Expert Registry:**
Experts are configured in \`workspace/experts.yaml\`. Each expert has:
- open_id: Their Feishu user ID
- name: Display name
- skills: Array of {name, level (1-5)}
- price (optional): Consultation price in credits

**Skill Matching:**
- Skill name uses partial, case-insensitive matching
- minLevel filters experts by minimum skill level

**Example:**
\`\`\`
skill: "React"
minLevel: 3
question: "Can you review this component design?"
context: "We're building a dashboard with real-time updates..."
agentId: "agent_001"  // Optional: for credit deduction
\`\`\``,
    parameters: z.object({
      skill: z.string().describe('Skill name to search for (e.g., "React", "TypeScript")'),
      minLevel: z.number().min(1).max(5).optional().describe('Minimum skill level required (1-5, default: 1)'),
      question: z.string().describe('Question or request for the expert'),
      context: z.string().optional().describe('Optional context information to help the expert understand the situation'),
      chatId: z.string().optional().describe('Optional existing chat ID to use instead of creating new one'),
      agentId: z.string().optional().describe('Optional agent ID for credit deduction (if expert has a price)'),
    }),
    handler: async ({ skill, minLevel, question, context, chatId, agentId }) => {
      try {
        const result = await ask_expert({ skill, minLevel, question, context, chatId, agentId });
        if (result.success) {
          return toolSuccess(
            `✅ Expert contacted\n` +
            `Expert: ${result.expert?.name}\n` +
            `Chat ID: ${result.chatId}`
          );
        } else {
          return toolSuccess(`⚠️ Failed to find expert: ${result.error}`);
        }
      } catch (error) {
        return toolSuccess(`⚠️ Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
  {
    name: 'mention_user',
    description: `Format a @mention for a Feishu user.

**Usage:**
Use this to @mention specific users in your messages.

**Format:**
Returns \`<at user_id="open_id"></at>\` which Feishu renders as a clickable mention.

**Example:**
\`\`\`
const mention = mention_user({ openId: "ou_xxxx" });
// Use in message: \`\${mention} 请查看这个问题\`
\`\`\``,
    parameters: z.object({
      openId: z.string().describe("User's Feishu open_id (format: ou_xxxx)"),
    }),
    handler: async ({ openId }) => {
      const mention = formatMention(openId);
      return toolSuccess(`Mention format: ${mention}`);
    },
  },
];

/**
 * Get SDK-compatible tool instances.
 *
 * @deprecated Use humanLoopToolDefinitions with getProvider().createMcpServer() instead.
 */
export const humanLoopSdkTools = humanLoopToolDefinitions.map(def => getProvider().createInlineTool(def));
