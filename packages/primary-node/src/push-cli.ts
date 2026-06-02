#!/usr/bin/env node
/**
 * CLI entry point for disclaude-push — external push_to_agent command.
 *
 * Usage:
 *   disclaude-push --chat-id <chatId> --message <message>
 *   disclaude-push --chat-id <chatId> --message -   (read message from stdin)
 *   disclaude-push --help
 *
 * Issue #3808: Allows external scripts (cron jobs, shell loops) to push
 * messages to chat agents via the IPC server, without needing the full
 * disclaude agent stack running in the caller process.
 *
 * The socket path is discovered via getIpcSocketPath() from @disclaude/core,
 * with --socket CLI argument taking highest priority.
 *
 * @module primary-node/push-cli
 */

import { UnixSocketIpcClient, getIpcSocketPath } from '@disclaude/core';
import { existsSync } from 'node:fs';

interface PushCliOptions {
  chatId: string;
  message: string;
  socketPath?: string;
}

export function parseArgs(args: string[]): PushCliOptions | null {
  let chatId = '';
  let message = '';
  let socketPath = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--chat-id' || arg === '-c') {
      chatId = args[++i] || '';
    } else if (arg === '--message' || arg === '-m') {
      message = args[++i] || '';
    } else if (arg === '--socket' || arg === '-s') {
      socketPath = args[++i] || '';
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  if (!chatId || !message) {
    console.error('Error: --chat-id and --message are required.');
    console.error('Run with --help for usage information.');
    process.exit(1);
  }

  return { chatId, message, socketPath: socketPath || undefined };
}

function printUsage(): void {
  console.log(`
disclaude-push - Push a message to a chat agent via IPC

Usage:
  disclaude-push --chat-id <chatId> --message <message> [options]
  disclaude-push --chat-id <chatId> --message -   (read message from stdin)

Required:
  --chat-id, -c <id>       Target chat ID to push the message to
  --message, -m <text>     The instruction text to push to the chat agent
                            Use "-" to read message from stdin

Options:
  --socket, -s <path>      IPC socket path (auto-detected if omitted)
  --help, -h               Show this help message

Socket Discovery (handled by getIpcSocketPath() in @disclaude/core):
  1. --socket CLI argument (highest priority)
  2. DISCLAUDE_WORKER_IPC_SOCKET / DISCLAUDE_IPC_SOCKET_PATH env vars
  3. Socket path discovery file (written by Primary Node)
  4. Default fallback

Examples:
  # Push a message to a Feishu chat
  disclaude-push --chat-id "oc_xxx" --message "发现新消息，请处理"

  # Read message from stdin (useful for piping)
  echo "New messages found" | disclaude-push -c "oc_xxx" -m -

  # Push with explicit socket path
  disclaude-push -c "oc_xxx" -m "继续执行步骤 2" -s /tmp/custom.ipc

  # In a cron script
  if check_for_new_messages; then
    disclaude-push -c "oc_xxx" -m "话题群有新消息需要回复"
  fi
`);
}

/**
 * Read message from stdin when --message is "-".
 */
function readMessageFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { resolve(data.trim()); });
    process.stdin.on('error', reject);
  });
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const options = parseArgs(args);
  if (!options) {
    process.exit(1);
  }

  // Handle stdin message
  let { message } = options;
  if (message === '-') {
    if (process.stdin.isTTY) {
      console.error('Error: --message - requires stdin input (pipe or redirect).');
      process.exit(1);
    }
    message = await readMessageFromStdin();
    if (!message) {
      console.error('Error: stdin is empty.');
      process.exit(1);
    }
  }

  // Resolve socket path using core's getIpcSocketPath() with CLI override
  const socketPath = getIpcSocketPath({ override: options.socketPath });

  // Check if socket file exists
  if (!existsSync(socketPath)) {
    console.error(`Error: IPC socket not found at ${socketPath}`);
    console.error('Make sure disclaude Primary Node is running.');
    process.exit(1);
  }

  // Connect and send pushToAgent request
  const client = new UnixSocketIpcClient({ socketPath });

  try {
    const result = await client.pushToAgent(options.chatId, message);
    if (result.success) {
      console.log('Message pushed successfully.');
    } else {
      // Output detailed error info (Issue #3808 review fix)
      const errorType = result.errorType || 'unknown';
      const errorDetail = result.error || 'No details available';
      console.error(`Error: push_to_agent failed [${errorType}]: ${errorDetail}`);
      if (result.errorType === 'ipc_unavailable') {
        console.error('The Primary Node may not be running or IPC is not available.');
      } else if (result.errorType === 'ipc_timeout') {
        console.error('The request timed out. The agent may be busy or unresponsive.');
      }
      process.exit(1);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${msg}`);
    process.exit(1);
  } finally {
    void client.disconnect().catch(() => {});
  }
}

// Auto-run only when executed directly (not when imported for testing)
if (process.argv[1]?.endsWith('push-cli.ts') || process.argv[1]?.endsWith('push-cli.js')) {
  main().catch((error) => {
    console.error('Unhandled error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
