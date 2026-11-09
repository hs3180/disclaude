/**
 * Research output document watch registry (T-089 / #5197).
 *
 * Maps Feishu documents that were explicitly delivered as research output back
 * to the Project chat that produced them, so the doc comment monitor only ever
 * polls documents a Research context has registered. No directory of unrelated
 * documents is ever scanned: a document is polled if and only if a
 * `docs/<docToken>.json` registration file exists.
 *
 * Registration is file-based on purpose: the research-workflow skill runs inside
 * an agent with workspace write access, so it can register a document the moment
 * it delivers the report — same pattern as `schedules/<slug>/SCHEDULE.md`.
 * Registrations are per-document files so concurrent agents never fight over a
 * shared JSON document.
 *
 * Persistence layout under `{workspace}/.disclaude/research-doc-watch/`:
 * - `docs/<docToken>.json` — registration (agent/program writable, atomic write)
 * - `state.json`           — monitor-owned checkpoint (see doc-comment-monitor.ts)
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@disclaude/core';

const logger = createLogger('ResearchDocWatchRegistry');

/** Document tokens are opaque Feishu tokens; restrict to a safe filename charset. */
const DOC_TOKEN_PATTERN = /^[A-Za-z0-9]{1,255}$/;
/** chatId pattern mirrors the schedule frontmatter guard (`isSafeChatId`). */
const CHAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
/** Upper bound so a runaway writer cannot create unbounded polling load. */
const DEFAULT_MAX_REGISTRATIONS = 128;

/** Which identity comment reads act as. `user` keeps the reads inside the
 * current user's document permissions instead of the app's. */
export type DocWatchIdentity = 'user' | 'bot';

/** One registered research output document → Project mapping. */
export interface ResearchDocWatchRegistration {
  /** Feishu drive file token of the delivered research document (docx). */
  docToken: string;
  /** Drive file type passed to comment listing. Only `docx` is exercised;
   * other values are passed through unverified (real API surface unknown). */
  docType: string;
  /** Project chat that owns the research context; comment notifications are
   * routed to this chat's agent. */
  chatId: string;
  /** Optional human label for the research project/report. */
  projectName?: string;
  /** Optional open_id of the user the registration was made for. */
  registeredBy?: string;
  /** ISO timestamp of registration. */
  registeredAt: string;
  /** Identity used when reading comments of this document. */
  identity: DocWatchIdentity;
}

export interface ResearchDocWatchRegistryOptions {
  /** Directory holding `docs/` and `state.json` (`.disclaude/research-doc-watch`). */
  watchDir: string;
  /** Maximum simultaneous registrations (default 128). */
  maxRegistrations?: number;
}

export type RegistryResult<T> = { ok: true; data: T } | { ok: false; error: string };

function isRegistration(value: unknown): value is ResearchDocWatchRegistration {
  if (typeof value !== 'object' || value === null) { return false; }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.docToken !== 'string' || !DOC_TOKEN_PATTERN.test(candidate.docToken)) { return false; }
  if (typeof candidate.docType !== 'string' || candidate.docType.length === 0) { return false; }
  if (typeof candidate.chatId !== 'string' || !CHAT_ID_PATTERN.test(candidate.chatId)) { return false; }
  if (typeof candidate.registeredAt !== 'string' || !Number.isFinite(Date.parse(candidate.registeredAt))) { return false; }
  if (candidate.identity !== 'user' && candidate.identity !== 'bot') { return false; }
  if (candidate.projectName !== undefined &&
      (typeof candidate.projectName !== 'string' || candidate.projectName.length > 512)) { return false; }
  if (candidate.registeredBy !== undefined &&
      (typeof candidate.registeredBy !== 'string' || candidate.registeredBy.length > 128)) { return false; }
  return true;
}

/**
 * Registry of research output documents to watch for comments.
 *
 * Construction is cheap and stateless across calls; `list()` re-reads the
 * registration directory so externally written registrations (agents) are
 * picked up without a restart. Invalid files are skipped with a warning —
 * a malformed agent-written file must never take the monitor down — while
 * `register()` itself validates strictly and refuses to write bad entries.
 */
export class ResearchDocWatchRegistry {
  private readonly docsDir: string;
  private readonly maxRegistrations: number;

  constructor(options: ResearchDocWatchRegistryOptions) {
    this.docsDir = join(options.watchDir, 'docs');
    this.maxRegistrations = options.maxRegistrations ?? DEFAULT_MAX_REGISTRATIONS;
  }

  /** Register (or overwrite) the mapping for a document. Explicit opt-in only. */
  async register(entry: ResearchDocWatchRegistration): Promise<RegistryResult<ResearchDocWatchRegistration>> {
    if (!isRegistration(entry)) {
      return { ok: false, error: '登记项无效:docToken/chatId/identity/registeredAt 必须符合约束' };
    }
    try {
      await mkdir(this.docsDir, { recursive: true });
      const existing = await this.listFileNames();
      if (!existing.includes(`${entry.docToken}.json`) && existing.length >= this.maxRegistrations) {
        return { ok: false, error: `监控登记数已达上限 ${this.maxRegistrations},先取消不需要的文档` };
      }
      const target = join(this.docsDir, `${entry.docToken}.json`);
      const tmp = `${target}.tmp`;
      await writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8');
      await rename(tmp, target);
      logger.info({ docToken: entry.docToken, chatId: entry.chatId }, 'Research doc watch registered');
      return { ok: true, data: entry };
    } catch (error) {
      logger.error({ err: error, docToken: entry.docToken }, 'Research doc watch registration write failed');
      return { ok: false, error: `登记写入失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Remove a registration. The monitor stops polling the document on its next tick. */
  async unregister(docToken: string): Promise<boolean> {
    if (!DOC_TOKEN_PATTERN.test(docToken)) { return false; }
    try {
      await rm(join(this.docsDir, `${docToken}.json`), { force: true });
      logger.info({ docToken }, 'Research doc watch unregistered');
      return true;
    } catch (error) {
      logger.error({ err: error, docToken }, 'Research doc watch unregister failed');
      return false;
    }
  }

  /** Single registration lookup. */
  async get(docToken: string): Promise<ResearchDocWatchRegistration | undefined> {
    if (!DOC_TOKEN_PATTERN.test(docToken)) { return undefined; }
    try {
      return await this.parseFile(join(this.docsDir, `${docToken}.json`));
    } catch {
      return undefined;
    }
  }

  /**
   * All valid registrations (invalid files skipped with a warning). This is the
   * only document set the monitor ever polls.
   */
  async list(): Promise<ResearchDocWatchRegistration[]> {
    const names = await this.listFileNames();
    const registrations: ResearchDocWatchRegistration[] = [];
    for (const name of names) {
      const parsed = await this.parseFile(join(this.docsDir, name)).catch(() => undefined);
      if (parsed) { registrations.push(parsed); }
    }
    registrations.sort((a, b) => a.docToken.localeCompare(b.docToken));
    return registrations;
  }

  private async listFileNames(): Promise<string[]> {
    try {
      const entries = await readdir(this.docsDir);
      return entries.filter(name => name.endsWith('.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
      throw error;
    }
  }

  private async parseFile(file: string): Promise<ResearchDocWatchRegistration | undefined> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      logger.warn({ file }, 'Research doc watch registration is not valid JSON; skipped');
      return undefined;
    }
    if (!isRegistration(value)) {
      logger.warn({ file }, 'Research doc watch registration schema invalid; skipped');
      return undefined;
    }
    return value;
  }
}
