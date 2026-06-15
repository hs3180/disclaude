/**
 * search_chat_history tool implementation.
 *
 * Searches chat log files for keyword matches, returning matching
 * conversation fragments with timestamp and sender information.
 *
 * Issue #4107 Phase 1: Basic keyword search over Markdown chat logs.
 *
 * @module mcp-server/tools/search-chat-history
 */

import fs from 'fs/promises';
import path from 'path';
import { Config, MESSAGE_LOGGING, createLogger } from '@disclaude/core';
import type { SearchChatHistoryResult, ChatHistoryMatch } from './types.js';

const logger = createLogger('SearchChatHistory');

/**
 * Parse a chat log file into individual message entries.
 *
 * Log format:
 *   👤 [timestamp] (messageId)
 *   content...
 *
 *   ---
 *
 *   🤖 [timestamp] (messageId)
 *   content...
 *
 *   ---
 */
function parseLogEntries(content: string): Array<{
  sender: string;
  timestamp: string;
  messageId: string;
  body: string;
}> {
  const entries: Array<{ sender: string; timestamp: string; messageId: string; body: string }> = [];
  // Split on the separator line
  const blocks = content.split(/\n---\n/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) {continue;}

    // Match header: 👤 [timestamp] (messageId)  or  🤖 [timestamp] (messageId)
    const headerMatch = trimmed.match(/^([👤🤖])\s*\[([^\]]+)\]\s*\(([^)]+)\)\n([\s\S]*)$/);
    if (headerMatch) {
      const [, emoji, timestamp, messageId, body] = headerMatch;
      entries.push({
        sender: emoji === '👤' ? 'user' : 'bot',
        timestamp,
        messageId,
        body: body.trim(),
      });
    }
  }

  return entries;
}

/**
 * Search chat history for messages matching a keyword query.
 *
 * @param params.query - Keyword(s) to search for (case-insensitive)
 * @param params.limit - Maximum number of results (default 10)
 * @param params.chatId - Optional chat ID to restrict search to a specific chat
 */
export async function search_chat_history(params: {
  query: string;
  limit?: number;
  chatId?: string;
}): Promise<SearchChatHistoryResult> {
  const { query, limit = 10, chatId } = params;

  logger.info({ queryPreview: query.substring(0, 50), limit, chatId }, 'search_chat_history called');

  try {
    if (!query || !query.trim()) {
      return {
        success: false,
        message: '❌ Query is required',
        error: 'query must be a non-empty string',
        matches: [],
        totalFound: 0,
      };
    }

    const workspaceDir = Config.getWorkspaceDir();
    const chatDir = path.join(workspaceDir, MESSAGE_LOGGING.LOGS_DIR);

    // Read date directories
    let dateDirs: string[];
    try {
      const entries = await fs.readdir(chatDir, { withFileTypes: true });
      dateDirs = entries
        .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .map(e => e.name)
        .sort((a, b) => b.localeCompare(a)); // newest first
    } catch {
      return {
        success: true,
        message: 'No chat history found.',
        matches: [],
        totalFound: 0,
      };
    }

    const queryLower = query.toLowerCase();
    const matches: ChatHistoryMatch[] = [];
    const maxDays = 30; // Search up to 30 days of history

    for (const dateDir of dateDirs.slice(0, maxDays)) {
      const dirPath = path.join(chatDir, dateDir);

      let files: string[];
      try {
        files = await fs.readdir(dirPath);
      } catch {
        continue;
      }

      // Filter to specific chatId if provided
      const targetFiles = chatId
        ? files.filter(f => f === `${chatId}.md`)
        : files.filter(f => f.endsWith('.md'));

      for (const file of targetFiles) {
        const filePath = path.join(dirPath, file);
        let content: string;
        try {
          content = await fs.readFile(filePath, 'utf-8');
        } catch {
          continue;
        }

        const fileChatId = file.replace('.md', '');
        const entries = parseLogEntries(content);

        for (const entry of entries) {
          if (entry.body.toLowerCase().includes(queryLower)) {
            // Extract a snippet around the match
            const bodyLower = entry.body.toLowerCase();
            const matchIdx = bodyLower.indexOf(queryLower);
            const snippetStart = Math.max(0, matchIdx - 100);
            const snippetEnd = Math.min(entry.body.length, matchIdx + query.length + 200);
            let snippet = entry.body.slice(snippetStart, snippetEnd);
            if (snippetStart > 0) {snippet = `...${snippet}`;}
            if (snippetEnd < entry.body.length) {snippet = `${snippet}...`;}

            matches.push({
              date: dateDir,
              chatId: fileChatId,
              sender: entry.sender,
              timestamp: entry.timestamp,
              messageId: entry.messageId,
              snippet,
            });

            if (matches.length >= limit) {
              return {
                success: true,
                message: `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query}".`,
                matches,
                totalFound: matches.length,
              };
            }
          }
        }
      }
    }

    if (matches.length === 0) {
      return {
        success: true,
        message: `No matches found for "${query}".`,
        matches: [],
        totalFound: 0,
      };
    }

    return {
      success: true,
      message: `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query}".`,
      matches,
      totalFound: matches.length,
    };
  } catch (error) {
    logger.error({ err: error, query }, 'search_chat_history FAILED');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message: `❌ Search failed: ${errorMessage}`,
      error: errorMessage,
      matches: [],
      totalFound: 0,
    };
  }
}
