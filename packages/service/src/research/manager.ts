/** Durable lifecycle for Research tasks that belong to an existing ProjectManager project. */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  parseResearchCheckpoint,
  type ResearchCheckpoint,
  type ResearchFeedbackReceipt,
  type ResearchWorkUpdate,
} from './checkpoint.js';
import { ProjectResearchStore, type ResearchProject, type ResearchDirection } from './project.js';
import {
  changedDocumentFeedback,
  type DocumentReader,
  type DocumentWriter,
} from './document-source.js';

export type ResearchAction =
  | 'start'
  | 'resume'
  | 'pause'
  | 'cancel'
  | 'feedback'
  | 'stop-direction'
  | 'publish';

export interface ResearchTurnContext {
  /** A frozen snapshot; runner must not mutate persisted state. */
  project: ResearchProject;
  signal: AbortSignal;
}

export type ResearchTurnRunner = (
  context: ResearchTurnContext
) => Promise<ResearchCheckpoint | string>;
export type ResearchPublisher = (project: ResearchProject, reason: string) => Promise<void>;

export interface ResearchManagerOptions {
  store: ProjectResearchStore;
  runner: ResearchTurnRunner;
  publish?: ResearchPublisher;
  maxTurns?: number;
  now?: () => string;
  readDocument?: DocumentReader;
  writeDocument?: DocumentWriter;
}

export interface CreateResearchInput {
  owner: string;
  chatId: string;
  threadId?: string;
  source: string;
  requestKey?: string;
  title: string;
  scope: string;
  materials: string;
  document?: { url: string; token: string };
}

export class ResearchManager {
  private readonly projects = new Map<string, ResearchProject>();
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly publish: ResearchPublisher;
  private readonly maxTurns: number;
  private readonly now: () => string;
  private disposed = false;

  constructor(private readonly options: ResearchManagerOptions) {
    this.publish = options.publish ?? (async () => {});
    this.maxTurns = options.maxTurns ?? 12;
    this.now = options.now ?? (() => new Date().toISOString());
    const loaded = options.store.readAll();
    for (const project of loaded) {
      this.projects.set(project.id, project);
    }
    for (const project of loaded) {
      if (
        project.status === 'running' ||
        project.status === 'pausing' ||
        project.status === 'cancelling'
      ) {
        project.status = project.status === 'cancelling' ? 'cancelled' : 'interrupted';
        this.record(project, '服务曾中断。已有成果保留；恢复前请检查最新范围和材料。');
      }
    }
  }

  get(id: string, owner: string, chatId: string): ResearchProject {
    this.assertLive();
    const project = this.projects.get(id);
    if (!project || project.owner !== owner || project.chatId !== chatId) {
      throw new Error('Research project does not exist or is not owned by this chat.');
    }
    return structuredClone(project);
  }

  list(owner: string, chatId: string, includeFinished = true): ResearchProject[] {
    this.assertLive();
    return [...this.projects.values()]
      .filter(
        (project) =>
          project.owner === owner &&
          project.chatId === chatId &&
          (includeFinished || !['completed', 'cancelled'].includes(project.status))
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((project) => structuredClone(project));
  }

  async create(input: CreateResearchInput): Promise<ResearchProject> {
    this.assertLive();
    this.validateCreate(input);
    const requestKey = input.requestKey ?? input.source;
    const existing = [...this.projects.values()].find(
      (project) =>
        project.owner === input.owner &&
        project.chatId === input.chatId &&
        project.requestKey === requestKey
    );
    if (existing) {
      return structuredClone(existing);
    }
    const now = this.now();
    const project: ResearchProject = {
      id: randomUUID(),
      workingDir: this.options.store.workingDir,
      owner: input.owner,
      chatId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      source: input.source,
      requestKey,
      title: input.title.trim(),
      scope: input.scope.trim(),
      materials: input.materials.trim(),
      ...(input.document
        ? {
            document: {
              url: input.document.url,
              token: input.document.token,
              previous: [],
              publishedFragments: [],
              generation: 0,
            },
          }
        : {}),
      status: 'paused',
      revision: 0,
      createdAt: now,
      updatedAt: now,
      directions: [],
      summary: '',
      questions: [],
      history: [],
      feedback: [],
      stepCount: 0,
    };
    this.projects.set(project.id, project);
    this.record(project, '研究已建立在当前 Project 中。开始后会持续推进，无需逐轮发送消息。');
    await this.announce(project, '研究已建立');
    return structuredClone(project);
  }

  async act(
    id: string,
    owner: string,
    chatId: string,
    action: ResearchAction,
    input: { revision: number; value?: string; directionId?: string }
  ): Promise<ResearchProject> {
    this.assertLive();
    const project = this.projectFor(id, owner, chatId);
    if (project.revision !== input.revision) {
      throw new Error('Research project changed; read its latest status before acting.');
    }

    switch (action) {
      case 'start':
      case 'resume':
        this.start(project);
        break;
      case 'pause':
        this.pause(project);
        break;
      case 'cancel':
        this.cancel(project);
        break;
      case 'feedback':
        this.addFeedback(project, input.value ?? '');
        break;
      case 'stop-direction':
        this.stopDirection(project, input.directionId ?? input.value ?? '');
        break;
      case 'publish':
        await this.syncDocument(project);
        await this.publishDocument(project);
        break;
      default:
        throw new Error(`Unsupported Research action: ${String(action)}`);
    }
    await this.announce(project, `研究操作：${action}`);
    if (project.status === 'running') {
      this.startRun(project);
    }
    return structuredClone(project);
  }

  /** Wait for a project run in tests, diagnostics, and controlled shutdown. */
  async idle(id: string): Promise<void> {
    await this.running.get(id)?.done;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const [id, run] of this.running) {
      run.abort.abort();
      const project = this.projects.get(id);
      if (!project) {
        continue;
      }
      if (
        project.status === 'running' ||
        project.status === 'pausing' ||
        project.status === 'cancelling'
      ) {
        project.status = project.status === 'cancelling' ? 'cancelled' : 'interrupted';
        this.record(project, '服务已停止。已有成果保留，下次打开可恢复。');
      }
    }
    this.options.store.close();
  }

  private start(project: ResearchProject): void {
    if (project.status === 'completed' || project.status === 'cancelled') {
      throw new Error('Research project is finished; start a follow-up project from its findings.');
    }
    if (this.running.has(project.id)) {
      throw new Error('Research project is already running.');
    }
    if (!['paused', 'failed', 'interrupted', 'waiting-user'].includes(project.status)) {
      throw new Error('Research project is not ready to start.');
    }
    project.status = 'running';
    project.error = undefined;
    project.clarification = undefined;
    this.record(project, '研究已开始，将按当前目标、材料和反馈推进。');
  }

  private pause(project: ResearchProject): void {
    if (project.status !== 'running' && project.status !== 'pausing') {
      throw new Error('Research project is not running.');
    }
    project.status = this.running.has(project.id) ? 'pausing' : 'paused';
    this.record(project, '已请求暂停：当前回合收尾后停止，不再开始下一回合。');
    this.running.get(project.id)?.abort.abort();
  }

  private cancel(project: ResearchProject): void {
    if (project.status === 'completed' || project.status === 'cancelled') {
      throw new Error('Research project is already finished.');
    }
    project.status = this.running.has(project.id) ? 'cancelling' : 'cancelled';
    this.record(project, '已请求取消：保留此前成果，不接纳在途回合结果。');
    this.running.get(project.id)?.abort.abort();
  }

  private addFeedback(project: ResearchProject, value: string): void {
    const text = value.trim();
    if (!text || text.length > 3000) {
      throw new Error('Feedback must be 1–3000 characters.');
    }
    project.feedback.push({ text, status: 'pending', at: this.now() });
    this.record(project, '已收到范围调整或补充意见；下一回合会按新意见处理。');
  }

  private stopDirection(project: ResearchProject, directionId: string): void {
    const direction = project.directions.find((candidate) => candidate.id === directionId);
    if (!direction || direction.status !== 'pending') {
      throw new Error('Research direction does not exist or is already finished.');
    }
    direction.status = 'stopped';
    this.record(project, `已停止方向：${direction.title}。在途结果不会计入有效发现。`);
  }

  private startRun(project: ResearchProject): void {
    if (this.disposed || this.running.has(project.id) || project.status !== 'running') {
      return;
    }
    const abort = new AbortController();
    const done = Promise.resolve()
      .then(() => this.execute(project, abort.signal))
      .finally(() => {
        this.running.delete(project.id);
      });
    this.running.set(project.id, { abort, done });
    void done.catch(() => {});
  }

  private async execute(project: ResearchProject, signal: AbortSignal): Promise<void> {
    try {
      while (!this.disposed && project.status === 'running') {
        if (project.stepCount >= this.maxTurns) {
          project.status = 'paused';
          this.record(
            project,
            `本轮已执行 ${this.maxTurns} 个研究回合，已暂停。请检查进展后决定是否继续。`
          );
          break;
        }
        this.record(project, '正在根据当前目标、材料和反馈推进研究。');
        await this.announce(project, '研究正在推进');
        if (signal.aborted || project.status !== 'running') {
          break;
        }
        await this.syncDocument(project);
        if (signal.aborted || project.status !== 'running') {
          break;
        }
        const snapshot = structuredClone(project);
        let checkpoint: ResearchCheckpoint;
        try {
          checkpoint = parseResearchCheckpoint(
            await this.options.runner({ project: snapshot, signal })
          );
        } catch (error) {
          const interruptedStatus = project.status as ResearchProject['status'];
          if (
            signal.aborted ||
            interruptedStatus === 'pausing' ||
            interruptedStatus === 'cancelling'
          ) {
            break;
          }
          throw error;
        }
        if (signal.aborted || project.status !== 'running') {
          break;
        }
        const stoppedDuringTurn = snapshot.directions.some(
          (before) =>
            before.status !== 'stopped' &&
            project.directions.find((candidate) => candidate.id === before.id)?.status === 'stopped'
        );
        project.stepCount += 1;
        if (stoppedDuringTurn) {
          this.record(project, '用户停止了研究方向，已丢弃该方向的在途结果。');
        } else {
          this.applyCheckpoint(project, snapshot, checkpoint);
          await this.tryPublishDocument(project);
        }
        if ((project.status as ResearchProject['status']) === 'pausing') {
          project.status = 'paused';
          this.record(project, '当前回合已收尾，研究已暂停。');
        }
      }
      if (project.status === 'pausing') {
        project.status = 'paused';
        this.record(project, '研究已暂停。');
      } else if (project.status === 'cancelling') {
        project.status = 'cancelled';
        this.record(project, '研究已取消，在途回合未计入成果。');
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }
      if (project.status === 'cancelling') {
        project.status = 'cancelled';
        project.error = undefined;
        this.record(project, '研究已取消，在途回合未计入成果。');
      } else {
        project.status = 'failed';
        project.error =
          error instanceof Error
            ? error.message.slice(0, 1000)
            : 'Research turn failed; previous findings were preserved.';
        this.record(project, '本轮研究未完成，已有成果保留。检查材料或权限后可恢复重试。');
      }
    } finally {
      if (!this.disposed) {
        await this.announce(project, `研究状态：${project.status}`);
      }
    }
  }

  private applyCheckpoint(
    project: ResearchProject,
    snapshot: ResearchProject,
    checkpoint: ResearchCheckpoint
  ): void {
    const pending = snapshot.feedback
      .map((feedback, index) => ({ feedback, index }))
      .filter(
        ({ feedback }) => feedback.status === 'pending' || feedback.status === 'needs-clarification'
      );
    const pendingIndexes = new Set(pending.map(({ index }) => index));
    const receipts = new Map<number, ResearchFeedbackReceipt>();
    for (const receipt of checkpoint.feedback) {
      if (!pendingIndexes.has(receipt.feedbackIndex) || receipts.has(receipt.feedbackIndex)) {
        throw new Error('Research checkpoint contains an invalid or duplicate feedback receipt.');
      }
      if (receipt.workIndexes.some((index) => index >= checkpoint.work.length)) {
        throw new Error('Research checkpoint feedback refers to missing work.');
      }
      receipts.set(receipt.feedbackIndex, receipt);
    }
    if (checkpoint.state !== 'waiting-user' && receipts.size !== pending.length) {
      throw new Error('Research checkpoint did not account for every pending feedback item.');
    }

    const directions = structuredClone(project.directions);
    const updatedIds: string[] = [];
    checkpoint.work.forEach((update, workIndex) => {
      this.applyWorkUpdate(directions, snapshot.directions, update, workIndex, updatedIds);
    });

    for (const [feedbackIndex, receipt] of receipts) {
      const feedback = project.feedback[feedbackIndex];
      feedback.status = receipt.status;
      feedback.reason = receipt.reason;
      feedback.directionIds = receipt.workIndexes.map((index) => updatedIds[index]).filter(Boolean);
    }
    project.directions = directions;
    project.questions = checkpoint.questions;
    this.record(project, checkpoint.message);

    if (checkpoint.state === 'waiting-user') {
      project.status = 'waiting-user';
      project.clarification = checkpoint.clarification;
      for (const { feedback, index } of pending) {
        if (!receipts.has(index)) {
          feedback.status = 'needs-clarification';
          feedback.reason = checkpoint.clarification;
        }
      }
      this.record(project, '研究需要补充信息，已停止自动推进。请在当前聊天中回答后继续。');
      return;
    }

    const hasPendingDirection = directions.some((direction) => direction.status === 'pending');
    const hasPendingFeedback = project.feedback.some(
      (feedback) => feedback.status === 'pending' || feedback.status === 'needs-clarification'
    );
    if (checkpoint.state === 'complete' && !hasPendingDirection && !hasPendingFeedback) {
      project.summary = checkpoint.summary ?? '';
      project.status = 'completed';
      this.record(project, '研究已完成，成果、证据、来源和未知项已保留。');
    } else if (checkpoint.state === 'complete') {
      this.record(project, '模型声明完成，但仍有未处理方向或意见；研究继续保持可恢复状态。');
    }
  }

  /** Read the current Feishu document before each turn and convert changes to pending feedback. */
  private async syncDocument(project: ResearchProject): Promise<void> {
    const { document } = project;
    if (!document) {
      return;
    }
    if (!this.options.readDocument) {
      document.error = '关联文档读取能力尚未配置；已有研究成果保留，配置权限后可恢复。';
      this.record(project, document.error);
      throw new Error(document.error);
    }
    try {
      const snapshot = await this.options.readDocument(document.token, document.publishedFragments);
      if (snapshot.token !== document.token) {
        throw new Error('Research document binding mismatch.');
      }
      const changes = changedDocumentFeedback(document.snapshot, snapshot);
      if (changes.length && document.snapshot) {
        document.previous.push(document.snapshot);
      }
      document.generation += changes.length ? 1 : 0;
      for (const change of changes) {
        const sourceKey = `${document.token}:${document.generation}:${change.key}`;
        if (!project.feedback.some((feedback) => feedback.sourceKey === sourceKey)) {
          project.feedback.push({
            text: change.text,
            status: 'pending',
            at: snapshot.syncedAt,
            sourceKey,
          });
        }
      }
      document.snapshot = snapshot;
      document.error = undefined;
      this.options.store.saveAll([...this.projects.values()]);
      if (changes.length) {
        this.record(project, '已同步关联文档正文与评论；新增意见等待研究处理，旧版本保留。');
      }
    } catch (error) {
      document.error =
        error instanceof Error ? error.message.slice(0, 1000) : 'Research document sync failed.';
      this.record(project, document.error);
      throw new Error('Research document sync failed; previous findings were preserved.');
    }
  }

  private async tryPublishDocument(project: ResearchProject): Promise<void> {
    if (!project.document) {
      return;
    }
    try {
      await this.publishDocument(project);
    } catch (error) {
      project.document.error =
        error instanceof Error
          ? error.message.slice(0, 1000)
          : 'Research document publication failed.';
      this.record(project, '研究成果已保留，但尚未写回关联文档；可检查权限或并发修改后重试写回。');
    }
  }

  private async publishDocument(project: ResearchProject): Promise<void> {
    const { document } = project;
    if (!document) {
      throw new Error('当前研究项目没有关联文档。');
    }
    const { snapshot } = document;
    if (!snapshot) {
      throw new Error('关联文档尚未同步，暂不能安全写回研究成果。');
    }
    const content = renderPublication(project);
    const alreadyPublished = snapshot.rawBody?.includes(content) ?? false;
    const tracked = document.publishedFragments.includes(content);
    if (alreadyPublished) {
      if (tracked && !document.error) {
        return;
      }
      if (!tracked) {
        document.publishedFragments.push(content);
      }
      document.error = undefined;
      this.record(project, '关联文档已包含本轮成果，已恢复本地写回记录。');
      return;
    }
    if (!this.options.writeDocument) {
      throw new Error('当前服务尚未建立飞书文档写回能力。');
    }
    const clientToken = createHash('sha256')
      .update(`${project.id}:${project.stepCount}:${content}`)
      .digest('hex')
      .slice(0, 40);
    const result = await this.options.writeDocument(
      document.token,
      snapshot.revision,
      content,
      clientToken
    );
    if (!Number.isSafeInteger(result.revision) || result.revision <= snapshot.revision) {
      throw new Error('关联文档写回未返回新的稳定版本；已有成果保留，请重新同步后再试。');
    }
    document.publishedFragments.push(content);
    document.snapshot = {
      ...snapshot,
      revision: result.revision,
      rawBody: `${snapshot.rawBody ?? snapshot.body}${content}`,
      syncedAt: this.now(),
    };
    document.error = undefined;
    this.record(project, '本轮目标、计划、发现、来源、未知项和修订记录已写入关联文档。');
  }

  private applyWorkUpdate(
    directions: ResearchDirection[],
    previous: ResearchDirection[],
    update: ResearchWorkUpdate,
    workIndex: number,
    updatedIds: string[]
  ): void {
    if (update.id) {
      const prior = previous.find((direction) => direction.id === update.id);
      const target = directions.find((direction) => direction.id === update.id);
      if (!prior || !target || prior.status !== 'pending' || target.status !== 'pending') {
        throw new Error('Research checkpoint cannot overwrite a finished or unknown direction.');
      }
      for (const finding of prior.findings) {
        if (
          !update.findings.some(
            (candidate) => JSON.stringify(candidate) === JSON.stringify(finding)
          )
        ) {
          throw new Error('Research checkpoint cannot delete existing evidence.');
        }
      }
      Object.assign(target, structuredClone(update), { id: update.id });
      updatedIds[workIndex] = update.id;
      return;
    }
    const id = randomUUID();
    directions.push({ ...structuredClone(update), id });
    updatedIds[workIndex] = id;
  }

  private projectFor(id: string, owner: string, chatId: string): ResearchProject {
    const project = this.projects.get(id);
    if (!project || project.owner !== owner || project.chatId !== chatId) {
      throw new Error('Research project does not exist or is not owned by this chat.');
    }
    return project;
  }

  private validateCreate(input: CreateResearchInput): void {
    if (
      !input.owner ||
      !input.chatId ||
      !input.source ||
      !input.title.trim() ||
      input.title.length > 180 ||
      input.scope.length > 3000 ||
      input.materials.length > 12000
    ) {
      throw new Error(
        'Research requires a question (≤180), scope (≤3000), and materials (≤12000).'
      );
    }
    if (!existsSync(this.options.store.workingDir)) {
      throw new Error('Current Project directory is unavailable; existing findings are preserved.');
    }
  }

  private record(project: ResearchProject, text: string): void {
    project.updatedAt = this.now();
    project.revision += 1;
    project.history.push({ at: project.updatedAt, text: text.slice(0, 2000) });
    this.options.store.saveAll([...this.projects.values()]);
  }

  private async announce(project: ResearchProject, reason: string): Promise<void> {
    try {
      await this.publish(structuredClone(project), reason);
      if (project.deliveryError) {
        project.deliveryError = undefined;
        this.options.store.saveAll([...this.projects.values()]);
      }
    } catch (error) {
      project.deliveryError =
        error instanceof Error ? error.message.slice(0, 500) : 'Research status delivery failed.';
      this.options.store.saveAll([...this.projects.values()]);
    }
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new Error('Research controller is stopped.');
    }
  }
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function renderPublication(project: ResearchProject): string {
  const marker = `[Disclaude Research ${project.id} / turn ${project.stepCount}]`;
  const lines = [
    '',
    marker,
    `研究问题：${clip(project.title, 180)}`,
    `目标范围：${clip(project.scope, 1800)}`,
    `材料：${clip(project.materials, 2200)}`,
    `状态：${project.status}；修订：${project.revision}`,
    '',
    '计划与方向：',
    ...(project.directions.length === 0
      ? ['- 尚未形成研究方向。']
      : project.directions.map(
          (direction) => `- [${direction.status}] ${clip(direction.title, 180)}`
        )),
    '',
    '发现、来源与不确定性：',
    ...project.directions
      .flatMap((direction) =>
        direction.findings.map((finding) => {
          const sources = finding.sources
            .map((source) => `${clip(source.title, 100)} — ${clip(source.location, 240)}`)
            .join('; ');
          const caveat = finding.caveat ? `；说明：${clip(finding.caveat, 320)}` : '';
          return `- [${finding.kind}] ${clip(finding.claim, 600)}（来源：${sources}${caveat}）`;
        })
      )
      .concat(project.directions.length ? [] : ['- 尚无已验证发现。']),
    '',
    '成果与待确认事项：',
    `- 摘要：${clip(project.summary || '尚未形成最终摘要。', 1800)}`,
    ...(project.questions.length
      ? project.questions.map((question) => `- 待确认：${clip(question, 280)}`)
      : ['- 未记录额外待确认事项。']),
    ...(project.feedback.length
      ? [
          '',
          '用户反馈处理：',
          ...project.feedback
            .slice(-12)
            .map(
              (feedback) =>
                `- [${feedback.status}] ${clip(feedback.text, 320)}${feedback.reason ? `；处理：${clip(feedback.reason, 320)}` : ''}`
            ),
        ]
      : []),
    '',
    '修订记录：',
    ...project.history.slice(-12).map((entry) => `- ${entry.at} ${clip(entry.text, 500)}`),
    `${marker} end`,
    '',
  ];
  return clip(lines.join('\n'), 12_000);
}
