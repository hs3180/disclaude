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
 * messages to chat agents via the PrimaryNode HTTP API, without needing the
 * full disclaude agent stack running in the caller process.
 *
 * Issue #4543: REST-only transport. push-cli constructs a RestIpcClient
 * directly (POST /api/push). There is no Unix-socket path, no IPC fallback,
 * and no transport toggle. PrimaryNode must be started with --api-port
 * (and --api-token when a token is configured).
 *
 * @module primary-node/push-cli
 */

import { RestIpcClient, pushToAgent } from '@disclaude/core';

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
disclaude-push - Push a message to a chat agent via the PrimaryNode REST API

Usage:
  disclaude-push --chat-id <chatId> --message <message>
  disclaude-push --chat-id <chatId> --message -   (read message from stdin)

Required:
  --chat-id, -c <id>       Target chat ID to push the message to
  --message, -m <text>     The instruction text to push to the chat agent
                            Use "-" to read message from stdin
  --help, -h               Show this help message

Transport (REST only, Issue #4543):
  disclaude-push talks to the PrimaryNode HTTP API (POST /api/push).
  PrimaryNode must be started with --api-port (recommend also --api-token).

  DISCLAUDE_REST_IPC_BASE_URL   PrimaryNode HTTP API base URL
                                 (default http://localhost:9200)
  DISCLAUDE_REST_IPC_API_TOKEN  Bearer token, required when PrimaryNode
                                 is started with --api-token

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

/** REST endpoint reachability failure → actionable message (Issue #4543 scope 3). */
function printRestUnreachable(baseUrl: string, detail: string): void {
  console.error(`Error: PrimaryNode REST API not reachable at ${baseUrl} (${detail})`);
  console.error('disclaude-push is REST-only: start the PrimaryNode with --api-port');
  console.error('(recommend also --api-token, exported to callers as DISCLAUDE_REST_IPC_API_TOKEN).');
  console.error(`Set DISCLAUDE_REST_IPC_BASE_URL if PrimaryNode listens elsewhere than ${baseUrl}.`);
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

  // Issue #4543: unconditional REST. The client is constructed directly —
  // never via the central dual-path facade (which still builds a Unix-socket
  // client by default), and no env var selects the transport.
  // Base URL / token come from the documented REST env vars.
  const baseUrl = process.env.DISCLAUDE_REST_IPC_BASE_URL || 'http://localhost:9200';
  const apiToken = process.env.DISCLAUDE_REST_IPC_API_TOKEN;
  const client = new RestIpcClient({ baseUrl, apiToken });

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
        // The REST transport maps connection failures (ECONNREFUSED etc.) to
        // this type — surface the startup guidance instead of the raw cause.
        printRestUnreachable(baseUrl, errorDetail);
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
