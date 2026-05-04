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
      '| `/trigger` | 切换触发模式 | `/trigger [mention\\|always]` |',
      '| `/list-nodes` | 查看已连接的执行节点 | `/list-nodes` |',
      '| `/debug` | 设置/取消 Debug 群 | `/debug` |',
      '| `/project` | 管理 Project 上下文 | `/project [list\\|create\\|use\\|info\\|reset]` |',
    ].join('\n'),
  };
};
