#!/usr/bin/env tsx
/**
 * schedules/pr-scanner.ts — PR Scanner v2 基础脚本骨架
 *
 * 提供确定性逻辑供 Schedule Prompt 调用。
 * 所有操作基于本地状态文件 (.temp-chats/)，不依赖 GitHub API。
 *
 * Usage:
 *   npx tsx scanner.ts --action <action> [options]
 *
 * Actions:
 *   check-capacity   读取 .temp-chats/ 统计 reviewing 数量
 *   list-candidates  过滤已有状态文件的 PR（需要 gh 输出通过 stdin 传入）
 *   create-state     写入 .temp-chats/pr-{number}.json
 *   mark             更新状态文件的 state 字段
 *   status           列出所有跟踪的 PR，按 state 分组
 *
 * 环境变量:
 *   PR_SCANNER_DIR   状态文件目录（默认: .temp-chats）
 *   PR_SCANNER_MAX_REVIEWING  最大并发 reviewing 数（默认: 3）
 *
 * Exit codes:
 *   0 — 成功
 *   1 — 致命错误
 *
 * Related: #2219
 */

import { readdir, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// ---- Types ----

/** PR 状态，严格按设计规范 §3.1（无 rejected） */
export type PRState = 'reviewing' | 'approved' | 'closed';

/** 状态文件 Schema（设计规范 §3.1） */
export interface PRStateFile {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: boolean;
}

/** check-capacity 输出 */
export interface CapacityOutput {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

/** list-candidates 输出项 */
export interface CandidatePR {
  number: number;
  title: string;
}

// ---- Constants ----

export const DEFAULT_DIR = '.temp-chats';
export const DEFAULT_MAX_REVIEWING = 3;
export const EXPIRY_HOURS = 48;
export const VALID_STATES: PRState[] = ['reviewing', 'approved', 'closed'];

// ---- Helpers ----

/** 获取状态文件目录 */
export function getStateDir(): string {
  return process.env.PR_SCANNER_DIR || DEFAULT_DIR;
}

/** 获取最大并发 reviewing 数 */
export function getMaxReviewing(): number {
  const env = process.env.PR_SCANNER_MAX_REVIEWING;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_REVIEWING;
}

/** 获取状态文件路径 */
export function stateFilePath(prNumber: number): string {
  return resolve(getStateDir(), `pr-${prNumber}.json`);
}

/** 当前 UTC 时间 ISO 格式 */
export function nowISO(): string {
  return new Date().toISOString();
}

/** 计算 expiresAt（createdAt + EXPIRY_HOURS） */
export function calculateExpiresAt(createdAt: string): string {
  const created = new Date(createdAt);
  return new Date(created.getTime() + EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
}

/** 原子写入：先写临时文件再 rename */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** 确保目录存在 */
async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // 目录可能已存在，忽略
  }
}

/** 解析状态文件 */
export function parseStateFile(json: string, filePath: string): PRStateFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`State file '${filePath}' is not valid JSON`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`State file '${filePath}' is not a valid JSON object`);
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.prNumber !== 'number' || !Number.isInteger(obj.prNumber) || obj.prNumber <= 0) {
    throw new Error(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }

  if (!isValidState(obj.state)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}' (must be reviewing|approved|closed)`);
  }

  if (obj.chatId !== null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId'`);
  }

  if (typeof obj.createdAt !== 'string') {
    throw new Error(`State file '${filePath}' has invalid or missing 'createdAt'`);
  }

  if (typeof obj.updatedAt !== 'string') {
    throw new Error(`State file '${filePath}' has invalid or missing 'updatedAt'`);
  }

  if (typeof obj.expiresAt !== 'string') {
    throw new Error(`State file '${filePath}' has invalid or missing 'expiresAt'`);
  }

  if (typeof obj.disbandRequested !== 'boolean') {
    throw new Error(`State file '${filePath}' has invalid or missing 'disbandRequested'`);
  }

  return data as PRStateFile;
}

function isValidState(state: unknown): state is PRState {
  return typeof state === 'string' && VALID_STATES.includes(state as PRState);
}

/** 读取所有状态文件 */
export async function readAllStates(dir: string): Promise<PRStateFile[]> {
  const states: PRStateFile[] = [];

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return states;
  }

  const jsonFiles = files.filter(f => f.startsWith('pr-') && f.endsWith('.json'));

  for (const fileName of jsonFiles) {
    const filePath = resolve(dir, fileName);
    try {
      const content = await readFile(filePath, 'utf-8');
      const state = parseStateFile(content, filePath);
      states.push(state);
    } catch (err) {
      console.error(`WARN: Skipping corrupted file: ${filePath} — ${err instanceof Error ? err.message : err}`);
    }
  }

  return states;
}

// ---- Actions ----

/**
 * check-capacity: 统计 reviewing 数量，输出 JSON
 */
export async function actionCheckCapacity(): Promise<void> {
  const dir = getStateDir();
  const maxConcurrent = getMaxReviewing();
  const states = await readAllStates(dir);
  const reviewing = states.filter(s => s.state === 'reviewing').length;
  const available = Math.max(0, maxConcurrent - reviewing);

  const output: CapacityOutput = { reviewing, maxConcurrent, available };
  console.log(JSON.stringify(output, null, 2));
}

/**
 * list-candidates: 从 stdin 读取 gh pr list 的 JSON 输出，过滤掉已有状态文件的 PR
 */
export async function actionListCandidates(): Promise<void> {
  const dir = getStateDir();

  // 读取已有的 PR 编号集合
  const states = await readAllStates(dir);
  const trackedNumbers = new Set(states.map(s => s.prNumber));

  // 从 stdin 读取 PR 列表 JSON
  const input = await readStdin();
  let prs: CandidatePR[];
  try {
    prs = JSON.parse(input);
  } catch {
    throw new Error('stdin is not valid JSON — pipe gh pr list output');
  }

  if (!Array.isArray(prs)) {
    throw new Error('stdin must be a JSON array of PR objects');
  }

  // 过滤已有状态文件的
  const candidates = prs.filter((pr: { number?: unknown }) => {
    if (typeof pr.number !== 'number') return false;
    return !trackedNumbers.has(pr.number);
  });

  console.log(JSON.stringify(candidates, null, 2));
}

/**
 * create-state: 创建新的状态文件
 * 需要 --pr <number> 参数
 */
export async function actionCreateState(prNumber: number): Promise<void> {
  const dir = getStateDir();
  await ensureDir(dir);

  const filePath = stateFilePath(prNumber);

  // 检查是否已存在
  try {
    await readFile(filePath, 'utf-8');
    throw new Error(`State file already exists for PR #${prNumber}: ${filePath}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err;
    }
    // 文件不存在，继续
  }

  const now = nowISO();
  const stateFile: PRStateFile = {
    prNumber,
    chatId: null,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: calculateExpiresAt(now),
    disbandRequested: false,
  };

  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');
  console.log(JSON.stringify(stateFile, null, 2));
}

/**
 * mark: 更新状态文件的 state 字段
 * 需要 --pr <number> 和 --state <state> 参数
 */
export async function actionMark(prNumber: number, newState: PRState): Promise<void> {
  const filePath = stateFilePath(prNumber);

  // 读取现有状态
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`State file not found for PR #${prNumber}: ${filePath}`);
  }

  const stateFile = parseStateFile(content, filePath);
  const oldState = stateFile.state;

  // 更新
  stateFile.state = newState;
  stateFile.updatedAt = nowISO();

  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');
  console.log(JSON.stringify({ ...stateFile, _previousState: oldState }, null, 2));
}

/**
 * status: 列出所有跟踪的 PR，按 state 分组
 */
export async function actionStatus(): Promise<void> {
  const dir = getStateDir();
  const states = await readAllStates(dir);

  if (states.length === 0) {
    console.log('No tracked PRs found.');
    console.log(JSON.stringify({ reviewing: [], approved: [], closed: [] }, null, 2));
    return;
  }

  // 按 state 分组
  const grouped: Record<PRState, PRStateFile[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  for (const s of states) {
    grouped[s.state].push(s);
  }

  // 人类可读文本
  console.log(`PR Scanner Status: ${states.length} tracked PR(s)`);
  console.log(`  Reviewing: ${grouped.reviewing.length}`);
  for (const s of grouped.reviewing) {
    console.log(`    PR #${s.prNumber} — created ${s.createdAt}, expires ${s.expiresAt}`);
  }
  console.log(`  Approved: ${grouped.approved.length}`);
  for (const s of grouped.approved) {
    console.log(`    PR #${s.prNumber} — updated ${s.updatedAt}`);
  }
  console.log(`  Closed: ${grouped.closed.length}`);
  for (const s of grouped.closed) {
    console.log(`    PR #${s.prNumber} — updated ${s.updatedAt}`);
  }

  // JSON 输出
  console.log('---');
  const summary = {
    total: states.length,
    reviewing: grouped.reviewing.map(s => ({ prNumber: s.prNumber, createdAt: s.createdAt, expiresAt: s.expiresAt })),
    approved: grouped.approved.map(s => ({ prNumber: s.prNumber, updatedAt: s.updatedAt })),
    closed: grouped.closed.map(s => ({ prNumber: s.prNumber, updatedAt: s.updatedAt })),
  };
  console.log(JSON.stringify(summary, null, 2));
}

// ---- CLI ----

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function parseArgs(args: string[]): { action: string; pr?: number; state?: string } {
  const result: { action: string; pr?: number; state?: string } = { action: '' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--action' && args[i + 1]) {
      result.action = args[++i];
    } else if (args[i] === '--pr' && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --pr value: ${args[i]}`);
      }
      result.pr = n;
    } else if (args[i] === '--state' && args[i + 1]) {
      result.state = args[++i];
    }
  }

  return result;
}

async function main(): Promise<void> {
  const { action, pr, state } = parseArgs(process.argv.slice(2));

  if (!action) {
    console.error('Usage: scanner.ts --action <check-capacity|list-candidates|create-state|mark|status> [--pr <number>] [--state <reviewing|approved|closed>]');
    process.exit(1);
  }

  switch (action) {
    case 'check-capacity':
      await actionCheckCapacity();
      break;

    case 'list-candidates':
      await actionListCandidates();
      break;

    case 'create-state':
      if (!pr) {
        throw new Error('--pr <number> is required for create-state');
      }
      await actionCreateState(pr);
      break;

    case 'mark':
      if (!pr) {
        throw new Error('--pr <number> is required for mark');
      }
      if (!state) {
        throw new Error('--state <reviewing|approved|closed> is required for mark');
      }
      if (!isValidState(state)) {
        throw new Error(`Invalid state '${state}'. Must be one of: ${VALID_STATES.join(', ')}`);
      }
      await actionMark(pr, state as PRState);
      break;

    case 'status':
      await actionStatus();
      break;

    default:
      throw new Error(`Unknown action: ${action}. Valid actions: check-capacity, list-candidates, create-state, mark, status`);
  }
}

// Only run main() when executed directly (not when imported by tests)
// Use a marker to detect direct execution — tsx runs via url/path import
const isMainModule = process.argv[1]?.includes('scanner.ts');
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
