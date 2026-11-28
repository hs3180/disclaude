import { getChannelApiClient } from './channel-api-utils.js';

/** Ask a task question through the channel transport; never submit an answer.
 * The service binds the question to the live Goal turn of this actor, chat and
 * Project before the card is raised — the identity fields are a claim the host
 * verifies, not an authorization. */
export async function task_question_ask(params: {
  chatId: string;
  actorId: string;
  projectRoot: string;
  sourceMessageId: string;
  question: string;
  goalId?: string;
  threadRootId?: string;
  replyRootId?: string;
}): Promise<{ success: boolean; questionId: string; message: string }> {
  // Transport/auth/admission failures propagate with their CHANNEL_API_*
  // classification; a refused admission surfaces the host's constant sentence
  // (HTTP 409/503) so the caller can tell "no live Goal turn" from a timeout.
  const result = await getChannelApiClient().requestChannel('askTaskQuestion', params);
  const record = result.record as { id?: unknown } | undefined;
  if (typeof record?.id !== 'string' || !record.id) {
    // Distinct, safe failure: the service answered but returned no question
    // record, so no card was raised — never reflect question content here.
    throw new Error('TASK_QUESTION_NO_RECORD_ID: 服务已应答但未返回问题记录,提问卡片未创建,可安全重试');
  }
  return { success: true, questionId: record.id, message: 'Task question card requested' };
}
