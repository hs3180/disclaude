/**
 * Shared utilities for Claude Agent SDK integration.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Get directory containing node executable.
 * This is needed for SDK subprocess spawning to find node.
 */
export function getNodeBinDir(): string {
  const execPath = process.execPath;
  return execPath.substring(0, execPath.lastIndexOf('/'));
}

/**
 * Extract text from SDK message.
 * Handles both assistant messages (streaming responses) and error messages.
 */
export function extractTextFromSDKMessage(message: SDKMessage): string {
  // Handle assistant message (streaming response)
  if (message.type === 'assistant') {
    const apiMessage = message.message;
    if (!apiMessage) return '';

    // Extract text from content blocks
    if (Array.isArray(apiMessage.content)) {
      const parts: string[] = [];
      for (const block of apiMessage.content) {
        if (block.type === 'text' && 'text' in block) {
          parts.push(block.text);
        }
      }
      return parts.join('');
    }
  }

  // Handle error during execution
  if (message.type === 'result' && message.subtype === 'error_during_execution' && 'errors' in message) {
    return `Error: ${(message.errors as string[]).join(', ')}`;
  }

  // Ignore result success (already streamed via assistant messages)
  // and system init messages
  return '';
}
