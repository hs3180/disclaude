#!/usr/bin/env tsx
/**
 * skills/create-pr-group/create-pr-group.test.ts
 *
 * Integration tests for create-pr-group skill.
 * Uses CREATE_SKIP_LARK=1 to avoid real lark-cli calls.
 *
 * Run: npx tsx skills/create-pr-group/create-pr-group.test.ts
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Test infrastructure ----

// Resolve paths relative to the script's own location (the repo root)
const REPO_ROOT = resolve(new URL(import.meta.url).pathname, '..', '..', '..');
const SCRIPT_PATH = join(REPO_ROOT, 'skills', 'create-pr-group', 'create-pr-group.ts');
const TEST_DIR = `/tmp/test-create-pr-group-${Date.now()}`;
const MAPPING_FILE = join(TEST_DIR, 'bot-chat-mapping.json');

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runScript(env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['tsx', SCRIPT_PATH],
      {
        env: { ...process.env, ...env },
        timeout: 30_000,
        cwd: REPO_ROOT,
      },
    );
    return { exitCode: 0, stdout, stderr };
  } catch (err: unknown) {
    const execErr = err as { code?: string; stdout?: string; stderr?: string; status?: number };
    return {
      exitCode: execErr.status ?? 1,
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
    };
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

function cleanup(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function writeMapping(data: Record<string, unknown>): void {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(MAPPING_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function readMapping(): Record<string, unknown> {
  if (!existsSync(MAPPING_FILE)) return {};
  return JSON.parse(readFileSync(MAPPING_FILE, 'utf-8'));
}

// ---- Tests ----

async function main(): Promise<void> {
  console.log('\n🧪 create-pr-group tests\n');

  // Setup
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });

  // Test 1: Missing PR_NUMBER
  await test('fails when PR_NUMBER is missing', async () => {
    const result = await runScript({
      PR_TITLE: 'Test PR',
      MAPPING_FILE: MAPPING_FILE,
      CREATE_SKIP_LARK: '1',
    });
    assert(result.exitCode !== 0, 'Should exit with non-zero code');
    assert(result.stderr.includes('PR_NUMBER'), 'Should mention PR_NUMBER in error');
  });

  // Test 2: Missing PR_TITLE
  await test('fails when PR_TITLE is missing', async () => {
    const result = await runScript({
      PR_NUMBER: '123',
      MAPPING_FILE: MAPPING_FILE,
      CREATE_SKIP_LARK: '1',
    });
    assert(result.exitCode !== 0, 'Should exit with non-zero code');
    assert(result.stderr.includes('PR_TITLE'), 'Should mention PR_TITLE in error');
  });

  // Test 3: Invalid PR_NUMBER
  await test('fails when PR_NUMBER is not a positive integer', async () => {
    const result = await runScript({
      PR_NUMBER: '-5',
      PR_TITLE: 'Test',
      MAPPING_FILE: MAPPING_FILE,
      CREATE_SKIP_LARK: '1',
    });
    assert(result.exitCode !== 0, 'Should exit with non-zero code');
    assert(result.stderr.includes('positive integer'), 'Should mention positive integer');
  });

  // Test 4: Successful creation
  await test('creates group and writes mapping', async () => {
    // Ensure clean mapping file
    writeMapping({});

    const result = await runScript({
      PR_NUMBER: '1234',
      PR_TITLE: 'feat: add new feature',
      MAPPING_FILE: MAPPING_FILE,
      CREATE_SKIP_LARK: '1',
    });

    assert(result.exitCode === 0, `Should succeed, got: ${result.stderr}`);
    assert(result.stdout.includes('CHAT_ID='), 'Should output CHAT_ID');
    assert(result.stdout.includes('pr-1234'), 'Should mention mapping key');

    // Verify mapping file
    const mapping = readMapping();
    assert('pr-1234' in mapping, 'Mapping should contain pr-1234');
    const entry = mapping['pr-1234'] as { chatId: string; purpose: string; createdAt: string };
    assert(entry.chatId.startsWith('oc_'), 'chatId should start with oc_');
    assert(entry.purpose === 'pr-review', 'purpose should be pr-review');
    assert(entry.createdAt, 'createdAt should be set');
  });

  // Test 5: Idempotent skip
  await test('skips creation when mapping already exists', async () => {
    const existingChatId = 'oc_already_exists_1234';
    writeMapping({
      'pr-1234': {
        chatId: existingChatId,
        createdAt: '2026-04-28T10:00:00Z',
        purpose: 'pr-review',
      },
    });

    const result = await runScript({
      PR_NUMBER: '1234',
      PR_TITLE: 'Some title',
      MAPPING_FILE: MAPPING_FILE,
      CREATE_SKIP_LARK: '1',
    });

    assert(result.exitCode === 0, 'Should succeed');
    assert(result.stdout.includes('already exists'), 'Should mention already exists');
    assert(result.stdout.includes(existingChatId), `Should output existing chatId, got: ${result.stdout}`);
  });

  // Test 6: Group name generation — short title
  await test('generates correct group name for short title', async () => {
    writeMapping({});

    const result = await runScript({
      PR_NUMBER: '42',
      PR_TITLE: 'fix: minor bug',
      MAPPING_FILE: MAPPING_FILE,
      CREATE_SKIP_LARK: '1',
    });

    assert(result.exitCode === 0, 'Should succeed');
    assert(result.stdout.includes("PR #42 · fix: minor bug"), 'Should contain full group name');
  });

  // Test 7: Group name generation — long title truncation
  await test('truncates long title in group name', async () => {
    writeMapping({});

    const longTitle = '这是一段非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的标题用于测试截断功能';
    const result = await runScript({
      PR_NUMBER: '99',
      PR_TITLE: longTitle,
      MAPPING_FILE: MAPPING_FILE,
      CREATE_SKIP_LARK: '1',
    });

    assert(result.exitCode === 0, 'Should succeed');
    assert(result.stdout.includes('PR #99 · '), 'Should have prefix');
    // The group name should be truncated (not the full long title)
    const match = result.stdout.match(/Creating group.*'(.+?)'/);
    assert(match !== null, 'Should find group name in output');
    const groupName = match[1];
    assert(groupName.length <= 64, `Group name should be ≤ 64 chars, got ${groupName.length}`);
  });

  // Test 8: Creates new mapping file if it doesn't exist
  await test('creates mapping file when it does not exist', async () => {
    const newMappingFile = join(TEST_DIR, 'subdir', 'new-mapping.json');
    // Ensure file doesn't exist
    if (existsSync(newMappingFile)) unlinkSync(newMappingFile);

    const result = await runScript({
      PR_NUMBER: '555',
      PR_TITLE: 'Test PR',
      MAPPING_FILE: newMappingFile,
      CREATE_SKIP_LARK: '1',
    });

    assert(result.exitCode === 0, `Should succeed, got: ${result.stderr}`);
    assert(existsSync(newMappingFile), 'Mapping file should be created');

    const mapping = JSON.parse(readFileSync(newMappingFile, 'utf-8'));
    assert('pr-555' in mapping, 'Should contain pr-555');
  });

  // Test 9: Handles invalid existing mapping file gracefully
  await test('handles corrupted mapping file', async () => {
    writeFileSync(MAPPING_FILE, 'not valid json{', 'utf-8');

    const result = await runScript({
      PR_NUMBER: '777',
      PR_TITLE: 'Test',
      MAPPING_FILE: MAPPING_FILE,
      CREATE_SKIP_LARK: '1',
    });

    assert(result.exitCode === 0, `Should succeed despite corrupted file, got: ${result.stderr}`);
    assert(result.stdout.includes('CHAT_ID='), 'Should output CHAT_ID');

    // Verify the mapping was overwritten with valid data
    const mapping = JSON.parse(readFileSync(MAPPING_FILE, 'utf-8'));
    assert('pr-777' in mapping, 'Should contain new entry');
  });

  // Cleanup
  cleanup();

  // Summary
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal test error: ${err}`);
  cleanup();
  process.exit(1);
});
