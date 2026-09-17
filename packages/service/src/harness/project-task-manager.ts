import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ProjectStore, ProjectTaskDirectoryError, type ProjectTask } from './project-task.js';
import { changedDocumentFeedback, documentToken, type DocumentReader, type DocumentAppender } from './document-source.js';
import { parseTaskCheckpoint, type TaskCheckpoint } from './task-checkpoint.js';
import { documentDeadline, resultParagraphs } from './task-document-export.js';

export type TaskRunner = (project: ProjectTask, signal: AbortSignal) => Promise<TaskCheckpoint>;
export type ProjectPublisher = (project: ProjectTask) => Promise<string>;
export type ProjectAction = 'pause' | 'resume' | 'cancel' | 'feedback' | 'stop-direction' | 'archive' | 'unarchive' | 'export';

/** Project state owns execution; message turns and cards are adapters, never the source of truth. */
export class ProjectTaskManager {
  private readonly projects = new Map<string, ProjectTask>();
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly publishing = new Map<string, Promise<void>>();
  private loaded = false;
  private disposed = false;
  private readonly exporting = new Set<string>();
  constructor(private readonly store: ProjectStore, private readonly runner: TaskRunner, private readonly publish: ProjectPublisher,
    private readonly readDocument?: DocumentReader, private readonly appendDocument?: DocumentAppender) {}

  private load(): void {
    if (this.disposed) { throw new Error('任务服务已停止。'); }
    if (this.loaded) { return; }
    for (const p of this.store.readAll()) {
      if (['running', 'pausing', 'cancelling'].includes(p.status)) {
        p.status = p.status === 'cancelling' ? 'cancelled' : 'interrupted';
        this.record(p, '服务曾中断。已有成果保留；恢复前请检查最新范围和材料。');
      }
      this.projects.set(p.id, p);
    }
    this.loaded = true;
  }
  private project(id: string): ProjectTask {
    const project = this.projects.get(id);
    if (!project) { throw new Error('任务不存在或不属于当前用户和会话。'); }
    return project;
  }
  get(id: string, owner: string, chat: string): ProjectTask {
    this.load();
    const p = this.projects.get(id);
    if (!p || p.owner !== owner || p.chat !== chat) { throw new Error('任务不存在或不属于当前用户和会话。'); }
    return structuredClone(p);
  }
  list(owner: string, chat: string, archived = false): ProjectTask[] {
    this.load();
    return [...this.projects.values()].filter(p => p.owner === owner && p.chat === chat && Boolean(p.archivedAt) === archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(p => structuredClone(p));
  }
  async create(input: { workingDir?: string; owner: string; chat: string; thread?: string; source: string; title: string; scope: string; materials: string; parent?: string; parentFinding?: ProjectTask['parentFinding']; documentUrl?: string }): Promise<ProjectTask> {
    this.load();
    if (!input.owner || !input.chat || !input.source || !input.title.trim() || input.title.length > 180 || input.scope.length > 3000 || input.materials.length > 12000) {
      throw new Error('请填写任务问题（180 字以内）、范围（3000 字以内）和材料（12000 字以内）。');
    }
    const existing = [...this.projects.values()].find(p => p.owner === input.owner && p.chat === input.chat && p.source === input.source);
    if (existing) { await this.show(existing.id, input.owner, input.chat); return structuredClone(existing); }
    const parent = input.parent ? this.get(input.parent, input.owner, input.chat) : undefined;
    if (parent && !['completed', 'cancelled'].includes(parent.status)) { throw new Error('请先结束原任务，再从成果继续任务。'); }
    const selected = input.parentFinding;
    const finding = selected && parent?.directions.find(d => d.id === selected.directionId)?.findings[selected.index];
    if (selected && (!Number.isSafeInteger(selected.index) || selected.index < 0 || !finding)) {
      throw new Error('所选发现不存在，请重新打开原任务中的发现。');
    }
    const workingDir = parent ? parent.workingDir : input.workingDir;
    if (workingDir !== undefined && !isAbsolute(workingDir)) { throw new Error('任务工作目录必须是绝对路径。'); }
    const now = new Date().toISOString();
    const token = documentToken(input.documentUrl ?? '');
    if (token && !this.readDocument) { throw new Error('当前任务服务未配置文档读取能力。'); }
    const p: ProjectTask = { ...input, workingDir, projectLink: parent?.projectLink ? { directory: parent.projectLink.directory, token: randomUUID() } : undefined, id: randomUUID(), status: 'paused', revision: 0, createdAt: now, updatedAt: now,
      title: finding ? `发现追问：${finding.claim.slice(0, 160)}` : input.title,
      scope: finding ? `仅围绕所选发现核验依据、补充证据并处理分歧与未知，不重新开展原任务的其他任务方向。原任务的来源和工具限制仍适用。\n所选发现：${finding.claim}` : input.scope,
      document: token ? { url: input.documentUrl ?? '', token, previous: [], generation: 0,
        publishedFragments: parent?.document?.token === token ? [...(parent.document.publishedFragments ?? [])] : [] } : undefined,
      directions: [], summary: '', questions: [], history: [], feedback: [], stepCount: 0,
      priorResults: parent ? { summary: parent.summary, scope: parent.scope, findings: structuredClone(finding ? [finding] : parent.directions.flatMap(d => d.findings).slice(-16)) } : undefined };
    this.record(p, '任务已建立。开始后会持续推进，无需逐轮发送消息。');
    this.projects.set(p.id, p);
    await this.display(p);
    // No invisible work if the first project card could not be delivered.
    return structuredClone(p);
  }
  private checkLegacyLink(p: ProjectTask): void {
    if (p.workingDir) { throw new Error('该任务已有固定项目目录，不支持通过历史关联迁移。'); }
    if (this.running.has(p.id) || ['running', 'pausing', 'cancelling'].includes(p.status)) { throw new Error('请先暂停任务并等待当前回合结束，再调整项目关联。'); }
  }
  async previewProjectLink(id: string, owner: string, chat: string, revision: number, directory: string): Promise<ProjectTask> {
    this.get(id, owner, chat);
    const p = this.project(id);
    this.checkLegacyLink(p);
    if (p.revision !== revision) { throw new Error('任务已更新，请刷新后操作。'); }
    if (p.projectLink) { throw new Error('该历史任务已有关联，请先撤销原关联。'); }
    if (!isAbsolute(directory)) { throw new Error('项目关联目录必须是绝对路径。'); }
    p.linkPreview = { directory, token: randomUUID() };
    this.record(p, '已准备项目关联预览，尚未改变任务归属或执行目录。');
    await this.display(p);
    return structuredClone(p);
  }
  async confirmProjectLink(id: string, owner: string, chat: string, revision: number, token: string, directory: string): Promise<void> {
    this.get(id, owner, chat);
    const p = this.project(id);
    if (p.projectLink?.token === token) { await this.display(p); return; }
    this.checkLegacyLink(p);
    if (p.revision !== revision || !p.linkPreview || p.linkPreview.token !== token || p.linkPreview.directory !== directory) {
      throw new Error('任务或当前目录已改变，请重新预览关联目标。');
    }
    p.projectLink = { ...p.linkPreview };
    p.linkPreview = undefined;
    this.record(p, '已将历史任务关联到项目导航。执行目录、已有文件及成果保留；可撤销关联。');
    await this.display(p);
  }
  async unlinkProject(id: string, owner: string, chat: string, revision: number): Promise<void> {
    this.get(id, owner, chat);
    const p = this.project(id);
    this.checkLegacyLink(p);
    if (p.revision !== revision) { throw new Error('任务已更新，请刷新后操作。'); }
    p.projectLink = undefined; p.linkPreview = undefined;
    this.record(p, '已撤销项目导航关联。任务身份、文件及成果保留。');
    await this.display(p);
  }
  async show(id: string, owner: string, chat: string, reopen?: { thread: string }): Promise<void> {
    this.get(id, owner, chat);
    const project = this.project(id);
    const oldCard = project.cardId, oldThread = project.thread;
    if (reopen) { project.cardId = undefined; project.thread = reopen.thread; }
    await this.display(project);
    if (reopen && project.deliveryError) {
      project.cardId = oldCard; project.thread = oldThread; this.store.save(project);
    }
  }
  async act(id: string, owner: string, chat: string, revision: number, action: ProjectAction, value = ''): Promise<void> {
    this.get(id, owner, chat);
    const p = this.project(id);
    if (revision !== p.revision) { throw new Error('项目已更新，请刷新后操作。'); }
    if (action === 'export') { await this.exportResult(p); return; }
    if (action === 'archive' || action === 'unarchive') {
      if (!['completed', 'cancelled'].includes(p.status)) { throw new Error('请先结束任务，再归档任务。'); }
      p.archivedAt = action === 'archive' ? new Date().toISOString() : undefined;
      this.record(p, action === 'archive' ? '任务已归档，成果保留，可从归档任务列表重返。' : '任务已移回任务列表。');
      await this.display(p);
      return;
    }
    if (['completed', 'cancelled'].includes(p.status)) { throw new Error('任务已结束，可从成果创建后续任务。'); }
    if (action === 'pause') {
      if (p.status !== 'running') { throw new Error('当前任务未在执行。'); }
      p.status = this.running.has(id) ? 'pausing' : 'paused';
      this.record(p, '已请求暂停：当前回合收尾后停止，不再开始下一回合。');
    } else if (action === 'cancel') {
      p.status = this.running.has(id) ? 'cancelling' : 'cancelled';
      this.record(p, '已请求取消：等待当前回合结束，保留此前成果，不接纳在途结果。');
    } else if (action === 'resume') {
      // An answer can arrive in the linked document while the task is waiting.
      // Read it before deciding whether the user supplied any new information.
      if (p.status === 'waiting-user' && p.document && p.feedback.length <= (p.clarificationFeedbackCount ?? p.feedback.length)) {
        try { await this.syncDocument(p); }
        finally { if (!this.disposed) { await this.display(p); } }
        if (this.disposed) { throw new Error('任务服务已停止。'); }
      }
      // Document reads/card delivery can yield to cancellation or another resume.
      // Recheck state before scheduling any work.
      if (!['paused', 'failed', 'interrupted', 'waiting-user'].includes(p.status) || this.running.has(id)) { throw new Error('请等待当前回合收尾后再恢复。'); }
      if (p.status === 'waiting-user' && p.feedback.length <= (p.clarificationFeedbackCount ?? p.feedback.length)) { throw new Error('请先提交任务所需的补充信息，再继续。'); }
      p.status = 'running';
      p.clarification = undefined;
      p.clarificationFeedbackCount = undefined;
      p.error = undefined;
      p.stepCount = 0;
      this.record(p, '任务已开始，将按当前范围和待处理意见推进。');
    } else if (action === 'feedback') {
      if (!value.trim() || value.length > 3000) { throw new Error('请填写 3000 字以内的范围调整或补充意见。'); }
      p.feedback.push({ text: value, status: 'pending', at: new Date().toISOString() });
      this.record(p, '已收到任务调整；当前回合结果保留供追溯，下一回合按新意见处理。');
    } else if (action === 'stop-direction') {
      const d = p.directions.find(d => d.id === value);
      if (!d || d.status !== 'pending') { throw new Error('该方向已结束或不存在。'); }
      d.status = 'stopped';
      this.record(p, `已停止方向：${d.title}。在途结果不会计入有效发现。`);
    }
    await this.display(p);
    if (p.status === 'running') { this.start(p); }
  }
  private record(p: ProjectTask, text: string): void {
    p.updatedAt = new Date().toISOString();
    p.revision++;
    p.history.push({ at: p.updatedAt, text });
    this.store.save(p);
  }

  private async exportResult(p: ProjectTask): Promise<void> {
    const { document } = p;
    if (p.status !== 'completed' || !p.summary || !document?.snapshot || !this.readDocument || !this.appendDocument) {
      throw new Error('请先完成关联文档的任务，再追加成果。');
    }
    if (this.exporting.has(p.id)) { throw new Error('正在核对文档，请稍候。'); }
    if (document.export?.status === 'saved' || (document.export && document.publishedFragments?.includes(document.export.fragment))) {
      await this.display(p); return;
    }
    this.exporting.add(p.id);
    try {
      const previous = document.export;
      const reconcile = previous && ['writing', 'unknown'].includes(previous.status);
      const at = new Date().toISOString();
      const paragraphs = reconcile ? previous.fragment.split('\n') : resultParagraphs(p, at);
      const operation = reconcile ? previous : { id: randomUUID(), fragment: paragraphs.join('\n'), status: 'checking' as const,
        baseFingerprint: document.snapshot.fingerprint, at };
      document.export = operation;
      this.record(p, reconcile ? '正在核对上次文档追加，不重复发送写入。' : '正在检查文档是否有新意见，再追加成果快照。');
      await this.display(p);
      if (this.disposed) { return; }
      const fragments = document.publishedFragments ?? [];
      let latest = await documentDeadline(this.readDocument(document.token, reconcile ? [...fragments, operation.fragment] : fragments));
      if (this.disposed) { return; }
      if (latest.token !== document.token) { throw new Error('Document binding mismatch'); }
      if (!reconcile) {
        if (latest.fingerprint !== operation.baseFingerprint) {
          operation.status = 'conflict'; operation.error = '文档已有新修改，本次未追加成果。原成果和文档均保留，请从成果继续任务以处理新意见。';
          this.record(p, operation.error); return;
        }
        operation.status = 'writing';
        this.record(p, '正在追加成果快照，保留文档已有内容。');
        await documentDeadline(this.appendDocument(document.token, { id: operation.id, revision: latest.revision, paragraphs }));
        if (this.disposed) { return; }
        latest = await documentDeadline(this.readDocument(document.token, [...fragments, operation.fragment]));
        if (this.disposed) { return; }
        if (latest.token !== document.token) { throw new Error('Document binding mismatch'); }
      }
      const raw = latest.rawBody ?? latest.body;
      const index = raw.indexOf(operation.fragment);
      if (index < 0 || raw.indexOf(operation.fragment, index + operation.fragment.length) >= 0) {
        operation.status = 'unknown'; operation.error = '尚无法确认上次写入；本次没有重复追加。请检查文档，稍后再次核对，项目成果始终保留。';
      } else {
        document.publishedFragments = [...fragments, operation.fragment];
        if (latest.fingerprint !== operation.baseFingerprint) {
          operation.status = 'conflict'; operation.error = '成果快照已追加，但检测到并发修改。双方内容均保留，请从成果继续任务以处理新意见。';
        } else {
          operation.status = 'saved'; operation.error = undefined;
          document.snapshot = latest;
        }
      }
      this.record(p, operation.error ?? '成果快照已追加到关联文档，结论、证据和意见处理记录已核对。');
    } catch (error) {
      if (!this.disposed && document.export) {
        const operation = document.export;
        if (operation.status === 'writing') { operation.status = 'unknown'; }
        operation.error = operation.status === 'unknown' ? '写入结果尚未确认；再次操作只核对文档，不盲目重复追加。'
          : '文档核对未完成，未开始写入；请检查权限或网络后重试。';
        this.record(p, operation.error);
      } else if (!this.disposed) {
        this.record(p, error instanceof Error && /^[\p{Script=Han}]/u.test(error.message) ? error.message : '文档操作未完成，项目成果保留。');
      }
    } finally {
      this.exporting.delete(p.id);
      if (!this.disposed) { await this.display(p); }
    }
  }
  private display(p: ProjectTask): Promise<void> {
    const previous = this.publishing.get(p.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.disposed) { return; }
      try {
        p.cardId = await this.publish(structuredClone(p));
        p.deliveryError = undefined;
      } catch { p.deliveryError = '项目卡片更新失败；可用 /project 重新打开，已有进度保留。'; }
      if (!this.disposed) { this.store.save(p); }
    });
    this.publishing.set(p.id, next);
    void next.finally(() => { if (this.publishing.get(p.id) === next) { this.publishing.delete(p.id); } }).catch(() => {});
    return next;
  }
  private start(p: ProjectTask): void {
    if (this.running.has(p.id) || this.disposed || p.status !== 'running') { return; }
    const abort = new AbortController();
    const done = Promise.resolve().then(() => this.execute(p, abort.signal)).finally(() => this.running.delete(p.id));
    this.running.set(p.id, { abort, done });
    // Storage failures must not become unhandled rejections or trigger a second run.
    void done.catch(() => {});
  }
  private async syncDocument(p: ProjectTask): Promise<void> {
    const { document } = p;
    if (!document) { return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.readDocument) { throw new Error('Document reader unavailable'); }
      const snapshot = await Promise.race([this.readDocument(document.token, document.publishedFragments), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Document read timed out')), 30_000);
      })]);
      if (this.disposed) { return; }
      if (snapshot.token !== document.token) { throw new Error('Document binding mismatch'); }
      const changes = changedDocumentFeedback(document.snapshot, snapshot);
      if (changes.length) {
        if (document.snapshot) { document.previous.push(document.snapshot); }
        document.generation++;
        p.feedback.push(...changes.map(change => ({ text: change.text, status: 'pending' as const, at: snapshot.syncedAt,
          sourceKey: `${document.token}:${document.generation}:${change.key}` })));
      }
      document.snapshot = snapshot;
      document.error = undefined;
      this.record(p, changes.length ? '已同步文档正文与评论；新增或修改的意见等待处理，旧版本保留。' : '已核对文档最新正文与评论。');
    } catch {
      if (this.disposed) { return; }
      document.error = '文档未同步。请检查权限、内容大小或并发修改后恢复；已有成果保留，尚未读取的意见不会标为已处理。';
      this.record(p, document.error);
      throw new Error('Document sync failed');
    } finally { clearTimeout(timer); }
  }
  private applyCheckpoint(p: ProjectTask, snapshot: ProjectTask, result: TaskCheckpoint,
    pending: ProjectTask['feedback'], feedbackCount: number): void {
    const expected = pending.map(f => p.feedback.indexOf(f));
    if (result.state !== 'waiting-user' && (result.feedback.length !== expected.length
      || result.feedback.some(f => !expected.includes(f.feedbackIndex)))) {
      throw new Error('任务尚未逐条说明待处理意见。');
    }
    if (result.feedback.some(f => !expected.includes(f.feedbackIndex))) { throw new Error('意见不属于本次执行上下文。'); }
    // Validate the entire candidate before changing persisted user-visible state.
    const directions = structuredClone(p.directions);
    const updatedIds: string[] = [];
    for (const update of result.work) {
      if (update.id) {
        const prior = snapshot.directions.find(d => d.id === update.id);
        const target = directions.find(d => d.id === update.id);
        if (!prior || !target || prior.status !== 'pending' || target.status !== 'pending') {
          throw new Error('不能覆盖已结束或不存在的工作。');
        }
        if (!prior.findings.every(f => update.findings.some(next => JSON.stringify(next) === JSON.stringify(f)))) {
          throw new Error('工作更新不得删除已有证据。');
        }
        Object.assign(target, update);
        updatedIds.push(target.id);
      } else {
        const id = randomUUID();
        directions.push({ ...update, id });
        updatedIds.push(id);
      }
    }
    if (result.state === 'complete' && directions.some(d => d.status === 'pending')) {
      throw new Error('任务仍有待处理工作，不能标记完成。');
    }
    p.directions = directions;
    for (const decision of result.feedback) {
      const feedback = p.feedback[decision.feedbackIndex];
      feedback.status = decision.status;
      feedback.reason = decision.reason;
      feedback.directionIds = decision.workIndexes.map(index => updatedIds[index]);
    }
    this.record(p, result.message);
    if (result.state === 'waiting-user') {
      pending.filter(f => f.status === 'pending' || f.status === 'needs-clarification').forEach(f => {
        f.status = 'needs-clarification'; f.reason = result.clarification;
      });
      p.status = 'waiting-user'; p.clarification = result.clarification;
      p.clarificationFeedbackCount = feedbackCount;
      this.record(p, '任务需要补充信息，已停止自动推进。请提交回答后继续。');
    } else if (result.state === 'complete') {
      if (p.feedback.some(f => f.status === 'pending' || f.status === 'needs-clarification')) {
        this.record(p, '执行期间收到新意见，成果证据已保留，将处理最新反馈后再结束。');
      } else {
        p.summary = result.summary ?? ''; // Required by parseTaskCheckpoint for completion.
        p.questions = result.questions;
        p.status = 'completed'; this.record(p, '任务已完成，成果与来源保留。');
      }
    }
  }
  private async execute(p: ProjectTask, signal: AbortSignal): Promise<void> {
    try {
      while (!this.disposed && p.status === 'running') {
        await this.syncDocument(p);
        if (this.disposed || p.status !== 'running') { break; }
        if (p.stepCount >= 12) {
          p.status = 'paused';
          this.record(p, '本轮已执行 12 个执行回合，已暂停。请检查进展后决定是否继续。');
          break;
        }
        this.record(p, '正在根据当前目标、材料和反馈推进任务。');
        await this.display(p);
        if (this.disposed || p.status !== 'running') { break; }
        const pending = p.feedback.filter(f => f.status === 'pending' || f.status === 'needs-clarification').slice(0, 24);
        const feedbackCount = p.feedback.length;
        const snapshot = structuredClone(p);
        const result = parseTaskCheckpoint(JSON.stringify(await this.runner(snapshot, signal)));
        if (this.disposed || signal.aborted) { return; }
        if (p.status as string !== 'cancelling') { await this.syncDocument(p); }
        if (this.disposed || signal.aborted) { return; }
        p.stepCount++;
        if (p.status as string === 'cancelling') {
          p.status = 'cancelled';
          this.record(p, '任务已取消，在途结果未计入成果。');
          break;
        }
        // A user stop invalidates the in-flight checkpoint, including conclusions
        // whose dependency on the stopped work cannot be established safely.
        const stoppedDuringTurn = snapshot.directions.some(before => before.status !== 'stopped'
          && p.directions.find(d => d.id === before.id)?.status === 'stopped');
        if (stoppedDuringTurn) {
          this.record(p, '已丢弃停止工作时的在途结果，将按最新控制状态继续。');
        } else {
          this.applyCheckpoint(p, snapshot, result, pending, feedbackCount);
        }
        if (p.status as string === 'pausing') { p.status = 'paused'; this.record(p, '当前回合已收尾，任务已暂停。'); }
      }
      // A control operation can arrive while the pre-step card update is in flight.
      if (p.status === 'pausing') { p.status = 'paused'; this.record(p, '任务已暂停。'); }
      if (p.status === 'cancelling') { p.status = 'cancelled'; this.record(p, '任务已取消。'); }
    } catch (error) {
      if (!this.disposed) {
        if (p.status as string === 'cancelling') {
          p.status = 'cancelled';
          p.error = undefined;
          this.record(p, '任务已取消，在途回合未完成且结果未计入成果。');
        } else {
          p.status = 'failed';
          p.error = error instanceof ProjectTaskDirectoryError ? error.message : '当前回合未完成，已有成果保留。可检查材料后恢复重试。';
          this.record(p, p.error);
        }
      }
    } finally { if (!this.disposed) { await this.display(p); } }
  }
  async idle(id: string): Promise<void> { await this.running.get(id)?.done; }
  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const [id, run] of this.running) {
      run.abort.abort();
      const p = this.project(id);
      // The run remains registered while its final card is being delivered.
      // Preserve any committed settled state; only unfinished execution is interrupted.
      if (!['running', 'pausing', 'cancelling'].includes(p.status)) { continue; }
      p.status = p.status === 'cancelling' ? 'cancelled' : 'interrupted';
      this.record(p, '服务已停止。已有成果保留，下次打开可恢复。');
    }
    this.store.close();
  }
}
