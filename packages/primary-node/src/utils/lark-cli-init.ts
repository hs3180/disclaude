/**
 * Auto-configure lark-cli authentication from disclaude.config.yaml.
 *
 * Reads Feishu credentials (appId / appSecret) from the loaded config
 * and initialises the lark-cli config store so that skills and components
 * which shell out to `lark-cli` (dissolve-group, lark-docs, pr-scanner,
 * message-handler resource-download, bot-chat-mapping self-heal…) work
 * without manual setup.
 *
 * Issue #3987
 * @module primary-node/utils/lark-cli-init
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { Logger } from 'pino';

/**
 * Initialise lark-cli with Feishu app credentials.
 *
 * Strategy:
 *  1. If lark-cli binary is not found, skip silently (not installed).
 *  2. If appId or appSecret is missing from config, warn and skip.
 *  3. If lark-cli config already has a matching appId, skip (idempotent).
 *  4. Otherwise run `lark-cli config init --app-id <id> --app-secret-stdin`.
 *
 * @param appId     Feishu application ID from config
 * @param appSecret Feishu application secret from config
 * @param logger    Logger instance
 */
export function initLarkCliAuth(
  appId: string,
  appSecret: string,
  logger: Logger,
): void {
  if (!appId || !appSecret) {
    logger.warn('Feishu appId/appSecret not configured — skipping lark-cli auth init');
    return;
  }

  // Resolve lark-cli binary — check global install paths and PATH
  const bin = findLarkCliBin();
  if (!bin) {
    logger.info('lark-cli binary not found — skipping auth init');
    return;
  }

  // Check if already configured with the same appId (idempotent)
  const configDir = process.env.LARK_CLI_CONFIG_DIR || path.join(homedir(), '.lark-cli');
  const configFile = path.join(configDir, 'config.json');
  try {
    if (fs.existsSync(configFile)) {
      const existing = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      if (existing?.appId === appId) {
        logger.info({ configPath: configFile }, 'lark-cli already configured with matching appId — skipping');
        return;
      }
    }
  } catch {
    // Config file unreadable — proceed with init
  }

  // Run lark-cli config init
  try {
    execFileSync(bin, ['config', 'init', '--app-id', appId, '--app-secret-stdin'], {
      input: appSecret,
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    logger.info({ appId }, 'lark-cli auth configured successfully');
  } catch (err: unknown) {
    const error = err as Error & { stderr?: Buffer };
    const stderr = error.stderr?.toString() || '';
    const message = error.message || '';
    logger.warn({ err: message, stderr }, 'lark-cli config init failed — skills using lark-cli may not work');
  }
}

/**
 * Find the lark-cli binary.
 * Checks PATH first, then common global install locations.
 */
function findLarkCliBin(): string | null {
  const candidates = ['lark-cli'];

  // npm global bin on Alpine/Linux
  candidates.push('/usr/local/bin/lark-cli');
  candidates.push('/usr/bin/lark-cli');

  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe', encoding: 'utf-8', timeout: 5_000 });
      return bin;
    } catch {
      continue;
    }
  }

  return null;
}
