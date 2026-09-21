/** Short-lived, server-issued context for the hidden Research channel operation. */

import { randomBytes } from 'node:crypto';

export interface ResearchAgentContext {
  actorId: string;
  chatId: string;
  threadId?: string;
  sourceMessageId: string;
}

export type ResearchOperation =
  | {
      action: 'create';
      title: string;
      scope: string;
      materials: string;
      documentUrl?: string;
      requestKey?: string;
      start?: boolean;
    }
  | { action: 'list'; includeFinished?: boolean }
  | { action: 'get'; id: string }
  | {
      action: 'control';
      id: string;
      command: 'start' | 'resume' | 'pause' | 'cancel' | 'feedback' | 'stop-direction' | 'publish';
      revision: number;
      value?: string;
      directionId?: string;
    };

type ResearchControlCommand =
  | 'start'
  | 'resume'
  | 'pause'
  | 'cancel'
  | 'feedback'
  | 'stop-direction'
  | 'publish';

export interface ResearchOperationResult {
  ok: true;
  project?: Record<string, unknown>;
  projects?: Array<Record<string, unknown>>;
  message: string;
}

interface Grant {
  context: ResearchAgentContext;
  expiresAt: number;
}

/**
 * The client can present only an opaque grant and a Research operation. The
 * grant is the sole source of actor/chat/project identity; owner/chat/cwd
 * fields in an operation are rejected instead of being trusted.
 */
export class ResearchGateway {
  private readonly grants = new Map<string, Grant>();
  private readonly ttlMs: number;
  private readonly maxGrants: number;

  constructor(
    private readonly executeOperation: (
      context: ResearchAgentContext,
      operation: ResearchOperation
    ) => Promise<ResearchOperationResult>,
    options: { ttlMs?: number; maxGrants?: number } = {}
  ) {
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.maxGrants = options.maxGrants ?? 512;
  }

  issue(context: ResearchAgentContext): string {
    if (!context.actorId || !context.chatId || !context.sourceMessageId) {
      throw new Error('Research context requires actor, chat, and source message identity.');
    }
    this.prune();
    while (this.grants.size >= this.maxGrants) {
      const oldest = this.grants.keys().next().value;
      if (!oldest) {
        break;
      }
      this.grants.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    this.grants.set(token, {
      context: Object.freeze({ ...context }),
      expiresAt: Date.now() + this.ttlMs,
    });
    return token;
  }

  async execute(token: string, rawOperation: unknown): Promise<ResearchOperationResult> {
    const grant = this.grants.get(token);
    if (!grant || grant.expiresAt <= Date.now()) {
      this.grants.delete(token);
      throw new Error('Research context expired; continue from the current chat message.');
    }
    const operation = parseResearchOperation(rawOperation);
    return await this.executeOperation(grant.context, operation);
  }

  revokeAll(): void {
    this.grants.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) {
        this.grants.delete(token);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Research operation ${label} is invalid.`);
  }
  return value;
}

/** Parse only the operation vocabulary exposed to the model. */
export function parseResearchOperation(value: unknown): ResearchOperation {
  if (!isRecord(value)) {
    throw new Error('Research operation must be a JSON object.');
  }
  const { action } = value;
  if (action === 'create') {
    return {
      action,
      title: requiredString(value.title, 'title', 180),
      scope: requiredString(value.scope, 'scope', 3000),
      materials: requiredString(value.materials, 'materials', 12000),
      ...(value.documentUrl === undefined
        ? {}
        : { documentUrl: requiredString(value.documentUrl, 'documentUrl', 500) }),
      ...(value.requestKey === undefined
        ? {}
        : { requestKey: requiredString(value.requestKey, 'requestKey', 200) }),
      ...(value.start === undefined ? {} : { start: value.start === true }),
    };
  }
  if (action === 'list') {
    return {
      action,
      ...(value.includeFinished === undefined
        ? {}
        : { includeFinished: value.includeFinished === true }),
    };
  }
  if (action === 'get') {
    return { action, id: requiredString(value.id, 'id', 100) };
  }
  if (action === 'control') {
    const { command } = value;
    if (
      !['start', 'resume', 'pause', 'cancel', 'feedback', 'stop-direction', 'publish'].includes(
        String(command)
      )
    ) {
      throw new Error('Research operation command is invalid.');
    }
    if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
      throw new Error('Research operation revision is invalid.');
    }
    return {
      action,
      id: requiredString(value.id, 'id', 100),
      command: command as ResearchControlCommand,
      revision: value.revision as number,
      ...(value.value === undefined ? {} : { value: requiredString(value.value, 'value', 3000) }),
      ...(value.directionId === undefined
        ? {}
        : { directionId: requiredString(value.directionId, 'directionId', 100) }),
    };
  }
  throw new Error('Research operation action is invalid.');
}
