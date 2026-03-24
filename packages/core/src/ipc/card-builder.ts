/**
 * Card building utilities for interactive cards.
 *
 * Originally moved from mcp-server/tools/ask-user.ts as part of Issue #1570
 * (Phase 1: MCP Tool 轻量化 — 移除卡片构建逻辑).
 *
 * Since Issue #1571 (Phase 2), these functions are consumed by the Primary Node's
 * FeishuChannel.buildInteractiveCard() method, which owns the full card building
 * lifecycle. The IPC server no longer calls these functions directly — it delegates
 * to the Primary Node via FeishuApiHandlers.sendInteractive().
 *
 * @module core/ipc/card-builder
 */

/**
 * Serializable option for ask_user / sendInteractive.
 * This is the IPC-safe version of AskUserOptions from mcp-server.
 */
export interface AskUserOption {
  /** Display text for the option (shown on button) */
  text: string;
  /** Value returned when this option is selected */
  value?: string;
  /** Visual style of the button */
  style?: 'primary' | 'default' | 'danger';
  /** Action description for the agent to execute when selected */
  action?: string;
}

/**
 * Build a Feishu card structure for a question with options.
 *
 * @param question - The question to display in the card
 * @param options - Array of options to present as buttons
 * @param title - Optional card title (default: "🤖 Agent 提问")
 * @returns Feishu card JSON structure
 */
export function buildQuestionCard(
  question: string,
  options: AskUserOption[],
  title?: string
): Record<string, unknown> {
  const buttons = options.map((opt, index) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: opt.text },
    value: opt.value || `option_${index}`,
    type: opt.style === 'danger' ? 'danger' :
          opt.style === 'primary' ? 'primary' : 'default',
  }));

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title || '🤖 Agent 提问' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content: question,
      },
      {
        tag: 'action',
        actions: buttons,
      },
    ],
  };
}

/**
 * Build action prompts from options.
 *
 * Each prompt includes context about what action to take when the user
 * selects that option. This enables the agent to continue execution
 * based on the user's choice.
 *
 * @param options - Array of options to generate prompts for
 * @param context - Optional context information to include in prompts
 * @returns Map of action values to prompt templates
 */
export function buildActionPrompts(
  options: AskUserOption[],
  context?: string
): Record<string, string> {
  const prompts: Record<string, string> = {};

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const value = opt.value || `option_${i}`;
    const contextPart = context ? `\n\n**上下文**: ${context}` : '';
    const actionPart = opt.action
      ? `\n\n**请执行**: ${opt.action}`
      : '';

    prompts[value] = `[用户操作] 用户选择了「${opt.text}」选项。${contextPart}${actionPart}`;
  }

  return prompts;
}
