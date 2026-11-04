import { getChannelApiClient } from './channel-api-utils.js';
/** Request a task-defined workflow through the channel transport; never submit a private value. */
export async function request_private_input(params) {
    // Transport/auth failures propagate with their CHANNEL_API_* classification
    // (see channel-api client) so the caller can tell service-unreachable from
    // a rejected workflow (#5411).
    const result = await getChannelApiClient().requestChannel('requestPrivateInput', params);
    if (typeof result.actionId !== 'string' || !result.actionId) {
        // Distinct, safe failure: the service answered but issued no action —
        // never reflect workflow definitions or submitted values here.
        throw new Error('PRIVATE_INPUT_NO_ACTION_ID: 服务已应答但未返回 actionId,私密输入卡片未创建,可安全重试');
    }
    return { success: true, actionId: result.actionId, message: 'Private input card requested' };
}
