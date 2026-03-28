/**
 * /research command handler — Research Mode control.
 *
 * Provides per-chatId mode switching:
 * - `/research <topic>` — Enter research mode for a topic
 * - `/research off` — Exit research mode (preserves research data)
 * - `/research` — Show current status
 *
 * Issue #1709: 增加 Research 模式：SOUL + 工作目录 + Skill 套装切换
 *
 * @module control/commands/research
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * Handle the /research control command.
 *
 * @param command - The control command from user
 * @param context - The control handler context
 * @returns Control response with status message
 */
export const handleResearch: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const { researchMode } = context;

  // Feature not available if researchMode manager not wired
  if (!researchMode) {
    return {
      success: true,
      message: '🔬 Research 模式功能尚在开发中，敬请期待。',
    };
  }

  const { chatId } = command;

  // Parse args: may be string[] (from Feishu) or string (from REST)
  const rawArgs = command.data?.args;
  const args: string | undefined = Array.isArray(rawArgs) ? rawArgs[0] : rawArgs as string | undefined;

  // /research off — Exit research mode
  if (args === 'off') {
    const wasResearch = researchMode.exitResearch(chatId);
    if (wasResearch) {
      return {
        success: true,
        message: '🔬 Research 模式已退出。研究数据已保留，可随时用 `/research <topic>` 重新进入。',
      };
    }
    return {
      success: true,
      message: 'ℹ️ 当前不在 Research 模式中。',
    };
  }

  // /research <topic> — Enter research mode
  if (args && args !== 'on' && args.trim().length > 0) {
    try {
      const state = researchMode.enterResearch(chatId, args.trim());
      return {
        success: true,
        message: [
          `🔬 已进入 Research 模式`,
          ``,
          `**主题**: ${state.topic}`,
          `**工作目录**: \`${state.dirName}/\``,
          `**状态**: SOUL 已切换，目录已隔离`,
          ``,
          `退出: \`/research off\``,
        ].join('\n'),
      };
    } catch (error) {
      return {
        success: false,
        message: `❌ 进入 Research 模式失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // /research (no args) — Show current status
  const currentMode = researchMode.getMode(chatId);
  if (currentMode === 'research') {
    const state = researchMode.getResearchState(chatId);
    if (state) {
      const duration = formatDuration(Date.now() - state.activatedAt);
      return {
        success: true,
        message: [
          `🔬 Research 模式 (活跃中)`,
          ``,
          `**主题**: ${state.topic}`,
          `**工作目录**: \`${state.dirName}/\``,
          `**持续时间**: ${duration}`,
          ``,
          `退出: \`/research off\``,
        ].join('\n'),
      };
    }
  }

  // Normal mode — show usage
  return {
    success: true,
    message: [
      `🔬 Research 模式`,
      ``,
      `当前: **普通模式**`,
      ``,
      `用法: \`/research <主题>\` — 进入研究模式`,
      `退出: \`/research off\` — 返回普通模式`,
    ].join('\n'),
  };
};

/**
 * Format a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '< 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} 小时 ${remainingMinutes} 分钟`;
}
