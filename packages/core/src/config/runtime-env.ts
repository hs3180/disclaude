/**
 * Allowlisted short-lived derived credentials in a trusted workspace (#4918).
 * GH_TOKEN requires GH_TOKEN_EXPIRES_AT (ISO 8601, at most one hour ahead).
 * Expired/missing expiry and unregistered keys are never injected into agents.
 * Ordinary configuration belongs in config.env. Original card inputs must not
 * be persisted here. Writers are single-owner; replacements are atomic/0600.
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import { readRuntimeFile, writeRuntimeFile } from './runtime-env-file.js';

const logger = createLogger('RuntimeEnv');

const FILENAME = '.runtime-env';
const ALLOWED_KEYS = new Set(['GH_TOKEN', 'GH_TOKEN_EXPIRES_AT', 'GH_INSTALLATION_ID', 'GH_REPO']);
const MAX_TTL_MS = 60 * 60 * 1000;

function validExpiry(value: string | undefined, now: number): boolean {
  const expiry = value ? Date.parse(value) : NaN;
  return Number.isFinite(expiry) && expiry > now && expiry <= now + MAX_TTL_MS;
}

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
function readValues(workspaceDir: string): Record<string, string> {
  const filePath = path.join(workspaceDir, FILENAME);

  try {
    const content = readRuntimeFile(filePath);
    const env: Record<string, string> = Object.create(null) as Record<string, string>;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) { continue; }
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        env[trimmed.slice(0, eqIndex).trim()] = unquoteValue(trimmed.slice(eqIndex + 1).trim());
      }
    }

    if (Object.keys(env).length > 0) {
      logger.debug({ keys: Object.keys(env) }, 'Loaded runtime env vars');
    }
    return env;
  } catch {
    throw new Error('Cannot safely read runtime environment file');
  }
}

/** Invalid credentials are deterministically excluded, even for legacy files. */
export function loadRuntimeEnv(workspaceDir: string, now = Date.now()): Record<string, string> {
  try {
    const values = readValues(workspaceDir);
    if (!validExpiry(values.GH_TOKEN_EXPIRES_AT, now) || !values.GH_TOKEN) {return {};}
    return Object.fromEntries(Object.entries(values).filter(([key]) => ALLOWED_KEYS.has(key)));
  } catch {return {};}
}

/**
 * Write a runtime env var to the workspace file.
 * Creates or appends to `.runtime-env` in the workspace directory.
 * Thread-safe for single-writer scenarios.
 */
export function setRuntimeEnv(workspaceDir: string, key: string, value: string, options: { expiresAt?: string } = {}): void {
  const filePath = path.join(workspaceDir, FILENAME);
  const existing = readValues(workspaceDir);
  if (!ALLOWED_KEYS.has(key) || /[\r\n\0]/.test(value)) {throw new Error('Invalid runtime environment entry');}
  if (key === 'GH_TOKEN') {
    if (!value || !validExpiry(options.expiresAt, Date.now())) {throw new Error('A future credential expiry within one hour is required');}
    existing.GH_TOKEN_EXPIRES_AT = options.expiresAt as string;
  }
  if (key === 'GH_TOKEN_EXPIRES_AT' && !validExpiry(value, Date.now())) {throw new Error('Invalid credential expiry');}
  existing[key] = value;

  const lines = Object.entries(existing).map(([k, v]) => `${k}=${quoteValue(v)}`);
  writeRuntimeFile(filePath, `${lines.join('\n')}\n`);

  logger.debug({ key }, 'Set runtime env var');
}

/**
 * Delete a runtime env var from the workspace file.
 */
export function deleteRuntimeEnv(workspaceDir: string, key: string): void {
  const existing = readValues(workspaceDir);
  if (!(key in existing)) { return; }

  delete existing[key];
  if (key === 'GH_TOKEN') {delete existing.GH_TOKEN_EXPIRES_AT;}
  const filePath = path.join(workspaceDir, FILENAME);

  if (Object.keys(existing).length === 0) {
    fs.rmSync(filePath, { force: true });
  } else {
    const lines = Object.entries(existing).map(([k, v]) => `${k}=${quoteValue(v)}`);
    writeRuntimeFile(filePath, `${lines.join('\n')}\n`);
  }

  logger.debug({ key }, 'Deleted runtime env var');
}
