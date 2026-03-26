import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /help 命令处理
 */
export const handleHelp: CommandHandler = (
  _command: ControlCommand,
  _context: ControlHandlerContext
): ControlResponse => {
  return {
    success: true,
    message: [
      '📖 **命令列表**',
      '',
      '| 命令 | 说明 | 用法 |',
      '|------|------|------|',
      '| `/help` | 显示帮助信息 | `/help` |',
      '| `/reset` | 重置当前会话 | `/reset` |',
      '| `/stop` | 停止当前响应 | `/stop` |',
      '| `/status` | 查看服务状态 | `/status` |',
      '| `/restart` | 重启 Agent 实例 | `/restart` |',
      '| `/passive` | 切换被动模式 | `/passive on\\|off` |',
      '| `/list-nodes` | 查看已连接的执行节点 | `/list-nodes` |',
      '| `/show-debug` | 显示 Debug 组信息 | `/show-debug` |',
      '| `/clear-debug` | 清除 Debug 组 | `/clear-debug` |',
    ].join('\n'),
  };
};
