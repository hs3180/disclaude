/**
 * File-based Runtime Environment Variables (Issue #1361)
 *
 * Reads runtime env vars from `{workspace}/.runtime-env` file.
 * Format: simple KEY=VALUE per line, # comments, blank lines ignored.
 * Values may be quoted with single or double quotes; escaped quotes are unescaped.
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
import { readRuntimeFile, writeRuntimeFile } from './runtime-env-file.js';

const logger = createLogger('RuntimeEnv');

// These variables alter executable loading, injected startup code or trust /
// proxy settings. Credential names and business permissions remain agent policy.
const PROCESS_CONTROL = /^(?:PATH|SHELL|ENV|BASH_ENV|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|RUBYOPT|PERL5OPT|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|GIT_SSH_COMMAND|GIT_CONFIG.*|LD_.*|DYLD_.*|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i;
const EXPIRY_SUFFIX = '_EXPIRES_AT';
function acceptsRuntimeKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !PROCESS_CONTROL.test(key);
}

const FILENAME = '.runtime-env';

/**
 * Strip surrounding quotes and unescape internal escaped quotes from an env value.
 */
function unquoteValue(val: string): string {
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
    if (val.includes('\\"')) { val = val.replace(/\\"/g, '"'); }
    if (val.includes("\\'")) { val = val.replace(/\\'/g, "'"); }
  }
  return val;
}

/**
 * Quote an env value if it contains spaces or double-quotes, escaping as needed.
 */
function quoteValue(val: string): string {
  if (val.includes(' ') || val.includes('"')) {
    return `"${val.replace(/"/g, '\\"')}"`;
  }
  return val;
}

/**
 * Load runtime env vars from workspace directory.
 * Returns empty object if file doesn't exist or is unreadable.
 */
export function loadRuntimeEnv(workspaceDir: string, strict = false): Record<string, string> {
  const filePath = path.join(workspaceDir, FILENAME);

  try {
    const content = readRuntimeFile(filePath);
    const env: Record<string, string> = Object.create(null) as Record<string, string>;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) { continue; }
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        const value = unquoteValue(trimmed.slice(eqIndex + 1).trim());
        if (acceptsRuntimeKey(key) && !value.includes('\0')) {env[key] = value;}
      }
    }

    // Expiry is declared by the credential issuer/agent. Do not impose a
    // provider-specific key allowlist or a universal credential lifetime.
    for (const [key, value] of Object.entries(env)) {
      if (key.endsWith(EXPIRY_SUFFIX) && (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now())) {
        delete env[key.slice(0, -EXPIRY_SUFFIX.length)];
        delete env[key];
      }
    }
    if (Object.keys(env).length > 0) {
      logger.debug({ keys: Object.keys(env) }, 'Loaded runtime env vars');
    }
    return env;
  } catch {
    if (strict) {throw new Error('Cannot safely read runtime environment file');}
    return {};
  }
}

/**
 * Write a runtime env var to the workspace file.
 * Creates or appends to `.runtime-env` in the workspace directory.
 * Optional expiry comes from the agent/issuer; replacing a value clears its
 * previous expiry unless supplied again. Thread-safe for single-writer scenarios.
 */
export function setRuntimeEnv(workspaceDir: string, key: string, value: string, options: { expiresAt?: string } = {}): void {
  if (!acceptsRuntimeKey(key) || /[\r\n\0]/.test(value)) {throw new Error('Unsafe runtime environment entry');}
  if (options.expiresAt !== undefined && (!Number.isFinite(Date.parse(options.expiresAt)) || Date.parse(options.expiresAt) <= Date.now())) {
    throw new Error('Runtime credential expiry must be a future date');
  }
  const filePath = path.join(workspaceDir, FILENAME);
  const existing = loadRuntimeEnv(workspaceDir, true);
  existing[key] = value;
  delete existing[`${key}${EXPIRY_SUFFIX}`];
  if (options.expiresAt !== undefined) {existing[`${key}${EXPIRY_SUFFIX}`] = new Date(options.expiresAt).toISOString();}

  const lines = Object.entries(existing).map(([k, v]) => `${k}=${quoteValue(v)}`);
  writeRuntimeFile(filePath, `${lines.join('\n')}\n`);

  logger.debug({ key }, 'Set runtime env var');
}

/**
 * Delete a runtime env var from the workspace file.
 */
export function deleteRuntimeEnv(workspaceDir: string, key: string): void {
  const existing = loadRuntimeEnv(workspaceDir, true);
  if (!(key in existing)) { return; }

  delete existing[key];
  delete existing[`${key}${EXPIRY_SUFFIX}`];
  const filePath = path.join(workspaceDir, FILENAME);

  if (Object.keys(existing).length === 0) {
    fs.rmSync(filePath, { force: true });
  } else {
    const lines = Object.entries(existing).map(([k, v]) => `${k}=${quoteValue(v)}`);
    writeRuntimeFile(filePath, `${lines.join('\n')}\n`);
  }

  logger.debug({ key }, 'Deleted runtime env var');
}
