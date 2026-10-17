import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { CommandHandler, ControlHandlerContext } from '../types.js';

/**
 * /issue (Issue #5400): offer one-click GitHub reporting of this chat's most
 * recent failure. The heavy lifting (sanitized summary card, GitHub App
 * client, dedup) lives behind the channel hook; the command itself stays
 * available even when the agent runtime is down — it only reads the failure
 * registry and delegates.
 */
export const handleIssue: CommandHandler<'issue'> = async (
  command: ControlCommand<'issue'>,
  context: ControlHandlerContext
): Promise<ControlResponse> => {
  if (!context.failureRegistry) {
    return { success: false, message: 'GitHub 一键上报未启用：失败记录组件不可用。' };
  }
  const record = context.failureRegistry.get(command.chatId);
  if (!record) {
    return {
      success: true,
      message: 'ℹ️ 本会话暂无可上报的失败记录。出现报错提示（含诊断 ID）后再使用 /issue。',
    };
  }
  if (!context.issueReporting) {
    return {
      success: false,
      message: '当前渠道不支持上报确认卡，或 github 配置段未配置。请联系服务维护者。',
    };
  }
  try {
    const sent = await context.issueReporting.sendConfirmation(record, {
      chatId: command.chatId,
      threadRootId: command.threadRootId,
      actorId: command.actorId,
    });
    return sent.ok
      ? {
          success: true,
          message: '📋 已发送上报确认卡；请核对脱敏摘要后确认提交，可补充实际现象与期望行为。',
        }
      : {
          success: false,
          message: `上报确认卡发送失败：${sent.error}。失败记录已保留，可稍后重试 /issue。`,
        };
  } catch (error) {
    return {
      success: false,
      message: '上报确认卡发送失败，失败记录已保留，可稍后重试 /issue。',
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
