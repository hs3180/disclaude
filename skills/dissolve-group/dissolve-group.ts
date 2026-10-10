/**
 * Dissolve Group - Dissolve a Feishu group chat and clean up associated resources.
 *
 * Usage:
 *   DISSOLVE_CHAT_ID="oc_xxx" npx tsx skills/dissolve-group/dissolve-group.ts
 *   DISSOLVE_KEY="pr-123" npx tsx skills/dissolve-group/dissolve-group.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

// ---- Types ----

interface MappingEntry {
  chatId: string;
  createdAt: string;
  purpose: string;
  workdir?: string;
  /** ISO timestamp of the last inactivity reminder sent (Issue #3965) */
  lastReminderAt?: string;
}

interface MappingTable {
  [key: string]: MappingEntry;
}

// ---- Config ----

// __dirname equivalent for ESM: resolve relative to this script's location
// .claude/skills/dissolve-group/ → workspace root is ../../..
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const MAPPING_FILE = process.env.MAPPING_FILE || path.join(WORKSPACE_ROOT, 'bot-chat-mapping.json');
const SKIP_LARK = process.env.DISSOLVE_SKIP_LARK === '1';

// ---- Helpers ----

function log(msg: string) {
  console.error(`[dissolve-group] ${msg}`);
}

function die(msg: string): never {
  console.error(`[dissolve-group] ERROR: ${msg}`);
  process.exit(1);
}

function readMapping(): MappingTable {
  try {
    const content = fs.readFileSync(MAPPING_FILE, 'utf-8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch (e: any) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function writeMapping(table: MappingTable): void {
  const dir = path.dirname(MAPPING_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${MAPPING_FILE}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(table, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpFile, MAPPING_FILE);
}

function findKeyByChatId(table: MappingTable, chatId: string): string | null {
  for (const [key, entry] of Object.entries(table)) {
    if (entry.chatId === chatId) return key;
  }
  return null;
}

function findLarkCli(): string {
  // Issue #3888: lark-cli is pre-installed in Docker via @larksuite/cli
  const bin = 'lark-cli';
  try {
    const ver = execFileSync(bin, ['--version'], { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }).trim();
    log(`lark-cli found: ${ver}`);
    return bin;
  } catch {
    die('lark-cli not found or not working. Ensure @larksuite/cli is installed.');
  }
}

function dissolveGroup(larkCli: string, chatId: string): boolean {
  if (SKIP_LARK) {
    log(`SKIP_LARK=1, skipping group dissolution for ${chatId}`);
    return true;
  }

  log(`Dissolving group ${chatId} ...`);

  let stdout = '';
  let stderr = '';
  let exitedSuccessfully = true;
  try {
    stdout = execFileSync(larkCli, ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`, '--as', 'bot'],
      { stdio: 'pipe', encoding: 'utf-8', timeout: 30000 });
  } catch (e: any) {
    exitedSuccessfully = false;
    stdout = e.stdout?.toString() || '';
    stderr = e.stderr?.toString() || '';
  }

  // CLI success is {ok:true,data}; raw API success carries code:0. Errors may
  // arrive on stderr, and must be parsed rather than matched as arbitrary text.
  let response: { ok?: boolean; code?: number; error?: { code?: number }; data?: { code?: number } } | undefined;
  for (const output of [stderr, stdout]) {
    try {
      const parsed: unknown = JSON.parse(output);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
          ('ok' in parsed || 'code' in parsed || 'error' in parsed)) {
        response = parsed as NonNullable<typeof response>;
        break;
      }
    } catch { /* Unknown output cannot prove a native deletion. */ }
  }
  const code = response?.error?.code ?? response?.code ?? response?.data?.code;
  // Official DELETE: 232009 is already dissolved; 99991672 is missing scopes.
  if (code === 232009) {
    log(`Group already dissolved: ${chatId} (idempotent, OK)`);
    return true;
  }
  if (exitedSuccessfully && response && response.ok !== false && !response.error &&
      (code === undefined || code === 0) && (response.ok === true || code === 0)) {
    log(`Group dissolved: ${chatId}`);
    return true;
  }
  log(`Failed to dissolve group: ${code === undefined ? 'unverified CLI response' : `API code ${code}`}`);
  return false;
}

function cleanupWorkdir(workdir: string | undefined): 'none' | 'cleaned' | 'skipped' | 'failed' {
  if (!workdir) return 'none';
  const resolved = path.resolve(workdir);
  const tempRoot = fs.realpathSync('/tmp');
  if (!resolved.startsWith('/tmp/') && !resolved.startsWith(tempRoot + path.sep)) {
    log(`Skipping workdir cleanup (outside temporary root): ${workdir}`);
    return 'skipped';
  }
  try {
    const canonical = fs.realpathSync(resolved);
    if (!canonical.startsWith(tempRoot + path.sep)) {
      log(`Skipping workdir cleanup (resolves outside temporary root): ${workdir}`);
      return 'skipped';
    }
    fs.rmSync(resolved, { recursive: true, force: true });
    log(`Cleaned up workdir: ${workdir}`);
    return 'cleaned';
  } catch (e: any) {
    if (e.code === 'ENOENT') return 'cleaned';
    log(`Failed to cleanup workdir ${workdir}: ${e.message}`);
    return 'failed';
  }
}

// ---- Main ----

function main() {
  const chatId = process.env.DISSOLVE_CHAT_ID;
  const key = process.env.DISSOLVE_KEY;

  if (!chatId && !key) {
    die('Provide DISSOLVE_CHAT_ID or DISSOLVE_KEY');
  }

  // Validate chatId format if provided
  if (chatId && !/^oc_[A-Za-z0-9_]+$/.test(chatId)) {
    die(`Invalid chatId format: ${chatId} (expected oc_xxx)`);
  }

  // Read mapping
  const table = readMapping();

  // Resolve key ↔ chatId
  let resolvedKey: string | null | undefined = key;
  let resolvedChatId = chatId;
  let resolvedWorkdir: string | undefined;

  if (key) {
    const entry = table[key];
    if (!entry) {
      die(`Mapping key not found: ${key}`);
    }
    if (chatId && chatId !== entry.chatId) {
      die('DISSOLVE_CHAT_ID and DISSOLVE_KEY identify different groups');
    }
    resolvedChatId = entry.chatId;
    resolvedWorkdir = entry.workdir;
    log(`Resolved key=${key} → chatId=${resolvedChatId}`);
  } else if (chatId) {
    resolvedKey = findKeyByChatId(table, chatId);
    if (resolvedKey) {
      resolvedWorkdir = table[resolvedKey].workdir;
      log(`Resolved chatId=${chatId} → key=${resolvedKey}`);
    } else {
      log(`No mapping entry for chatId=${chatId}, proceeding with dissolution only`);
    }
  }

  if (!resolvedChatId || !/^oc_[A-Za-z0-9_]+$/.test(resolvedChatId)) {
    die('Invalid mapped chatId format (expected oc_xxx)');
  }

  // Step 1: Dissolve group
  const larkCli = SKIP_LARK ? '' : findLarkCli();
  const dissolved = dissolveGroup(larkCli, resolvedChatId);

  if (!dissolved) {
    die('Group dissolution failed, not removing mapping entry (allows retry)');
  }

  // Step 2: Cleanup workdir
  const workdirResult = cleanupWorkdir(resolvedWorkdir);

  // Step 3: Remove mapping entry
  if (resolvedKey && resolvedKey in table) {
    delete table[resolvedKey];
    writeMapping(table);
    log(`Removed mapping entry: ${resolvedKey}`);
  }

  // Summary
  const summary: Record<string, string> = {
    chatId: resolvedChatId || 'N/A',
    key: resolvedKey || 'N/A',
    dissolved: SKIP_LARK ? 'skipped' : 'yes',
    workdir: workdirResult,
    mapping: resolvedKey ? 'removed' : 'none',
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
