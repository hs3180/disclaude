/**
 * File-based Runtime Environment Variables (Issue #1361)
 *
 * Reads runtime env vars from `{workspace}/.runtime-env` file.
 * Format: simple KEY=VALUE per line, # comments, blank lines ignored.
 *
 * Why file-based? Agent runs in an SDK subprocess — in-memory singletons
 * in the main process are not accessible. A workspace file is readable
 * by both main process (MCP servers) and agent subprocess.
 *
 * Usage:
 *   // Main process: agent env auto-merged in createSdkOptions()
 *   // Agent: write via existing Write tool to {workspace}/.runtime-env
 *   //   GH_TOKEN=ghs_xxx
 *   //   AWS_KEY=AKIAxxx
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RuntimeEnv');

const FILENAME = '.runtime-env';

/**
 * Load runtime env vars from workspace directory.
 * Returns empty object if file doesn't exist or is unreadable.
 * Handles quoted values: KEY="value with spaces" → strips surrounding quotes.
 * Only strips one layer of quotes; nested quotes like KEY=""val"" become "val".
 */
export function loadRuntimeEnv(workspaceDir: string): Record<string, string> {
  const filePath = path.join(workspaceDir, FILENAME);

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const env: Record<string, string> = {};

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) { continue; }
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        let val = trimmed.slice(eqIndex + 1).trim();
        // Strip one layer of surrounding double or single quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[trimmed.slice(0, eqIndex).trim()] = val;
      }
    }

    if (Object.keys(env).length > 0) {
      logger.debug({ keys: Object.keys(env) }, 'Loaded runtime env vars');
    }
    return env;
  } catch {
    return {};
  }
}

/**
 * Write a runtime env var to the workspace file.
 * Creates or appends to `.runtime-env` in the workspace directory.
 * Thread-safe for single-writer scenarios.
 * Values containing spaces are wrapped in double quotes to preserve round-trip integrity.
 */
export function setRuntimeEnv(workspaceDir: string, key: string, value: string): void {
  const filePath = path.join(workspaceDir, FILENAME);
  const existing = loadRuntimeEnv(workspaceDir);
  existing[key] = value;

  const lines = Object.entries(existing).map(([k, v]) => v.includes(' ') ? `${k}="${v}"` : `${k}=${v}`);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');

  logger.debug({ key }, 'Set runtime env var');
}

/**
 * Delete a runtime env var from the workspace file.
 */
export function deleteRuntimeEnv(workspaceDir: string, key: string): void {
  const existing = loadRuntimeEnv(workspaceDir);
  if (!(key in existing)) { return; }

  delete existing[key];
  const filePath = path.join(workspaceDir, FILENAME);

  if (Object.keys(existing).length === 0) {
    fs.rmSync(filePath, { force: true });
  } else {
    const lines = Object.entries(existing).map(([k, v]) => v.includes(' ') ? `${k}="${v}"` : `${k}=${v}`);
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');
  }

  logger.debug({ key }, 'Deleted runtime env var');
}
