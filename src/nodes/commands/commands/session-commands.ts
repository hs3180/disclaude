/**
 * Session Commands - Conversation session management.
 *
 * Provides commands for resetting conversation, viewing status, and help.
 *
 * Issue #696: 拆分 builtin-commands.ts
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #537: 完成所有指令的 DI 重构
 */

import type { Command, CommandContext, CommandResult } from '../types.js';

/**
 * Reset Command - Reset the conversation session.
 */
export class ResetCommand implements Command {
  readonly name = 'reset';
  readonly category = 'session' as const;
  readonly description = '重置对话';

  async execute(context: CommandContext): Promise<CommandResult> {
    await context.services.sendCommand('reset', context.chatId);
    return {
      success: true,
      message: '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。',
    };
  }
}

/**
 * Status Command - Show current status.
 */
export class StatusCommand implements Command {
  readonly name = 'status';
  readonly category = 'session' as const;
  readonly description = '查看状态';

  execute(context: CommandContext): CommandResult {
    const { services, chatId } = context;
    const status = services.isRunning() ? 'Running' : 'Stopped';
    const execNodesList = services.getExecNodes();
    const execStatus = execNodesList.length > 0
      ? execNodesList.map(n => `${n.name} (${n.status}${n.isLocal ? ', local' : ''})`).join(', ')
      : 'None';
    const channelStatus = services.getChannelStatus();
    const currentNodeId = services.getChatNodeAssignment(chatId);
    const currentNode = execNodesList.find(n => n.nodeId === currentNodeId);

    return {
      success: true,
      message: `📊 **状态**\n\n状态: ${status}\n节点ID: ${services.getLocalNodeId()}\n执行节点: ${execStatus}\n当前节点: ${currentNode?.name || '未分配'}\n通道: ${channelStatus}`,
    };
  }
}

/**
 * Help Command - Show available commands.
 */
export class HelpCommand implements Command {
  readonly name = 'help';
  readonly category = 'session' as const;
  readonly description = '显示帮助';

  private generateHelpText: () => string;

  constructor(generateHelpText: () => string) {
    this.generateHelpText = generateHelpText;
  }

  execute(_context: CommandContext): CommandResult {
    return {
      success: true,
      message: this.generateHelpText(),
    };
  }
}
