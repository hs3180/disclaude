#!/usr/bin/env tsx
/**
 * chat/check-deps.ts — Verify Chat Skill runtime dependencies.
 *
 * Checks that all required tools and runtime versions are available
 * for running the Chat Skill scripts (create, query, list, response).
 *
 * Exit codes:
 *   0 — all dependencies satisfied
 *   1 — one or more required dependencies missing
 */

import { access, constants } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const MIN_NODE_VERSION = [20, 12, 0]; // fs.flock requires Node 20.12+
const RECOMMENDED_NODE_VERSION = [22, 0, 0];

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_DIR = resolve(__dirname, '../../workspace/chats');

// ---- Types ----

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  fix?: string;
}

// ---- Helpers ----

function parseNodeVersion(version: string): number[] {
  const match = version.match(/^v(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function formatVersion(v: number[]): string {
  return `v${v[0]}.${v[1]}.${v[2]}`;
}

// ---- Checks ----

async function checkNodeVersion(): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync('node', ['--version'], {
      timeout: 5000,
    });
    const version = stdout.trim();
    const parsed = parseNodeVersion(version);

    if (compareVersions(parsed, MIN_NODE_VERSION) < 0) {
      return {
        name: 'Node.js',
        status: 'error',
        message: `${version} found — minimum ${formatVersion(MIN_NODE_VERSION)} required (fs.flock for file locking)`,
        fix: 'Upgrade Node.js: https://nodejs.org/',
      };
    }

    if (compareVersions(parsed, RECOMMENDED_NODE_VERSION) < 0) {
      return {
        name: 'Node.js',
        status: 'warn',
        message: `${version} found — ${formatVersion(RECOMMENDED_NODE_VERSION)}+ recommended for stable fs.flock support`,
      };
    }

    return {
      name: 'Node.js',
      status: 'ok',
      message: `${version} (${formatVersion(MIN_NODE_VERSION)}+ required, ✅ meets requirement)`,
    };
  } catch {
    return {
      name: 'Node.js',
      status: 'error',
      message: 'not found',
      fix: 'Install Node.js: https://nodejs.org/',
    };
  }
}

async function checkNpx(): Promise<CheckResult> {
  try {
    await execFileAsync('npx', ['--version'], { timeout: 5000 });
    return {
      name: 'npx',
      status: 'ok',
      message: 'available',
    };
  } catch {
    return {
      name: 'npx',
      status: 'error',
      message: 'not found (required to run TypeScript scripts via tsx)',
      fix: 'Install npm (includes npx): https://nodejs.org/',
    };
  }
}

async function checkTsx(): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync('npx', ['tsx', '--version'], {
      timeout: 15000,
    });
    const version = stdout.trim().split('\n')[0];
    return {
      name: 'tsx',
      status: 'ok',
      message: version,
    };
  } catch {
    return {
      name: 'tsx',
      status: 'error',
      message: 'not found (required to run TypeScript scripts)',
      fix: 'Install tsx: npm install -g tsx  (or add to project: npm install --save-dev tsx)',
    };
  }
}

async function checkChatDir(): Promise<CheckResult> {
  try {
    await access(CHAT_DIR, constants.W_OK);
    return {
      name: 'Chat directory',
      status: 'ok',
      message: `${CHAT_DIR} (read/write OK)`,
    };
  } catch {
    // Directory doesn't exist yet — not an error, it will be created on first use
    try {
      const parentDir = dirname(CHAT_DIR);
      await access(parentDir, constants.W_OK);
      return {
        name: 'Chat directory',
        status: 'ok',
        message: `${CHAT_DIR} does not exist yet (will be created on first use)`,
      };
    } catch {
      return {
        name: 'Chat directory',
        status: 'error',
        message: `parent directory ${dirname(CHAT_DIR)} is not writable`,
        fix: 'Ensure workspace directory exists and is writable',
      };
    }
  }
}

async function checkFileLocking(): Promise<CheckResult> {
  try {
    // Dynamic import to check fs.flock availability
    const fsPromises = await import('node:fs/promises');
    if (typeof (fsPromises as Record<string, unknown>).flock === 'function') {
      return {
        name: 'File locking (fs.flock)',
        status: 'ok',
        message: 'available (exclusive + shared advisory locks)',
      };
    }
    return {
      name: 'File locking (fs.flock)',
      status: 'warn',
      message: 'not available — scripts will run without file locking (acceptable for low-concurrency CLI use)',
      fix: 'Upgrade to Node.js 20.12+ for file locking support',
    };
  } catch {
    return {
      name: 'File locking (fs.flock)',
      status: 'warn',
      message: 'not available — scripts will run without file locking',
      fix: 'Upgrade to Node.js 20.12+ for file locking support',
    };
  }
}

// ---- Main ----

async function main() {
  console.log('Checking Chat Skill dependencies...\n');

  const results: CheckResult[] = [
    await checkNodeVersion(),
    await checkNpx(),
    await checkTsx(),
    await checkFileLocking(),
    await checkChatDir(),
  ];

  let errors = 0;
  let warnings = 0;

  for (const result of results) {
    const icon = result.status === 'ok' ? '✅' : result.status === 'warn' ? '⚠️' : '❌';
    console.log(`${icon} ${result.name}: ${result.message}`);
    if (result.fix) {
      console.log(`   Fix: ${result.fix}`);
    }
    if (result.status === 'error') errors++;
    if (result.status === 'warn') warnings++;
  }

  console.log('');
  if (errors > 0) {
    console.error(`❌ ${errors} required dependenc${errors === 1 ? 'y' : 'ies'} missing. Please install them before using Chat Skill.`);
    process.exit(1);
  }

  if (warnings > 0) {
    console.log(`⚠️  All required dependencies satisfied (${warnings} warning${warnings === 1 ? '' : 's'}).`);
  } else {
    console.log('✅ All dependencies satisfied.');
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
