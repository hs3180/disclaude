#!/usr/bin/env node
/**
 * Task While Loop — Node.js 版本
 *
 * 外部脚本驱动 agent 循环执行任务，通过 REST /api/push 接口推送 system message。
 * 相比 bash 版本，支持更灵活的完成条件检查（HTTP 回调、文件检查、自定义逻辑）。
 *
 * 依赖: disclaude REST channel 的 /api/push 端点 (Issue #3808)
 *
 * 用法:
 *   node task-while-loop.mjs --chat-id oc_xxx --message "请分析 PR #1234"
 *   node task-while-loop.mjs --chat-id oc_xxx --message "重构" --max 5 --interval 60
 *   node task-while-loop.mjs --chat-id oc_xxx --message "长时间任务" --timeout 600
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// --- 参数解析 ---
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        args[key] = value;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const CHAT_ID = args['chat-id'] || args.chatId;
const TASK_MESSAGE = args.message;
const MAX_ITERATIONS = parseInt(args.max || '10', 10);
const INTERVAL_SEC = parseInt(args.interval || '30', 10);
const TIMEOUT_SEC = parseInt(args.timeout || '0', 10);
const DONE_MARKER = args['done-marker'] || '';
const REST_HOST = args.host || process.env.REST_HOST || 'localhost';
const REST_PORT = args.port || process.env.REST_PORT || '3099';
const LOG_DIR = args['log-dir'] || '';

if (!CHAT_ID || !TASK_MESSAGE) {
  console.error('用法: node task-while-loop.mjs --chat-id <id> --message <task> [--max N] [--interval Sec] [--timeout Sec] [--done-marker <path>]');
  process.exit(1);
}

const PUSH_URL = `http://${REST_HOST}:${REST_PORT}/api/push`;

// --- 辅助函数 ---
function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
  if (LOG_DIR) {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(join(LOG_DIR, 'task-loop.log'), `[${ts}] ${msg}\n`, { flag: 'a' });
  }
}

async function pushToAgent(chatId, message) {
  try {
    const res = await fetch(PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, message }),
    });
    const data = await res.json();
    if (!res.ok) {
      log(`ERROR: push failed (${res.status}): ${JSON.stringify(data)}`);
      return false;
    }
    log(`Pushed: ${message.slice(0, 80)}...`);
    return true;
  } catch (err) {
    log(`ERROR: push failed: ${err.message}`);
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkDone() {
  if (DONE_MARKER && existsSync(DONE_MARKER)) {
    return true;
  }
  return false;
}

// --- 主循环 ---
(async () => {
  log(`Starting task loop: chat=${CHAT_ID} max=${MAX_ITERATIONS} interval=${INTERVAL_SEC}s${TIMEOUT_SEC ? ` timeout=${TIMEOUT_SEC}s` : ''}`);
  log(`Task: ${TASK_MESSAGE}`);

  // Global timeout handler
  let timeoutHandle;
  if (TIMEOUT_SEC > 0) {
    timeoutHandle = setTimeout(async () => {
      try {
        log(`Global timeout reached (${TIMEOUT_SEC}s)`);
        await pushToAgent(CHAT_ID, `任务执行超时 (${TIMEOUT_SEC}s)，请发送当前进展报告。`);
      } catch {
        log(`ERROR: failed to send timeout notification`);
      }
      process.exit(2);
    }, TIMEOUT_SEC * 1000);
  }

  function clearGlobalTimeout() {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // 发送初始任务指令
  await pushToAgent(CHAT_ID, TASK_MESSAGE);

  for (let i = 2; i <= MAX_ITERATIONS; i++) {
    await sleep(INTERVAL_SEC * 1000);

    // 检查完成条件
    if (checkDone()) {
      log(`Done marker found: ${DONE_MARKER}`);
      clearGlobalTimeout();
      await pushToAgent(CHAT_ID, '任务已完成，请发送最终总结。');
      process.exit(0);
    }

    // 推送继续指令
    await pushToAgent(CHAT_ID, `继续执行任务 — 步骤 ${i}/${MAX_ITERATIONS}。请检查当前进展并继续。`);
  }

  // 超过最大迭代
  log(`Reached max iterations (${MAX_ITERATIONS})`);
  clearGlobalTimeout();
  await pushToAgent(CHAT_ID, `任务已达到最大迭代次数 (${MAX_ITERATIONS})，请发送当前进展报告。`);
  process.exit(1);
})();
