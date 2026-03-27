/**
 * /research command handler.
 *
 * Issue #1709: Research Mode — Phase 1
 *
 * Usage:
 *   /research <topic>  — Enter research mode for the given topic
 *   /research off      — Exit research mode, return to normal mode
 *   /research          — Show current research mode status
 *
 * When entering research mode:
 * - Creates an isolated workspace at `workspace/research/{topic}/`
 * - Injects a CLAUDE.md (Research SOUL) with behavior norms
 * - Subsequent agent queries will use the research workspace as CWD
 *
 * @module control/commands/research
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /research command handler.
 */
export const handleResearch: CommandHandler = async (
  command: ControlCommand,
  context: ControlHandlerContext
): Promise<ControlResponse> => {
  const { researchMode } = context;
  const { chatId } = command;

  // Args may be passed as string[] (from Feishu message handler) or string (from REST API)
  const rawArgs = command.data?.args;
  const args: string | undefined = Array.isArray(rawArgs) ? rawArgs[0] : rawArgs as string | undefined;

  // Check if research mode manager is available
  if (!researchMode) {
    return {
      success: false,
      message: '⚠️ Research mode is not available in this environment.',
    };
  }

  // /research off — Exit research mode
  if (args === 'off') {
    if (!researchMode.isResearchMode(chatId)) {
      return {
        success: true,
        message: 'ℹ️ 当前不在 Research 模式中。',
      };
    }

    const info = researchMode.getResearchInfo(chatId);
    researchMode.exitResearchMode(chatId);

    return {
      success: true,
      message: `✅ 已退出 Research 模式。\n\n研究数据已保留在: \`${info?.workspaceDir}\``,
    };
  }

  // /research <topic> — Enter research mode
  if (args && args.trim() && args !== 'on') {
    try {
      const result = await researchMode.enterResearchMode(chatId, {
        topic: args.trim(),
      });

      return {
        success: true,
        message: [
          '🔬 **已进入 Research 模式**',
          '',
          `**主题**: ${args.trim()}`,
          `**工作目录**: \`${result.workspaceDir}\``,
          '',
          '💡 Research 模式下:',
          '- 工作目录已切换到独立研究空间',
          '- 已注入 Research SOUL 行为规范',
          '- 发送 `/research off` 退出研究模式',
          '- 发送 `/reset` 重置会话（保留研究数据）',
        ].join('\n'),
      };
    } catch (error) {
      return {
        success: false,
        message: `❌ 进入 Research 模式失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // /research (no args or "on") — Show current status
  if (researchMode.isResearchMode(chatId)) {
    const info = researchMode.getResearchInfo(chatId);
    return {
      success: true,
      message: [
        '🔬 **Research 模式已激活**',
        '',
        `**主题**: ${info?.topic}`,
        `**工作目录**: \`${info?.workspaceDir}\``,
        `**进入时间**: ${info?.enteredAt.toLocaleString()}`,
        '',
        '用法:',
        '- `/research off` — 退出 Research 模式',
        '- `/research <新主题>` — 切换到新主题',
      ].join('\n'),
    };
  }

  // Not in research mode, no args
  return {
    success: true,
    message: [
      '🔬 **Research 模式**',
      '',
      '用法:',
      '- `/research <主题>` — 进入 Research 模式',
      '- `/research off` — 退出 Research 模式',
      '',
      'Research 模式提供独立的研究空间，包含:',
      '- 📁 独立工作目录（与日常项目隔离）',
      '- 🧠 Research SOUL 行为规范',
      '- 📝 研究笔记和资料子目录',
    ].join('\n'),
  };
};
