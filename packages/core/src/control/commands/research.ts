/**
 * /research command handler.
 *
 * Provides research mode control:
 * - `/research <topic>` — Enter research mode for the given topic
 * - `/research exit` — Exit research mode and return to normal mode
 * - `/research status` — Show current research mode status
 *
 * Issue #1709 - Research Mode Phase 1.
 *
 * @module control/commands/research
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * Handle /research command.
 *
 * Sub-commands:
 * - `/research <topic>` — Enter research mode
 * - `/research exit` — Exit research mode
 * - `/research status` — Show current mode status
 * - `/research` (no args) — Show usage help
 */
export const handleResearch: CommandHandler = async (
  command: ControlCommand,
  context: ControlHandlerContext
): Promise<ControlResponse> => {
  // Check if research mode is available
  if (!context.researchMode) {
    return {
      success: false,
      error: 'Research mode is not available. Ensure the ResearchModeManager is configured.',
    };
  }

  const action = (command.data?.action as string) || '';
  const topic = (command.data?.topic as string) || '';

  // No action — show usage
  if (!action) {
    const state = context.researchMode.getState(command.chatId);
    const modeIndicator = state.mode === 'research'
      ? `🔍 **当前模式**: Research (\`${state.topic}\`)`
      : '💬 **当前模式**: Normal';

    return {
      success: true,
      message: [
        modeIndicator,
        '',
        '**用法:**',
        '• `/research <主题>` — 进入研究模式',
        '• `/research exit` — 退出研究模式',
        '• `/research status` — 查看当前状态',
        '',
        '研究模式下，Agent 将切换到独立的研究工作目录和专用 SOUL。',
      ].join('\n'),
    };
  }

  // Enter research mode
  if (action === 'enter') {
    if (!topic) {
      return {
        success: false,
        error: '请指定研究主题。用法: `/research <主题>`',
      };
    }

    try {
      const result = await context.researchMode.enterResearch(command.chatId, topic);
      return {
        success: true,
        message: [
          '🔍 **已进入 Research 模式**',
          '',
          `**主题**: \`${topic}\``,
          `**工作目录**: \`${result.researchDir}\``,
          result.created ? '**状态**: 新建研究目录 ✨' : '**状态**: 使用已有目录 📂',
          '',
          'Agent 现在将在独立的研究环境中工作。会话将自动重置以应用新的工作目录。',
          '',
          '💡 提示: 发送 `/research exit` 可随时退出研究模式。',
        ].join('\n'),
      };
    } catch (error) {
      return {
        success: false,
        error: `进入研究模式失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // Exit research mode
  if (action === 'exit') {
    const previous = context.researchMode.exitResearch(command.chatId);
    if (!previous) {
      return {
        success: false,
        error: '当前不在研究模式中。',
      };
    }

    return {
      success: true,
      message: [
        '💬 **已退出 Research 模式**',
        '',
        `**之前主题**: \`${previous.topic}\``,
        `**研究目录**: \`${previous.researchDir}\` (已保留)`,
        '',
        '已切换回 Normal 模式。会话将自动重置以恢复默认工作目录。',
      ].join('\n'),
    };
  }

  // Show status
  if (action === 'status') {
    const state = context.researchMode.getState(command.chatId);

    if (state.mode === 'research') {
      const duration = state.activatedAt
        ? Math.round((Date.now() - state.activatedAt) / 60000)
        : 0;
      const durationStr = duration < 1
        ? '不到 1 分钟'
        : `${duration} 分钟`;

      return {
        success: true,
        message: [
          '🔍 **Research 模式状态**',
          '',
          `**主题**: \`${state.topic}\``,
          `**工作目录**: \`${state.researchDir}\``,
          `**已持续时间**: ${durationStr}`,
          '',
          '💡 发送 `/research exit` 退出研究模式。',
        ].join('\n'),
      };
    }

    return {
      success: true,
      message: '💬 **当前模式**: Normal\n\n使用 `/research <主题>` 进入研究模式。',
    };
  }

  // Unknown action
  return {
    success: false,
    error: `未知操作: "${action}"。可用操作: enter, exit, status`,
  };
};
