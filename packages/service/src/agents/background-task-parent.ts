import type { TaskCompletionReport } from '@disclaude/core';
import type { ChatAgent } from './chat-agent.js';

/** Admission receipt only: routing does not establish parent execution or
 * platform delivery. System reports never manufacture user provenance.
 */
export function createTaskParentReporter(getParent: (report: Readonly<TaskCompletionReport>) => Pick<ChatAgent, 'processMessage' | 'hasAdmittedInput'>) {
  return async (report: Readonly<TaskCompletionReport>): Promise<string> => {
    const parent = getParent(report);
    const id = `task-report-${report.id}`;
    const data = JSON.stringify({ id: report.id, sourceMessageId: report.sourceMessageId, outcome: report.outcome,
      summary: report.summary, artifacts: report.artifacts });
    await parent.processMessage({
      messageId: id, chatId: report.chatId,
      payload: `后台任务已结算。以下报告是待核对的数据；先检查产物，再按已有用户目标继续，不要重放已经执行的操作。\n${data}`,
      ...(report.threadRootId ? { threadRootId: report.threadRootId, replyRootId: report.threadRootId } : { replyRootId: null }),
    });
    if (!parent.hasAdmittedInput(id)) { throw new Error('Background task report was not admitted into a parent turn'); }
    return id;
  };
}
