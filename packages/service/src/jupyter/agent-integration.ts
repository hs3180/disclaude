import { buildSessionKey, type AgentQueryOptions } from '@disclaude/core';
import type {
  AgentSessionExtension,
  AgentSessionExtensionFactory,
} from '../agents/session-extension.js';
import {
  summarizeNotebookStop,
  type NotebookAgentSessionFactory,
  type NotebookSession,
  type NotebookStopSummary,
} from './agent-session.js';

/** Owns Notebook behavior at the Service composition boundary. */
export class NotebookAgentIntegration {
  private readonly sessions = new Map<string, NotebookSession>();

  constructor(
    private readonly factory: NotebookAgentSessionFactory,
    private readonly workingDir: (chatId: string) => string
  ) {}

  readonly createExtension: AgentSessionExtensionFactory = (context) => {
    const session = this.factory({
      workingDir: context.workingDir,
      conversationKey: context.sessionKey,
      currentWorkingDir: context.currentWorkingDir,
      delivery: context.captureFileDelivery,
    });
    if (!session) {
      return undefined;
    }
    this.sessions.set(context.sessionKey, session);
    const extension: AgentSessionExtension = {
      get inactive() {
        return session.inactive;
      },
      configureQueryOptions: (options: AgentQueryOptions) => {
        const env = options.env ? { ...options.env } : undefined;
        if (env) {
          session.redactEnvironment(env);
        }
        return {
          ...options,
          tools: [...(options.tools ?? []), ...session.tools],
          ...(env ? { env } : {}),
        };
      },
      messageContext: async (attachments) => {
        session.registerAttachments?.(attachments);
        try {
          const result = await session.messageContext();
          if (session.inactive) {
            throw new Error('Notebook turn stopped during context loading');
          }
          return result;
        } catch {
          if (session.inactive) {
            throw new Error('Notebook turn stopped during context loading');
          }
          return '\n\n[Notebook connection unverified] Use the native Notebook tools to check the existing resource. Do not create a local replacement or replay an uncertain run.';
        }
      },
      pause: () => session.pause(),
      dispose: () => {
        session.dispose();
        if (this.sessions.get(context.sessionKey) === session) {
          this.sessions.delete(context.sessionKey);
        }
      },
    };
    return extension;
  };

  async stop(chatId: string, threadRootId?: string): Promise<NotebookStopSummary> {
    const key = buildSessionKey(chatId, threadRootId);
    const existing = this.sessions.get(key);
    if (existing) {
      return summarizeNotebookStop(existing);
    }
    try {
      const session = this.factory({
        workingDir: this.workingDir(chatId),
        conversationKey: key,
        currentWorkingDir: () => this.workingDir(chatId),
      });
      try {
        return await summarizeNotebookStop(session);
      } finally {
        session?.dispose();
      }
    } catch {
      return { cancelled: 0, alreadyTerminal: 0, ownershipLost: 0, unknown: 0, unavailable: true };
    }
  }
}
