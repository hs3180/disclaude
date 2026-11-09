/** Durable per-chat agent selections recorded by `/agent use` (#5476). */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AgentSelection {
  chatId: string;
  presetName: string;
  updatedBy: string;
  updatedAt: string;
}

interface AgentSelectionDocument { version: 1; selections: Record<string, AgentSelection> }

function validSelection(value: AgentSelection, chatId: string): boolean {
  return value !== null && typeof value === 'object' && value.chatId === chatId
    && typeof value.presetName === 'string' && !!value.presetName.trim()
    && typeof value.updatedBy === 'string' && !!value.updatedBy.trim()
    && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt));
}

/**
 * Synchronous, owner-only and atomic so pool lookup stays synchronous per
 * message. Persisted as `<workspace>/.disclaude/agent-selections.json`; a
 * corrupt or unreadable document is fatal at startup instead of silently
 * dropping the users' saved switches.
 */
export class AgentSelectionStore {
  private readonly selections: Record<string, AgentSelection>;

  constructor(readonly filePath: string) {
    let document: AgentSelectionDocument = { version: 1, selections: {} };
    try {
      if (statSync(filePath).size > 1024 * 1024) { throw new Error('too large'); }
      chmodSync(filePath, 0o600);
      document = JSON.parse(readFileSync(filePath, 'utf8')) as AgentSelectionDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot read agent selections at ${filePath}`);
      }
    }
    if (document.version !== 1 || !document.selections || typeof document.selections !== 'object'
      || Array.isArray(document.selections)
      || !Object.entries(document.selections).every(([chatId, selection]) => validSelection(selection, chatId))) {
      throw new Error(`Invalid agent selections at ${filePath}`);
    }
    this.selections = document.selections;
  }

  get(chatId: string): AgentSelection | undefined {
    const selection = this.selections[chatId];
    return selection ? { ...selection } : undefined;
  }

  set(chatId: string, presetName: string, actorId: string): AgentSelection {
    const previous = this.selections[chatId];
    const selection = { chatId, presetName, updatedBy: actorId, updatedAt: new Date().toISOString() };
    this.selections[chatId] = selection;
    try { this.write(); } catch (error) {
      if (previous) { this.selections[chatId] = previous; } else { delete this.selections[chatId]; }
      throw error;
    }
    return { ...selection };
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${dirname(this.filePath)}/.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, selections: this.selections }), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.filePath);
    } finally { rmSync(temp, { force: true }); }
  }
}
