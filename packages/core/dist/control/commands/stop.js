/**
 * /stop 命令处理
 * Issue #1349: 停止当前正在进行的 AI 响应，但不重置会话
 * Issue #4587 (part 3): a stop issued inside a topic-group thread stops
 * that thread's agent, not the chat-scoped one.
 */
export const handleStop = (command, context) => {
    const stopped = command.threadRootId && context.agentPool.stopThread
        ? context.agentPool.stopThread(command.chatId, command.threadRootId)
        : context.agentPool.stop(command.chatId);
    if (stopped) {
        return {
            success: true,
            message: '⏹️ **已发送停止信号**\n\n正在终止当前执行；会话保持活跃，退出后可继续发送消息。',
        };
    }
    else {
        return {
            success: true,
            message: 'ℹ️ **没有正在进行的响应**\n\n当前没有需要停止的操作。',
        };
    }
};
