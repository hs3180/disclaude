import { getChannelApiClient } from './channel-api-utils.js';
/** The service resolves actor/chat/project from the received message context. */
export async function project_task(params) {
    const response = await getChannelApiClient().requestChannel('projectTask', params);
    if (!response.result || typeof response.result !== 'object') {
        throw new Error('Task API returned no result');
    }
    return { success: true, data: response.result };
}
