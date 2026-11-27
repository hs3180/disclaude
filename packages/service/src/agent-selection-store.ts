/** Durable per-chat agent selections recorded by `/agent use` (#5476). */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isReasoningEffort, type ReasoningEffort } from '@disclaude/core';

/**
 * Creation-time overrides stored alongside a preset binding (#4913): an
 * explicit {harness, model, reasoningEffort} declaration uses an internal
 * credential/store base, overriding model/effort for this chat.
 */
export interface AgentSelectionOverrides {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface AgentSelection {
  chatId: string;
  presetName: string;
  updatedBy: string;
  updatedAt: string;
  /** Present only when this chat's binding comes from a creation-time runtime
   * declaration (#4913). It is the chat-level runtime configuration, not a
   * field of the active runtime; a later `/agent use` replaces the record and
   * drops it, which is what makes the command win over the declaration. */
  declared?: AgentSelectionOverrides;
}

interface AgentSelectionDocument { version: 1; selections: Record<string, AgentSelection> }

function validSelection(value: AgentSelection, chatId: string): boolean {
  if (value === null || typeof value !== 'object' || value.chatId !== chatId
    || typeof value.presetName !== 'string' || !value.presetName.trim()
    || typeof value.updatedBy !== 'string' || !value.updatedBy.trim()
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    return false;
  }
  if (value.declared !== undefined) {
    const { model, reasoningEffort } = value.declared;
    if (typeof value.declared !== 'object' || value.declared === null
      || (model !== undefined && (typeof model !== 'string' || !model.trim()))
      || (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort))) {
      return false;
    }
  }
  return true;
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

  set(chatId: string, presetName: string, actorId: string, extras: { declared?: AgentSelectionOverrides } = {}): AgentSelection {
    const previous = this.selections[chatId];
    const selection: AgentSelection = {
      chatId,
      presetName,
      updatedBy: actorId,
      updatedAt: new Date().toISOString(),
      ...(extras.declared ? { declared: { ...extras.declared } } : {}),
    };
    this.selections[chatId] = selection;
    try { this.write(); } catch (error) {
      if (previous) { this.selections[chatId] = previous; } else { delete this.selections[chatId]; }
      throw error;
    }
    return { ...selection, ...(selection.declared ? { declared: { ...selection.declared } } : {}) };
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
