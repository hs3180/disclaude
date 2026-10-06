import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /stop 命令处理
 * Issue #1349: 停止当前正在进行的 AI 响应，但不重置会话
 * Issue #4587 (part 3): a stop issued inside a topic-group thread stops
 * that thread's agent, not the chat-scoped one.
 */
export const handleStop: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse | Promise<ControlResponse> => {
  const stopped =
    command.threadRootId && context.agentPool.stopThread
      ? context.agentPool.stopThread(command.chatId, command.threadRootId)
      : context.agentPool.stop(command.chatId);

  if (context.agentPool.stopNotebook) {
    return context.agentPool
      .stopNotebook(command.chatId, command.threadRootId)
      .then((report) => {
        const total =
          report.cancelled + report.alreadyTerminal + report.ownershipLost + report.unknown;
        if (!total && !report.unavailable) {
          return ordinaryResponse(stopped);
        }
        const lines = [stopped ? '已发出推理停止请求。' : '当前没有正在进行的推理。'];
        if (report.cancelled) {
          lines.push(`Notebook 已确认取消 ${report.cancelled} 项执行。`);
        }
        if (report.alreadyTerminal) {
          lines.push(`${report.alreadyTerminal} 项执行已结束。`);
        }
        if (report.ownershipLost) {
          lines.push(`${report.ownershipLost} 项执行的控制权已转移，未发送中断。`);
        }
        if (report.unknown || report.unavailable) {
          lines.push('部分 Notebook 停止状态未确认；请查询原运行，勿重复执行。');
        }
        return { success: true, message: `⏹️ **停止结果**\n\n${lines.join('\n')}` };
      })
      .catch(() => ({
        success: true,
        message: '⏹️ 已发出推理停止请求；Notebook 停止状态未确认，请查询原运行。',
      }));
  }
  return ordinaryResponse(stopped);
};

function ordinaryResponse(stopped: boolean): ControlResponse {
  if (stopped) {
    return {
      success: true,
      message: '⏹️ **已发送停止信号**\n\n正在终止当前执行；会话保持活跃，退出后可继续发送消息。',
    };
  } else {
    return {
      success: true,
      message: 'ℹ️ **没有正在进行的响应**\n\n当前没有需要停止的操作。',
    };
  }
}
