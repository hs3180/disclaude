import { getChannelApiClient } from './channel-api-utils.js';

/** Request a task-defined workflow through the channel transport; never submit a private value. */
export async function request_private_input(params: {
  chatId: string;
  actorId: string;
  sourceMessageId: string;
  workflow: Record<string, unknown>;
}): Promise<{ success: boolean; actionId: string; message: string }> {
  const result = await getChannelApiClient().requestChannel('requestPrivateInput', params);
  if (typeof result.actionId !== 'string' || !result.actionId) {
    throw new Error('Private input request returned no action ID');
  }
  return { success: true, actionId: result.actionId, message: 'Private input card requested' };
}
