#!/usr/bin/env tsx
/**
 * chat/check-deps.ts — Check and report Chat Skill runtime dependencies.
 *
 * Verifies that all required tools and runtime versions are available
 * before running Chat Skill scripts. Run this on first use or when
 * troubleshooting script failures.
 *
 * Usage:
 *   npx tsx scripts/chat/check-deps.ts
 *
 * Exit codes:
 *   0 — all dependencies satisfied (warnings allowed)
 *   1 — missing required dependency
 */

import { access, constants, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { CHAT_DIR } from './schema.js';

// ---- Types ----

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  fix?: string;
}

// ---- Helpers ----

function nodeVersion(): { major: number; minor: number; patch: number } {
  const match = process.version.match(/^v(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return { major: 0, minor: 0, patch: 0 };
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

function tryCommand(cmd: string): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    }).trim();
    return { success: true, output };
  } catch {
    return { success: false, output: '' };
  }
}

// ---- Checks ----

function checkNodeVersion(): CheckResult {
  const v = nodeVersion();
  const version = `v${v.major}.${v.minor}.${v.patch}`;

  if (v.major < 18) {
    return {
      name: 'Node.js',
      status: 'error',
      message: `${version} — requires >= 18.0.0`,
      fix: 'Install Node.js 18+ from https://nodejs.org/',
    };
  }

  // 20.12+ recommended for fs.flock
  const hasFlock = v.major > 20 || (v.major === 20 && v.minor >= 12);
  if (!hasFlock) {
    return {
      name: 'Node.js',
      status: 'warn',
      message: `${version} — file locking (fs.flock) not available (requires >= 20.12.0). Scripts will work but without concurrency safety.`,
      fix: 'Upgrade to Node.js 20.12+ for file locking support.',
    };
  }

  return {
    name: 'Node.js',
    status: 'ok',
    message: `${version} (file locking supported)`,
  };
}

function checkTsx(): CheckResult {
  const result = tryCommand('npx tsx --version');
  if (result.success) {
    return {
      name: 'tsx',
      status: 'ok',
      message: result.output,
    };
  }

  return {
    name: 'tsx',
    status: 'error',
    message: 'not found — required to run TypeScript chat scripts',
    fix: 'Install tsx: npm install -D tsx',
  };
}

async function checkChatDir(): Promise<CheckResult> {
  const chatDir = resolve(CHAT_DIR);
  try {
    // Check if directory exists and is writable
    await access(chatDir, constants.W_OK | constants.R_OK);
    return {
      name: 'Chat directory',
      status: 'ok',
      message: `${chatDir} (readable + writable)`,
    };
  } catch {
    // Try to create it
    try {
      await mkdir(chatDir, { recursive: true });
      return {
        name: 'Chat directory',
        status: 'ok',
        message: `${chatDir} (created)`,
      };
    } catch {
      return {
        name: 'Chat directory',
        status: 'error',
        message: `${chatDir} — not accessible and cannot be created`,
        fix: `Create the directory manually: mkdir -p ${chatDir}`,
      };
    }
  }
}

// ---- Main ----

async function main() {
  const results: CheckResult[] = [];

  results.push(checkNodeVersion());
  results.push(checkTsx());
  results.push(await checkChatDir());

  // Print results
  const errors: CheckResult[] = [];
  const warnings: CheckResult[] = [];

  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌';
    console.log(`${icon} ${r.name}: ${r.message}`);
    if (r.status === 'error') errors.push(r);
    if (r.status === 'warn') warnings.push(r);
  }

  // Print fix suggestions
  if (errors.length > 0) {
    console.error('');
    console.error(`❌ ${errors.length} required dependency(ies) missing. Fix:`);
    for (const e of errors) {
      console.error(`  • ${e.name}: ${e.fix}`);
    }
  }

  if (warnings.length > 0) {
    console.error('');
    console.error(`⚠️  ${warnings.length} warning(s):`);
    for (const w of warnings) {
      console.error(`  • ${w.name}: ${w.fix}`);
    }
  }

  if (errors.length === 0) {
    console.log('');
    console.log(`✅ All dependencies satisfied (${warnings.length} warning(s))`);
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
