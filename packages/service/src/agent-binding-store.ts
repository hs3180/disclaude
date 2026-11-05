/** Durable administrator-owned chat -> named agent preset bindings (#5476). */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AgentBinding {
  chatId: string;
  presetName: string;
  updatedBy: string;
  updatedAt: string;
}

interface AgentBindingDocument { version: 1; bindings: Record<string, AgentBinding> }

function validBinding(value: AgentBinding, chatId: string): boolean {
  return value !== null && typeof value === 'object' && value.chatId === chatId
    && typeof value.presetName === 'string' && !!value.presetName.trim()
    && typeof value.updatedBy === 'string' && !!value.updatedBy.trim()
    && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt));
}

/** Synchronous, owner-only and atomic so pool lookup stays synchronous per message. */
export class AgentBindingStore {
  private readonly bindings: Record<string, AgentBinding>;

  constructor(readonly filePath: string) {
    let document: AgentBindingDocument = { version: 1, bindings: {} };
    try {
      if (statSync(filePath).size > 1024 * 1024) { throw new Error('too large'); }
      chmodSync(filePath, 0o600);
      document = JSON.parse(readFileSync(filePath, 'utf8')) as AgentBindingDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot read agent bindings at ${filePath}`);
      }
    }
    if (document.version !== 1 || !document.bindings || typeof document.bindings !== 'object'
      || Array.isArray(document.bindings)
      || !Object.entries(document.bindings).every(([chatId, binding]) => validBinding(binding, chatId))) {
      throw new Error(`Invalid agent bindings at ${filePath}`);
    }
    this.bindings = document.bindings;
  }

  get(chatId: string): AgentBinding | undefined {
    const binding = this.bindings[chatId];
    return binding ? { ...binding } : undefined;
  }

  set(chatId: string, presetName: string, actorId: string): AgentBinding {
    const previous = this.bindings[chatId];
    const binding = { chatId, presetName, updatedBy: actorId, updatedAt: new Date().toISOString() };
    this.bindings[chatId] = binding;
    try { this.write(); } catch (error) {
      if (previous) { this.bindings[chatId] = previous; } else { delete this.bindings[chatId]; }
      throw error;
    }
    return { ...binding };
  }

  clear(chatId: string): AgentBinding | undefined {
    const previous = this.bindings[chatId];
    if (!previous) { return undefined; }
    delete this.bindings[chatId];
    try { this.write(); } catch (error) {
      this.bindings[chatId] = previous;
      throw error;
    }
    return { ...previous };
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${dirname(this.filePath)}/.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, bindings: this.bindings }), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.filePath);
    } finally { rmSync(temp, { force: true }); }
  }
}
