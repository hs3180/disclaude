/** Server-side Research adapter: binds opaque chat context to ProjectManager. */

import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ResearchCheckpoint } from './checkpoint.js';
import { ResearchManager, type ResearchPublisher, type ResearchTurnContext } from './manager.js';
import { ProjectResearchStore, type ResearchProject } from './project.js';
import type { DocumentReader, DocumentWriter } from './document-source.js';
import {
  parseResearchOperation,
  type ResearchAgentContext,
  type ResearchOperationResult,
} from './gateway.js';

export interface ResearchProjectResolver {
  (chatId: string): { workingDir: string; projectName?: string };
}

export interface ResearchControllerOptions {
  resolveProject: ResearchProjectResolver;
  runTurn: (context: ResearchTurnContext) => Promise<ResearchCheckpoint | string>;
  sendStatus?: (project: ResearchProject, reason: string) => Promise<void>;
  createDocumentReader?: () => DocumentReader | undefined;
  createDocumentWriter?: () => DocumentWriter | undefined;
}

/**
 * Research is a capability of the active Project, not a new project mode.
 * Each working directory gets one locked state store and one lifecycle manager.
 */
export class ResearchController {
  private readonly managers = new Map<string, ResearchManager>();
  private disposed = false;
  private createDocumentReader?: () => DocumentReader | undefined;
  private createDocumentWriter?: () => DocumentWriter | undefined;

  constructor(private readonly options: ResearchControllerOptions) {
    this.createDocumentReader = options.createDocumentReader;
    this.createDocumentWriter = options.createDocumentWriter;
  }

  setDocumentReaderFactory(factory?: () => DocumentReader | undefined): void {
    this.createDocumentReader = factory;
  }

  setDocumentWriterFactory(factory?: () => DocumentWriter | undefined): void {
    this.createDocumentWriter = factory;
  }

  async execute(
    context: ResearchAgentContext,
    rawOperation: unknown
  ): Promise<ResearchOperationResult> {
    if (this.disposed) {
      throw new Error('Research controller is stopped.');
    }
    const operation = parseResearchOperation(rawOperation);
    const project = this.options.resolveProject(context.chatId);
    if (!isAbsolute(project.workingDir) || !existsSync(project.workingDir)) {
      throw new Error(
        'Current Project directory is unavailable; existing Research findings are preserved.'
      );
    }
    const manager = this.getManager(project.workingDir);
    if (operation.action === 'create') {
      const document = operation.documentUrl
        ? parseDocumentReference(operation.documentUrl)
        : undefined;
      const created = await manager.create({
        owner: context.actorId,
        chatId: context.chatId,
        threadId: context.threadId,
        source: context.sourceMessageId,
        requestKey: operation.requestKey ?? context.sourceMessageId,
        title: operation.title,
        scope: operation.scope,
        materials: operation.materials,
        document,
      });
      if (operation.start !== false && created.status === 'paused') {
        const started = await manager.act(created.id, context.actorId, context.chatId, 'start', {
          revision: created.revision,
        });
        return {
          ok: true,
          project: this.view(started),
          message: 'Research project created and started in the active Project.',
        };
      }
      return {
        ok: true,
        project: this.view(created),
        message: 'Research project created in the active Project.',
      };
    }
    if (operation.action === 'list') {
      const projects = manager.list(
        context.actorId,
        context.chatId,
        operation.includeFinished !== false
      );
      return {
        ok: true,
        projects: projects.map((candidate) => this.view(candidate)),
        message: 'Research projects loaded.',
      };
    }
    if (operation.action === 'get') {
      return {
        ok: true,
        project: this.view(manager.get(operation.id, context.actorId, context.chatId)),
        message: 'Research project loaded.',
      };
    }
    const acted = await manager.act(
      operation.id,
      context.actorId,
      context.chatId,
      operation.command,
      {
        revision: operation.revision,
        value: operation.value,
        directionId: operation.directionId,
      }
    );
    return {
      ok: true,
      project: this.view(acted),
      message: `Research project action ${operation.command} accepted.`,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const manager of this.managers.values()) {
      manager.dispose();
    }
    this.managers.clear();
  }

  private getManager(workingDir: string): ResearchManager {
    const existing = this.managers.get(workingDir);
    if (existing) {
      return existing;
    }
    const store = new ProjectResearchStore(workingDir);
    const publisher: ResearchPublisher = async (project, reason) => {
      await this.options.sendStatus?.(project, reason);
    };
    const manager = new ResearchManager({
      store,
      runner: this.options.runTurn,
      publish: publisher,
      readDocument: async (token, publishedFragments) => {
        const reader = this.createDocumentReader?.();
        if (!reader) {
          throw new Error('当前服务尚未建立飞书文档读取能力。');
        }
        return await reader(token, publishedFragments);
      },
      writeDocument: async (token, expectedRevision, content, clientToken) => {
        const writer = this.createDocumentWriter?.();
        if (!writer) {
          throw new Error('当前服务尚未建立飞书文档写回能力。');
        }
        return await writer(token, expectedRevision, content, clientToken);
      },
    });
    this.managers.set(workingDir, manager);
    return manager;
  }

  /** Do not expose the frozen project directory, actor, or chat identity to the agent result. */
  private view(project: ResearchProject): Record<string, unknown> {
    const {
      workingDir: _workingDir,
      owner: _owner,
      chatId: _chatId,
      ...safe
    } = structuredClone(project);
    return safe;
  }
}

function parseDocumentReference(url: string): { url: string; token: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Research document must be an HTTPS Feishu /docx/ URL.');
  }
  const match = /^\/docx\/([A-Za-z0-9]+)\/?$/u.exec(parsed.pathname);
  if (parsed.protocol !== 'https:' || !match || match[1].length > 100) {
    throw new Error('Research document must be an HTTPS Feishu /docx/ URL.');
  }
  return { url, token: match[1] };
}
