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
 * The transport is resolved by the central getIpcClient() facade in
 * @disclaude/core (REST when DISCLAUDE_REST_IPC_ENABLED=true, Unix socket
 * otherwise). Issue #4280 (Phase 3) removed the --socket override that
 * constructed a UnixSocketIpcClient directly — the facade is now the only
 * client construction path.
 *
 * @module primary-node/push-cli
 */

import { getIpcClient, getIpcSocketPath, pushToAgent } from '@disclaude/core';
import { existsSync } from 'node:fs';

interface PushCliOptions {
  chatId: string;
  message: string;
}

export function parseArgs(args: string[]): PushCliOptions | null {
  let chatId = '';
  let message = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--chat-id' || arg === '-c') {
      chatId = args[++i] || '';
    } else if (arg === '--message' || arg === '-m') {
      message = args[++i] || '';
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

  return { chatId, message };
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
  --help, -h               Show this help message

Transport (resolved by getIpcClient() in @disclaude/core):
  DISCLAUDE_REST_IPC_ENABLED=true → REST IPC
    (base url via DISCLAUDE_REST_IPC_BASE_URL, default http://localhost:9200)
  otherwise → Unix socket (path via DISCLAUDE_WORKER_IPC_SOCKET /
    DISCLAUDE_IPC_SOCKET_PATH env vars, discovery file, or default)

Examples:
  # Push a message to a Feishu chat
  disclaude-push --chat-id "oc_xxx" --message "发现新消息，请处理"

  # Read message from stdin (useful for piping)
  echo "New messages found" | disclaude-push -c "oc_xxx" -m -

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

  const restEnabled = process.env.DISCLAUDE_REST_IPC_ENABLED === 'true';

  // Issue #4280 (Phase 3): the --socket override (direct UnixSocketIpcClient
  // construction, bypassing the facade) is removed — getIpcClient() is the
  // only client construction path, so the CLI always follows the configured
  // transport (REST when DISCLAUDE_REST_IPC_ENABLED=true, Unix socket
  // otherwise; selected in getIpcClient under #4279 Phase 2).
  const client = getIpcClient();

  // Fast-fail with a clear message only when actually using a Unix socket —
  // i.e. the default transport (REST off). Under REST mode there is no socket
  // file, so pushToAgent itself reports reachability.
  if (!restEnabled) {
    const socketPath = getIpcSocketPath();
    if (!existsSync(socketPath)) {
      console.error(`Error: IPC socket not found at ${socketPath}`);
      console.error('Make sure disclaude Primary Node is running.');
      process.exit(1);
    }
  }

  try {
    const result = await pushToAgent(client, options.chatId, message);
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
