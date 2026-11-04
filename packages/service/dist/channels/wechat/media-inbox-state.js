import { isAbsolute } from 'node:path';
export const MAX_MEDIA_INBOX = 64;
const MAX_FAILURES = 3;
/** Private checkpoint validation; never echo malformed payloads or references. */
export function validMediaInbox(value) {
    return Array.isArray(value) && value.length <= MAX_MEDIA_INBOX && value.every(e => {
        if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || typeof e.recoveryId !== 'string'
            || !['pending', 'dispatching', 'uncertain', 'failed'].includes(e.state) || !Number.isInteger(e.failures)
            || e.failures < 0 || e.failures > MAX_FAILURES || !Number.isFinite(e.nextAt) || !Number.isFinite(e.expiresAt)
            || (e.reported !== undefined && typeof e.reported !== 'boolean')) {
            return false;
        }
        const u = e.update;
        if (!u || typeof u.from_user_id !== 'string' || !u.from_user_id || u.group_id || u.message_type === 2
            || (u.message_id ?? u.msg_id ?? u.client_id) !== e.id || !Array.isArray(u.item_list)) {
            return false;
        }
        const mediaCount = u.item_list.filter(i => i.type === 2 || i.type === 4).length;
        return mediaCount > 0 && (e.attachments === undefined || (Array.isArray(e.attachments) && e.attachments.length === mediaCount
            && e.attachments.every((a) => a && typeof a.fileName === 'string' && typeof a.filePath === 'string' && isAbsolute(a.filePath))));
    }) && new Set(value.map(e => e.id)).size === value.length;
}
