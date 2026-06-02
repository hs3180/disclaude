/**
 * Dissolve Group - Dissolve a Feishu group chat and clean up associated resources.
 *
 * Usage:
 *   DISSOLVE_CHAT_ID="oc_xxx" npx tsx skills/dissolve-group/dissolve-group.ts
 *   DISSOLVE_KEY="pr-123" npx tsx skills/dissolve-group/dissolve-group.ts
 *
 * Environment variables:
 *   DISSOLVE_CHAT_ID       Feishu group chat ID (oc_xxx format)
 *   DISSOLVE_KEY           Mapping key (e.g. "pr-123")
 *   MAPPING_FILE           Path to mapping JSON (default: workspace/bot-chat-mapping.json)
 *   DISSOLVE_SKIP_LARK     Set to "1" to skip group dissolution (testing only)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ---- Types ----

interface MappingEntry {
  chatId: string;
  createdAt: string;
  purpose: string;
  workdir?: string;
}

interface MappingTable {
  [key: string]: MappingEntry;
}

// ---- Config ----

const MAPPING_FILE = process.env.MAPPING_FILE || 'workspace/bot-chat-mapping.json';
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
  const candidates = [
    path.join(process.env.HOME || '/root', '.local/bin/lark-cli'),
    'lark-cli',
  ];
  for (const c of candidates) {
    try {
      execSync(`${c} --version`, { stdio: 'pipe' });
      return c;
    } catch {}
  }
  die('lark-cli not found in PATH or ~/.local/bin/');
}

function dissolveGroup(larkCli: string, chatId: string): boolean {
  if (SKIP_LARK) {
    log(`SKIP_LARK=1, skipping group dissolution for ${chatId}`);
    return true;
  }

  log(`Dissolving group ${chatId} ...`);

  try {
    execSync(
      `${larkCli} api DELETE /open-apis/im/v1/chats/${chatId} --as bot`,
      { stdio: 'pipe', encoding: 'utf-8' },
    );
    log(`Group dissolved: ${chatId}`);
    return true;
  } catch (e: any) {
    const stdout = e.stdout?.toString() || '';
    const stderr = e.stderr?.toString() || '';
    const output = stdout + stderr;
    // 232009 = already dissolved, 99991672 = chat not exist — idempotent, OK
    if (
      output.includes('"code":99991672') ||
      output.includes('"code":232009') ||
      output.includes('chat_not_exist') ||
      output.includes('already been dissolved')
    ) {
      log(`Group already dissolved or not found: ${chatId} (idempotent, OK)`);
      return true;
    }
    log(`Failed to dissolve group: ${stderr || stdout || e.message}`);
    return false;
  }
}

function cleanupWorkdir(workdir: string | undefined): void {
  if (!workdir) return;
  if (!workdir.startsWith('/tmp/')) {
    log(`Skipping workdir cleanup (not in /tmp): ${workdir}`);
    return;
  }
  try {
    fs.rmSync(workdir, { recursive: true, force: true });
    log(`Cleaned up workdir: ${workdir}`);
  } catch (e: any) {
    log(`Failed to cleanup workdir ${workdir}: ${e.message}`);
  }
}

// ---- Main ----

function main() {
  const chatId = process.env.DISSOLVE_CHAT_ID;
  const key = process.env.DISSOLVE_KEY;

  if (!chatId && !key) {
    die('Provide DISSOLVE_CHAT_ID or DISSOLVE_KEY');
  }

  if (chatId && !chatId.startsWith('oc_')) {
    die(`Invalid chatId format: ${chatId} (expected oc_xxx)`);
  }

  const table = readMapping();

  let resolvedKey = key;
  let resolvedChatId = chatId;
  let resolvedWorkdir: string | undefined;

  if (key) {
    const entry = table[key];
    if (!entry) {
      die(`Mapping key not found: ${key}`);
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

  // Step 1: Dissolve group
  const larkCli = findLarkCli();
  const dissolved = dissolveGroup(larkCli, resolvedChatId!);

  if (!dissolved) {
    die('Group dissolution failed, not removing mapping entry (allows retry)');
  }

  // Step 2: Cleanup workdir
  cleanupWorkdir(resolvedWorkdir);

  // Step 3: Remove mapping entry
  if (resolvedKey && resolvedKey in table) {
    delete table[resolvedKey];
    writeMapping(table);
    log(`Removed mapping entry: ${resolvedKey}`);
  }

  const summary: Record<string, string> = {
    chatId: resolvedChatId || 'N/A',
    key: resolvedKey || 'N/A',
    dissolved: 'yes',
    workdir: resolvedWorkdir ? 'cleaned' : 'none',
    mapping: resolvedKey ? 'removed' : 'none',
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
