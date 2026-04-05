/**
 * Discussion End Handler.
 *
 * Handles group dissolution after a discussion-end trigger is detected.
 * Uses lark-cli to dissolve the chat via Feishu's official API.
 *
 * Design decisions (from rejected PR #1449 feedback):
 * - No session record file persistence
 * - No workspaceDir dependency
 * - Fire-and-forget: dissolution runs asynchronously after message is sent
 *
 * Issue #1229: Smart session end — dissolve group when discussion ends
 */

import { execFile } from 'node:child_process';
import { createLogger } from '@disclaude/core';
import type { TriggerResult } from './trigger-detector.js';

const logger = createLogger('DiscussionEndHandler');

/** Default timeout for lark-cli commands (30 seconds, matching existing patterns). */
const LARK_CLI_TIMEOUT_MS = 30_000;

/**
 * Result of a dissolution attempt.
 */
export interface DissolutionResult {
  success: boolean;
  chatId: string;
  reason?: string;
  error?: string;
}

/**
 * Dissolve a Feishu group chat using lark-cli.
 *
 * Uses the official `@larksuite/cli` tool to call the Feishu API:
 *   lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
 *
 * @param chatId - The Feishu chat ID to dissolve (e.g., "oc_xxx")
 * @returns Promise<DissolutionResult>
 */
export function dissolveChat(chatId: string): Promise<DissolutionResult> {
  return new Promise((resolve) => {
    if (!chatId) {
      resolve({
        success: false,
        chatId,
        error: 'chatId is required',
      });
      return;
    }

    const apiUrl = `DELETE /open-apis/im/v1/chats/${chatId}`;

    logger.info({ chatId, apiUrl }, 'Dissolving group chat via lark-cli');

    const child = execFile(
      'lark-cli',
      ['api', apiUrl],
      { timeout: LARK_CLI_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          // Check if lark-cli is not installed
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.error(
              { chatId, error: error.message },
              'lark-cli not found — cannot dissolve chat. Install @larksuite/cli.'
            );
            resolve({
              success: false,
              chatId,
              error: 'lark-cli not found',
            });
            return;
          }

          // Check for timeout
          if (error.killed) {
            logger.error({ chatId }, 'lark-cli timed out after 30s');
            resolve({
              success: false,
              chatId,
              error: 'lark-cli timed out',
            });
            return;
          }

          logger.error(
            { chatId, error: error.message, stderr: stderr?.trim() },
            'Failed to dissolve group chat via lark-cli'
          );
          resolve({
            success: false,
            chatId,
            error: error.message,
          });
          return;
        }

        logger.info(
          { chatId, stdout: stdout?.trim() },
          'Group chat dissolved successfully via lark-cli'
        );
        resolve({
          success: true,
          chatId,
        });
      }
    );
  });
}

/**
 * Handle a discussion-end trigger.
 *
 * Fire-and-forget: logs the trigger and initiates group dissolution.
 * Does NOT block the message sending pipeline.
 *
 * @param chatId - The Feishu chat ID to dissolve
 * @param trigger - The parsed trigger result
 */
export async function handleDiscussionEnd(chatId: string, trigger: TriggerResult): Promise<void> {
  logger.info(
    {
      chatId,
      phrase: trigger.phrase,
      reason: trigger.reason,
      hasSummary: !!trigger.summary,
    },
    'Processing discussion-end trigger'
  );

  const result = await dissolveChat(chatId);

  if (result.success) {
    logger.info(
      { chatId, reason: trigger.reason },
      'Discussion ended: group chat dissolved'
    );
  } else {
    logger.warn(
      { chatId, reason: trigger.reason, error: result.error },
      'Discussion end trigger detected but failed to dissolve group chat'
    );
  }
}
