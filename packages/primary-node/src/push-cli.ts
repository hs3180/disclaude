#!/usr/bin/env node
/**
 * CLI entry point for disclaude-push — external push_to_agent command.
 *
 * Usage:
 *   disclaude-push --chat-id <chatId> --message <message>
 *   disclaude-push --help
 *
 * Issue #3808: Allows external scripts (cron jobs, shell loops) to push
 * messages to chat agents via the IPC server, without needing the full
 * disclaude agent stack running in the caller process.
 *
 * The socket path is discovered via:
 * 1. --socket CLI argument
 * 2. DISCLAUDE_WORKER_IPC_SOCKET env var
 * 3. DISCLAUDE_IPC_SOCKET_PATH env var
 * 4. IPC_SOCKET_PATH_FILE (/tmp/disclaude-ipc-socket)
 * 5. DEFAULT_IPC_CONFIG.socketPath (/tmp/disclaude-interactive.ipc)
 *
 * @module primary-node/push-cli
 */

import { UnixSocketIpcClient, IPC_SOCKET_PATH_FILE } from '@disclaude/core';
import { readFileSync, existsSync } from 'node:fs';

interface PushCliOptions {
  chatId: string;
  message: string;
  socketPath?: string;
}

function parseArgs(args: string[]): PushCliOptions | null {
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

Required:
  --chat-id, -c <id>       Target chat ID to push the message to
  --message, -m <text>     The instruction text to push to the chat agent

Options:
  --socket, -s <path>      IPC socket path (auto-detected if omitted)
  --help, -h               Show this help message

Socket Discovery (in order):
  1. --socket CLI argument
  2. DISCLAUDE_WORKER_IPC_SOCKET env var
  3. DISCLAUDE_IPC_SOCKET_PATH env var
  4. Socket path file: ${IPC_SOCKET_PATH_FILE}
  5. Default: /tmp/disclaude-interactive.ipc

Examples:
  # Push a message to a Feishu chat
  disclaude-push --chat-id "oc_xxx" --message "发现新消息，请处理"

  # Push with explicit socket path
  disclaude-push -c "oc_xxx" -m "继续执行步骤 2" -s /tmp/custom.ipc

  # In a cron script
  if check_for_new_messages; then
    disclaude-push -c "oc_xxx" -m "话题群有新消息需要回复"
  fi
`);
}

/**
 * Read the socket path from the well-known discovery file.
 */
function readSocketPathFile(): string | undefined {
  try {
    if (existsSync(IPC_SOCKET_PATH_FILE)) {
      return readFileSync(IPC_SOCKET_PATH_FILE, 'utf-8').trim() || undefined;
    }
  } catch {
    // Ignore
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const options = parseArgs(args);
  if (!options) {
    process.exit(1);
  }

  // Resolve socket path
  const socketPath = options.socketPath
    || process.env.DISCLAUDE_WORKER_IPC_SOCKET
    || process.env.DISCLAUDE_IPC_SOCKET_PATH
    || readSocketPathFile()
    || '/tmp/disclaude-interactive.ipc';

  // Check if socket file exists
  if (!existsSync(socketPath)) {
    console.error(`Error: IPC socket not found at ${socketPath}`);
    console.error('Make sure disclaude Primary Node is running.');
    process.exit(1);
  }

  // Connect and send pushToAgent request
  const client = new UnixSocketIpcClient({ socketPath });

  try {
    const result = await client.pushToAgent(options.chatId, options.message);
    if (result.success) {
      console.log('Message pushed successfully.');
    } else {
      console.error('Error: push_to_agent returned failure.');
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  } finally {
    client.disconnect();
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
