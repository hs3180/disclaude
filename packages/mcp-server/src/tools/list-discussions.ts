/**
 * list_discussions tool implementation.
 *
 * Lists all temporary sessions, optionally filtered by status.
 * Automatically marks overdue sessions as expired before listing.
 *
 * @module mcp-server/tools/list-discussions
 */

import { createLogger } from '@disclaude/core';
import { listSessions, expireOverdueSessions } from './temporary-session.js';
import type { ListDiscussionsResult, SessionStatus } from './types.js';

const logger = createLogger('ListDiscussions');

/**
 * List all discussion sessions, optionally filtered by status.
 *
 * @param params.status - Optional status filter ('pending', 'active', 'expired')
 */
export async function list_discussions(params?: {
  status?: SessionStatus;
}): Promise<ListDiscussionsResult> {
  const statusFilter = params?.status;

  logger.info({ statusFilter }, 'list_discussions called');

  try {
    // Expire overdue sessions first
    await expireOverdueSessions();

    const sessions = await listSessions(statusFilter);

    if (sessions.length === 0) {
      const filterMsg = statusFilter ? ` with status "${statusFilter}"` : '';
      return {
        success: true,
        sessions: [],
        message: `📭 No sessions found${filterMsg}.`,
      };
    }

    // Build summary
    const statusCounts = { pending: 0, active: 0, expired: 0 };
    for (const s of sessions) {
      statusCounts[s.status]++;
    }

    const lines = sessions.map(s => {
      const emoji = { pending: '⏳', active: '🟢', expired: '🔴' }[s.status];
      const response = s.response ? `→ ${s.response.text}` : '';
      return `  ${emoji} ${s.sessionId}: ${s.status} — ${s.topic} ${response}`;
    });

    return {
      success: true,
      sessions,
      message: `📋 Sessions (${sessions.length} total: ` +
        `${statusCounts.pending} pending, ${statusCounts.active} active, ${statusCounts.expired} expired)\n` +
        lines.join('\n'),
    };

  } catch (error) {
    logger.error({ err: error }, 'list_discussions FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to list discussions: ${errorMessage}`,
    };
  }
}
