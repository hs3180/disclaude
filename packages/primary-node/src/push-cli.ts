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
 * messages to chat agents, without needing the full disclaude agent stack
 * running in the caller process.
 *
 * Issue #4543: the transport is REST only — this CLI constructs a
 * RestIpcClient directly (POST /api/push on the PrimaryNode HttpApiServer)
 * and never reads DISCLAUDE_REST_IPC_ENABLED or touches a Unix socket. The
 * PrimaryNode must be started with --api-port (and, if it uses --api-token,
 * DISCLAUDE_REST_IPC_API_TOKEN must be set for the caller).
 *
 * @module primary-node/push-cli
 */

import { RestIpcClient, pushToAgent } from '@disclaude/core';

/** Default REST base URL (mirrors core's getIpcClient decision-3 default). */
const DEFAULT_REST_BASE_URL = 'http://localhost:9200';

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
disclaude-push - Push a message to a chat agent via REST

Usage:
  disclaude-push --chat-id <chatId> --message <message> [options]
  disclaude-push --chat-id <chatId> --message -   (read message from stdin)

Required:
  --chat-id, -c <id>       Target chat ID to push the message to
  --message, -m <text>     The instruction text to push to the chat agent
                            Use "-" to read message from stdin

Options:
  --help, -h               Show this help message

Transport (REST only, Issue #4543 — no Unix socket fallback):
  The PrimaryNode must be started with --api-port (default base url
  http://localhost:9200, override via DISCLAUDE_REST_IPC_BASE_URL).
  When the PrimaryNode enforces --api-token, callers must set
  DISCLAUDE_REST_IPC_API_TOKEN to the same secret.

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

/**
 * Construct the REST client directly (Issue #4543 scope 1).
 *
 * Deliberately NOT the core getIpcClient() facade: that singleton still
 * branches on DISCLAUDE_REST_IPC_ENABLED and would construct a
 * UnixSocketIpcClient when the env is unset (the old default). push-cli must
 * be REST unconditionally — no env switch, no socket fallback — so it builds
 * a RestIpcClient from DISCLAUDE_REST_IPC_BASE_URL (default
 * http://localhost:9200) + DISCLAUDE_REST_IPC_API_TOKEN (optional bearer for
 * POST routes). The env names are shared with the channel Skill CLI (#4532)
 * so a deployment only defines them once.
 */
export function createRestClient(): RestIpcClient {
  const baseUrl = process.env.DISCLAUDE_REST_IPC_BASE_URL || DEFAULT_REST_BASE_URL;
  const apiToken = process.env.DISCLAUDE_REST_IPC_API_TOKEN;
  return new RestIpcClient({ baseUrl, apiToken });
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

  // Issue #4543: REST only — no DISCLAUDE_REST_IPC_ENABLED read, no Unix
  // socket fast-fail. Reachability problems surface through the push result
  // (ipc_unavailable) with the actionable hint below.
  const client = createRestClient();
  const baseUrl = process.env.DISCLAUDE_REST_IPC_BASE_URL || DEFAULT_REST_BASE_URL;

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
        // Issue #4543 scope 3: actionable REST guidance instead of a raw
        // ECONNREFUSED — name the base URL and the startup flag.
        console.error(`PrimaryNode REST ${baseUrl} is unreachable.`);
        console.error('Start the main service with --api-port (e.g. disclaude-primary start --api-port 9200)');
        console.error('or point DISCLAUDE_REST_IPC_BASE_URL at the right address.');
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
