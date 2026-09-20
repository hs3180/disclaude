import { getChannelApiClient } from './channel-api-utils.js';

/** The service resolves actor/chat/project from the received message context. */
export async function research_workspace(params: { context: string; operation: Record<string, unknown> }): Promise<{ success: boolean; data: unknown }> {
  const response = await getChannelApiClient().requestChannel('researchWorkspace', params);
  if (!response.result || typeof response.result !== 'object') { throw new Error('Research API returned no result'); }
  return { success: true, data: response.result };
}
