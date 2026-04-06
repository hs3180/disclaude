#!/usr/bin/env tsx
/**
 * chat/check-deps.ts — Validate Chat Skill runtime dependencies.
 *
 * Checks:
 *   1. Node.js version >= 20.12 (required for fs.flock)
 *   2. tsx availability (TypeScript execution runtime)
 *   3. workspace/chats/ directory accessibility
 *
 * Usage:
 *   npx tsx scripts/chat/check-deps.ts
 *
 * Exit codes:
 *   0 — all dependencies satisfied
 *   1 — one or more critical dependencies missing
 */

import { access, mkdir, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { CHAT_DIR } from './schema.js';

// ---- Constants ----

const MIN_NODE_VERSION = [20, 12, 0];
const REQUIRED_CMD = 'tsx';

// ---- Result tracking ----

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  fix?: string;
}

const results: CheckResult[] = [];

function ok(name: string, message: string): void {
  results.push({ name, status: 'ok', message });
}

function warn(name: string, message: string, fix?: string): void {
  results.push({ name, status: 'warn', message, fix });
}

function fail(name: string, message: string, fix?: string): void {
  results.push({ name, status: 'error', message, fix });
}

// ---- Check functions ----

function checkNodeVersion(): void {
  const version = process.versions.node;
  const parts = version.split('.').map(Number);

  // Compare semver: parts vs MIN_NODE_VERSION
  for (let i = 0; i < 3; i++) {
    if ((parts[i] ?? 0) > (MIN_NODE_VERSION[i] ?? 0)) {
      ok('Node.js', `v${version} (>= ${MIN_NODE_VERSION.join('.')})`);
      return;
    }
    if ((parts[i] ?? 0) < (MIN_NODE_VERSION[i] ?? 0)) {
      fail(
        'Node.js',
        `v${version} is below minimum v${MIN_NODE_VERSION.join('.')}`,
        'Upgrade Node.js: https://nodejs.org/ or use nvm/fnm',
      );
      return;
    }
  }

  ok('Node.js', `v${version} (>= ${MIN_NODE_VERSION.join('.')})`);
}

function checkTsx(): void {
  try {
    execSync(`${REQUIRED_CMD} --version`, { stdio: 'pipe' });
    ok(REQUIRED_CMD, `found`);
  } catch {
    fail(
      REQUIRED_CMD,
      'not found in PATH',
      'Install: npm install -g tsx',
    );
  }
}

async function checkFlockAvailability(): Promise<void> {
  // Node 20.12+ exposes fs.flock
  try {
    const fsPromises = await import('node:fs/promises');
    if (typeof fsPromises.flock === 'function') {
      ok('fs.flock', 'available (file locking enabled)');
    } else {
      warn(
        'fs.flock',
        'not available — file locking will be disabled (low concurrency risk)',
        'Upgrade Node.js to v20.12+ for full locking support',
      );
    }
  } catch {
    warn(
      'fs.flock',
      'not available — file locking will be disabled (low concurrency risk)',
      'Upgrade Node.js to v20.12+ for full locking support',
    );
  }
}

async function checkChatDir(): Promise<void> {
  const chatDir = resolve(CHAT_DIR);

  try {
    await access(chatDir, constants.W_OK);
    ok('Chat directory', `${chatDir} is writable`);
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      // Try to create it
      try {
        await mkdir(chatDir, { recursive: true });
        ok('Chat directory', `${chatDir} created`);
      } catch {
        fail(
          'Chat directory',
          `${chatDir} does not exist and cannot be created`,
          `Run: mkdir -p ${chatDir}`,
        );
      }
    } else {
      fail(
        'Chat directory',
        `${chatDir} is not writable`,
        `Check permissions: ls -la ${resolve(chatDir, '..')}`,
      );
    }
  }
}

// ---- Main ----

async function main() {
  console.log('🔍 Chat Skill Dependency Check\n');

  // Sync checks
  checkNodeVersion();
  checkTsx();

  // Async checks
  await checkFlockAvailability();
  await checkChatDir();

  // ---- Report ----
  console.log('─'.repeat(50));

  const errors = results.filter((r) => r.status === 'error');
  const warnings = results.filter((r) => r.status === 'warn');

  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌';
    console.log(`${icon} ${r.name}: ${r.message}`);
    if (r.fix) {
      console.log(`   → ${r.fix}`);
    }
  }

  console.log('');

  if (errors.length > 0) {
    console.error(`❌ ${errors.length} error(s) found. Chat Skill may not work correctly.`);
    console.error('');
    console.error('Fix the above errors, then re-run this check.');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log(`⚠️  ${warnings.length} warning(s). Chat Skill will work with reduced functionality.`);
    console.log(`   File locking is degraded — concurrent access may have race conditions.`);
  } else {
    console.log('✅ All dependencies satisfied. Chat Skill is ready to use.');
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
