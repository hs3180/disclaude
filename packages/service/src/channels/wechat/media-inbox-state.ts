import { isAbsolute } from 'node:path';
import type { IncomingMessage } from '@disclaude/core';
import type { WeChatUpdate } from './types.js';

export const MAX_MEDIA_INBOX = 64;
const MAX_FAILURES = 3;
type Attachments = NonNullable<IncomingMessage['attachments']>;
export interface MediaInboxEntry {
  id: string;
  recoveryId: string;
  update: WeChatUpdate;
  state: 'pending' | 'dispatching' | 'uncertain' | 'failed';
  failures: number;
  nextAt: number;
  expiresAt: number;
  reported?: boolean;
  attachments?: Attachments;
}

/** Private checkpoint validation; never echo malformed payloads or references. */
export function validMediaInbox(value: unknown): value is MediaInboxEntry[] {
  return Array.isArray(value) && value.length <= MAX_MEDIA_INBOX && value.every(e => {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || typeof e.recoveryId !== 'string'
      || !['pending', 'dispatching', 'uncertain', 'failed'].includes(e.state) || !Number.isInteger(e.failures)
      || e.failures < 0 || e.failures > MAX_FAILURES || !Number.isFinite(e.nextAt) || !Number.isFinite(e.expiresAt)
      || (e.reported !== undefined && typeof e.reported !== 'boolean')) { return false; }
    const u = e.update as WeChatUpdate | undefined;
    if (!u || typeof u.from_user_id !== 'string' || !u.from_user_id || u.group_id || u.message_type === 2
      || (u.message_id ?? u.msg_id ?? u.client_id) !== e.id || !Array.isArray(u.item_list)) { return false; }
    const mediaCount = u.item_list.filter(i => i.type === 2 || i.type === 4).length;
    return mediaCount > 0 && (e.attachments === undefined || (Array.isArray(e.attachments) && e.attachments.length === mediaCount
      && e.attachments.every((a: Attachments[number]) => a && typeof a.fileName === 'string' && typeof a.filePath === 'string' && isAbsolute(a.filePath))));
  }) && new Set(value.map(e => e.id)).size === value.length;
}
