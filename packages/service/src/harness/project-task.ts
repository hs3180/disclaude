import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import type { DocumentSnapshot } from './document-source.js';

export class ProjectTaskDirectoryError extends Error {
  constructor() { super('任务工作目录不存在或不可访问。已有成果保留，请恢复原目录后重试；不会切换到其他项目目录。'); }
}

export type ProjectStatus = 'running' | 'waiting-user' | 'pausing' | 'paused' | 'cancelling' | 'cancelled' | 'failed' | 'completed' | 'interrupted';
export type Finding = import('./task-checkpoint.js').Evidence;
export interface Direction { id: string; title: string; status: 'pending' | 'done' | 'stopped'; findings: Finding[] }
export interface ProjectTask {
  id: string;
  /** Frozen at creation; absent in legacy research. Never inferred from the current chat. */
  workingDir?: string;
  /** Explicit navigation-only association for legacy research; never changes execution cwd. */
  projectLink?: { directory: string; token: string };
  linkPreview?: { directory: string; token: string };
  owner: string;
  chat: string;
  thread?: string;
  source: string;
  title: string;
  scope: string;
  materials: string;
  document?: { url: string; token: string; snapshot?: DocumentSnapshot; previous: DocumentSnapshot[]; generation: number; error?: string;
    publishedFragments?: string[];
    export?: { id: string; fragment: string; status: 'checking' | 'writing' | 'saved' | 'conflict' | 'unknown'; baseFingerprint: string; at: string; error?: string } };
  status: ProjectStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  directions: Direction[];
  summary: string;
  questions: string[];
  history: Array<{ at: string; text: string }>;
  feedback: Array<{ text: string; status: 'pending' | 'applied' | 'rejected' | 'needs-clarification'; at: string; reason?: string; directionIds?: string[]; sourceKey?: string }>;
  cardId?: string;
  deliveryError?: string;
  error?: string;
  clarification?: string;
  clarificationFeedbackCount?: number;
  parent?: string;
  parentFinding?: { directionId: string; index: number };
  priorResults?: { summary: string; findings: Finding[]; scope?: string };
  stepCount: number;
}
/** One service owns a store. The lock prevents a second process from recovering live work. */
export class ProjectStore {
  private lock?: number;
  constructor(readonly directory: string) {}
  open(): void {
    if (this.lock !== undefined) { return; }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.directory, '.owner');
    try { this.lock = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
      // Serialize stale-owner recovery before reading the owner. Otherwise two
      // reclaimers can both observe the dead PID and one can unlink the other's
      // newly acquired lock. A crash during recovery fails closed for inspection.
      const recoveryPath = path.join(this.directory, '.recovering');
      let recovery: number;
      try { recovery = openSync(recoveryPath, 'wx', 0o600); }
      catch { throw new Error('任务存储正在恢复或恢复曾中断，请检查服务状态。'); }
      try {
        const pid = Number(readFileSync(lockPath, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) { throw new Error('任务存储锁无效，需要检查服务状态。'); }
        try { process.kill(pid, 0); }
        catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
            rmSync(lockPath);
            this.lock = openSync(lockPath, 'wx', 0o600);
          } else { throw new Error('另一个服务正在使用任务存储。'); }
        }
        if (this.lock === undefined) { throw new Error('另一个服务正在使用任务存储。'); }
      } finally { closeSync(recovery); rmSync(recoveryPath, { force: true }); }
    }
    writeFileSync(this.lock, String(process.pid));
  }
  readAll(): ProjectTask[] {
    this.open();
    return readdirSync(this.directory).filter(n => /^[a-f0-9-]+\.json$/u.test(n)).map(n => {
      const p = JSON.parse(readFileSync(path.join(this.directory, n), 'utf8')) as ProjectTask;
      if (`${p.id}.json` !== n || !Array.isArray(p.directions) || !Array.isArray(p.history)) { throw new Error('任务数据损坏，原文件已保留。'); }
      return p;
    });
  }
  save(project: ProjectTask): void {
    this.open();
    const target = path.join(this.directory, `${project.id}.json`);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(project, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(temp, target);
    } finally { rmSync(temp, { force: true }); }
  }
  close(): void {
    if (this.lock === undefined) { return; }
    closeSync(this.lock);
    this.lock = undefined;
    rmSync(path.join(this.directory, '.owner'), { force: true });
  }
}
