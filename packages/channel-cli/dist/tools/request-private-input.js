import { getChannelApiClient } from './channel-api-utils.js';
/** Request a task-defined workflow through the channel transport; never submit a private value. */
export async function request_private_input(params) {
    const result = await getChannelApiClient().requestChannel('requestPrivateInput', params);
    if (typeof result.actionId !== 'string' || !result.actionId) {
        throw new Error('Private input request returned no action ID');
    }
    return { success: true, actionId: result.actionId, message: 'Private input card requested' };
}
