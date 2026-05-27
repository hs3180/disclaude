import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /reset 命令处理
 * Issue #3696: support --no-context flag to skip history loading
 */
export const handleReset: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const skipContext = (command.data as { skipContext?: boolean } | undefined)?.skipContext;
  context.agentPool.reset(command.chatId, skipContext);
  const suffix = skipContext
    ? '\n\n⚠️ 历史上下文已跳过，将以空白状态开始。'
    : '';
  return {
    success: true,
    message: `✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。${suffix}`,
  };
};

/**
 * /restart 命令处理 — 重启整个服务进程 (Issue #3807)
 *
 * Unlike /reset which only resets a single chat's agent session,
 * /restart triggers a graceful shutdown of the entire service process.
 * The process manager (launchd/PM2) will then automatically restart it.
 */
export const handleRestart: CommandHandler = (
  _command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const doShutdown = (): void => {
    if (context.shutdown) {
      context.shutdown().catch(() => {
        // Best-effort: if graceful shutdown fails, force exit
        process.exit(0);
      });
    } else {
      // Fallback: if no shutdown handler is registered, force exit
      // (process manager will restart the service)
      process.exit(0);
    }
  };

  // Delay shutdown to allow the response message to be sent through
  // the channel before connections are closed. Without this delay,
  // shutdown() may close the WebSocket before the caller (message-handler)
  // finishes sending the "服务正在重启" response.
  setTimeout(doShutdown, 2000);

  return {
    success: true,
    message: '🔄 **服务正在重启**\n\n服务进程即将关闭并由进程管理器自动重启。',
  };
};
