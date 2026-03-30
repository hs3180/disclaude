/**
 * /research 命令处理
 *
 * Issue #1709: Research 模式切换命令
 *
 * 用法:
 *   /research on <topic>  - 启用 Research 模式并创建研究工作目录
 *   /research off          - 关闭 Research 模式，恢复默认工作目录
 *   /research              - 查看当前 Research 模式状态
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /research 命令处理
 */
export const handleResearch: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const { researchMode, agentPool } = context;

  if (!researchMode) {
    return {
      success: true,
      message: '⏳ Research 模式功能尚在开发中，敬请期待。',
    };
  }

  const { chatId } = command;
  // Args may be passed as string[] (from Feishu message handler) or string (from REST API)
  const rawArgs = command.data?.args;
  const args: string[] = Array.isArray(rawArgs)
    ? rawArgs as string[]
    : rawArgs !== undefined
      ? String(rawArgs).split(/\s+/)
      : [];

  // /research off — 关闭 Research 模式
  if (args[0] === 'off') {
    if (!researchMode.isEnabled(chatId)) {
      return { success: true, message: 'ℹ️ 当前未处于 Research 模式。' };
    }
    researchMode.disable(chatId);
    // Issue #1709: Dispose agent to force recreation with default cwd
    agentPool.disposeAgent?.(chatId);
    return { success: true, message: '🔬 Research 模式已关闭，恢复默认工作目录。\n💡 会话已重置。' };
  }

  // /research on <topic> — 启用 Research 模式
  if (args[0] === 'on') {
    const topic = args.slice(1).join(' ').trim();
    if (!topic) {
      return {
        success: false,
        message: '⚠️ 请指定研究主题。用法: `/research on <主题>`',
      };
    }
    const researchCwd = researchMode.enable(chatId, topic);
    // Issue #1709: Dispose agent to force recreation with research cwd
    agentPool.disposeAgent?.(chatId);
    return {
      success: true,
      message: `🔬 Research 模式已开启\n` +
        `📝 主题: ${topic}\n` +
        `📁 工作目录: ${researchCwd}\n` +
        `💡 会话已重置，请开始研究。`,
    };
  }

  // 参数校验：有参数但不是有效值时拒绝操作
  if (args[0] !== undefined && args[0] !== 'on' && args[0] !== 'off') {
    return {
      success: false,
      message: '⚠️ 无效参数。用法: `/research [on <主题>|off]`',
    };
  }

  // 无参数时显示当前状态
  if (researchMode.isEnabled(chatId)) {
    const topic = researchMode.getTopic(chatId);
    const cwd = researchMode.getResearchCwd(chatId);
    return {
      success: true,
      message: `🔬 Research 模式: ✅ 已开启\n` +
        `📝 主题: ${topic}\n` +
        `📁 工作目录: ${cwd}\n` +
        `💡 发送 /research off 退出研究模式`,
    };
  }

  return {
    success: true,
    message: '🔬 Research 模式: ❌ 未开启\n' +
      '💡 用法: `/research on <主题>` 启用',
  };
};
