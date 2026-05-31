#!/usr/bin/env node
/**
 * Task While-Loop Template (Node.js)
 *
 * Drives an agent to execute a multi-step task by repeatedly pushing
 * system messages via disclaude-push CLI. The agent executes one step
 * per iteration, while this script handles loop control.
 *
 * Related: #3812 — Task While-Loop via script + system message
 * Depends: #3808 — disclaude-push CLI
 *
 * Usage:
 *   node task-loop.mjs --chat-id <id> --task-id <id> [options]
 *
 * Options:
 *   --chat-id   Target chat ID (required)
 *   --task-id   Task identifier for state tracking (required)
 *   --max-iter  Maximum iterations (default: 10)
 *   --interval  Seconds between iterations (default: 30)
 *   --done-file Path to completion marker file (default: tasks/<task-id>/done)
 *   --help      Show usage
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---- Parse Arguments ----

function parseArgs(args) {
  const opts = {
    chatId: '',
    taskId: '',
    maxIter: 10,
    interval: 30,
    doneFile: '',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--chat-id':   opts.chatId = args[++i] || ''; break;
      case '--task-id':   opts.taskId = args[++i] || ''; break;
      case '--max-iter':  opts.maxIter = parseInt(args[++i], 10) || 10; break;
      case '--interval':  opts.interval = parseInt(args[++i], 10) || 30; break;
      case '--done-file': opts.doneFile = args[++i] || ''; break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  if (!opts.chatId || !opts.taskId) {
    console.error('Error: --chat-id and --task-id are required.');
    console.error('Run with --help for usage.');
    process.exit(1);
  }

  opts.doneFile = opts.doneFile || `tasks/${opts.taskId}/done`;
  return opts;
}

function printUsage() {
  console.log(`
task-loop.mjs - Task While-Loop via disclaude-push

Usage:
  node task-loop.mjs --chat-id <id> --task-id <id> [options]

Required:
  --chat-id <id>       Target chat ID to push messages to
  --task-id <id>       Task identifier for state tracking

Options:
  --max-iter <n>       Maximum iterations (default: 10)
  --interval <sec>     Seconds between iterations (default: 30)
  --done-file <path>   Completion marker file path (default: tasks/<task-id>/done)
  --help, -h           Show this help message

Environment:
  Requires disclaude-push CLI in PATH.
  Socket discovery is automatic (see disclaude-push --help).
`);
}

// ---- Helpers ----

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushMessage(chatId, message) {
  console.log(`[task-loop] Pushing: ${message}`);
  try {
    execSync(`disclaude-push --chat-id "${chatId}" --message "${message}"`, {
      stdio: 'inherit',
      timeout: 30_000,
    });
  } catch (err) {
    console.error(`[task-loop] push failed: ${err.message}`);
    throw err;
  }
}

function checkDone(doneFile) {
  return existsSync(resolve(doneFile));
}

// ---- Main Loop ----

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { chatId, taskId, maxIter, interval, doneFile } = opts;

  console.log(`[task-loop] Starting task '${taskId}' (max ${maxIter} iterations, ${interval}s interval)`);

  for (let i = 1; i <= maxIter; i++) {
    console.log(`[task-loop] --- Iteration ${i}/${maxIter} ---`);

    // Check completion condition
    if (checkDone(doneFile)) {
      console.log(`[task-loop] Done file detected: ${doneFile}`);
      pushMessage(chatId, `任务 ${taskId} 已完成（检测到完成标记）。请发送最终总结。`);
      return;
    }

    // Push next step instruction
    pushMessage(chatId, `继续执行 ${taskId} 步骤 ${i}/${maxIter}。请检查当前进展并继续执行下一步。`);

    // Wait for agent to process (skip wait on last iteration)
    if (i < maxIter) {
      console.log(`[task-loop] Waiting ${interval}s for agent to process...`);
      await sleep(interval * 1000);
    }
  }

  // Timeout
  console.log(`[task-loop] Reached max iterations (${maxIter})`);
  pushMessage(chatId, `任务 ${taskId} 已达到最大迭代次数 (${maxIter})。请发送当前进展报告。`);
}

main().catch((err) => {
  console.error('[task-loop] Fatal error:', err.message);
  process.exit(1);
});
