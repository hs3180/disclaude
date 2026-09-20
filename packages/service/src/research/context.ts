import { randomUUID } from 'node:crypto';

export type ResearchOperation =
  | { action: 'create'; requestId: string; title: string; scope?: string; materials?: string; documentUrl?: string }
  | { action: 'list'; archived?: boolean; offset?: number; limit?: number }
  | { action: 'get'; researchId: string }
  | { action: 'control'; researchId: string; revision: number; control: 'resume' | 'pause' | 'cancel' | 'feedback' | 'stop-direction' | 'archive' | 'unarchive' | 'export'; value?: string };
export interface ResearchActorContext { owner: string; chat: string; source: string; thread?: string }
export class ResearchContextError extends Error {}

export function parseResearchOperation(value: unknown): ResearchOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid task operation'); }
  const v = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    create: ['action', 'requestId', 'title', 'scope', 'materials', 'documentUrl'], list: ['action', 'archived', 'offset', 'limit'], get: ['action', 'researchId'],
    control: ['action', 'researchId', 'revision', 'control', 'value'],
  };
  const allowed = typeof v.action === 'string' && Object.hasOwn(fields, v.action) ? fields[v.action] : undefined;
  if (!allowed || Object.keys(v).some(key => !allowed.includes(key))) { throw new Error('Invalid task operation fields'); }
  const str = (key: string, max: number, required = false) => {
    const x = v[key];
    if (x === undefined && !required) { return; }
    if (typeof x !== 'string' || x.length > max || (required && !x.trim())) { throw new Error(`Invalid task ${key}`); }
  };
  if (v.action === 'create') { str('requestId', 100, true); str('title', 180, true); str('scope', 3000); str('materials', 12000); str('documentUrl', 1000); }
  if (v.action === 'list') {
    if ((v.archived !== undefined && typeof v.archived !== 'boolean')
      || (v.offset !== undefined && (!Number.isSafeInteger(v.offset) || Number(v.offset) < 0))
      || (v.limit !== undefined && (!Number.isSafeInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 50))) { throw new Error('Invalid task list options'); }
  }
  if (v.action === 'get' || v.action === 'control') { str('researchId', 100, true); }
  if (v.action === 'control') {
    if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 0
      || !['resume', 'pause', 'cancel', 'feedback', 'stop-direction', 'archive', 'unarchive', 'export'].includes(String(v.control))) {
      throw new Error('Invalid task control');
    }
    str('value', 3000);
  }
  return structuredClone(v) as ResearchOperation;
}

/** Internal message contexts supplement API authentication; clients cannot choose actor/chat/cwd. */
export class ResearchContextGateway {
  private readonly grants = new Map<string, { namespace: string; expiresAt: number; execute: (operation: ResearchOperation) => Promise<unknown> }>();
  constructor(private readonly now = Date.now, private readonly ttlMs = 30 * 60_000, private readonly limit = 1000) {}
  issue(namespace: string, execute: (operation: ResearchOperation) => Promise<unknown>): string {
    for (const [key, grant] of this.grants) { if (grant.expiresAt <= this.now()) { this.grants.delete(key); } }
    if (this.grants.size >= this.limit) { throw new ResearchContextError('Research context capacity reached'); }
    const context = randomUUID();
    this.grants.set(context, { namespace, expiresAt: this.now() + this.ttlMs, execute });
    return context;
  }
  revoke(namespace: string): void {
    for (const [key, grant] of this.grants) { if (grant.namespace === namespace) { this.grants.delete(key); } }
  }
  async execute(context: string, value: unknown): Promise<unknown> {
    const grant = this.grants.get(context);
    if (!grant || grant.expiresAt <= this.now()) {
      this.grants.delete(context);
      throw new ResearchContextError('Research context expired or unavailable; use a fresh user message');
    }
    return await grant.execute(parseResearchOperation(value));
  }
}
export const researchContextGateway = new ResearchContextGateway();
