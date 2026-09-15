import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';

export type ProjectStatus = 'running' | 'waiting-user' | 'pausing' | 'paused' | 'cancelling' | 'cancelled' | 'failed' | 'completed' | 'interrupted';
export interface Finding {
  claim: string;
  kind: 'fact' | 'inference' | 'uncertain';
  sources: Array<{ title: string; location: string; excerpt: string }>;
  caveat: string;
}
export interface Direction { id: string; title: string; status: 'pending' | 'done' | 'stopped'; findings: Finding[] }
export interface ResearchProject {
  id: string;
  owner: string;
  chat: string;
  thread?: string;
  source: string;
  title: string;
  scope: string;
  materials: string;
  status: ProjectStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  directions: Direction[];
  summary: string;
  questions: string[];
  history: Array<{ at: string; text: string }>;
  feedback: Array<{ text: string; status: 'pending' | 'applied' | 'rejected' | 'needs-clarification'; at: string; reason?: string; directionIds?: string[] }>;
  cardId?: string;
  deliveryError?: string;
  error?: string;
  clarification?: string;
  clarificationFeedbackCount?: number;
  parent?: string;
  priorResults?: { summary: string; findings: Finding[] };
  stepCount: number;
}
export type ResearchStep = { type: 'plan' } | { type: 'investigate'; directionId: string } | { type: 'synthesize' };
export interface FeedbackDecision { feedbackIndex: number; status: 'applied' | 'rejected'; reason: string; directionIndexes: number[] }
export type StepResult = { clarification: string } | { directions: string[]; feedbackDecisions?: FeedbackDecision[] } | { findings: Finding[] } | { summary: string; questions: string[] };

/** Validate output shape and required source fields; this does not verify source truth. */
export function parseStepResult(text: string, step: ResearchStep): StepResult {
  const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { throw new Error('研究结果格式不完整，请恢复后重试。'); }
    return v as Record<string, unknown>;
  };
  const str = (v: unknown, max: number, empty = false): string => {
    if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max) { throw new Error('研究结果字段无效，请恢复后重试。'); }
    return v;
  };
  const list = (v: unknown, max: number): unknown[] => {
    if (!Array.isArray(v) || v.length > max) { throw new Error('研究结果数量超出本次范围。'); }
    return v;
  };
  const r = object(value);
  if (r.clarification !== undefined && r.clarification !== null) { return { clarification: str(r.clarification, 1000) }; }
  if (step.type === 'plan') {
    const directions = list(r.directions, 4).map(v => str(v, 180));
    if (!directions.length) { throw new Error('研究计划为空。'); }
    const feedbackDecisions = list(r.feedbackDecisions ?? [], 24).map(v => {
      const decision = object(v);
      if (!Number.isSafeInteger(decision.feedbackIndex) || Number(decision.feedbackIndex) < 0
        || !['applied', 'rejected'].includes(String(decision.status))) { throw new Error('意见处理结果无效。'); }
      const directionIndexes = list(decision.directionIndexes, 4).map(index => {
        if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= directions.length) { throw new Error('意见引用了不存在的研究方向。'); }
        return Number(index);
      });
      if ((decision.status === 'applied') !== (directionIndexes.length > 0)) { throw new Error('已采纳意见需要关联实际计划，未采纳意见不得关联计划。'); }
      return { feedbackIndex: Number(decision.feedbackIndex), status: decision.status as FeedbackDecision['status'], reason: str(decision.reason, 700), directionIndexes };
    });
    return { directions, feedbackDecisions };
  }
  if (step.type === 'synthesize') {
    return { summary: str(r.summary, 3000), questions: list(r.questions, 6).map(v => str(v, 300)) };
  }
  return { findings: list(r.findings, 4).map(v => {
    const f = object(v);
    if (!['fact', 'inference', 'uncertain'].includes(String(f.kind))) { throw new Error('发现需要区分事实、推断和未知。'); }
    const sources = list(f.sources, 4).map(v => {
      const s = object(v);
      return { title: str(s.title, 160), location: str(s.location, 500), excerpt: str(s.excerpt, 400) };
    });
    if (f.kind === 'fact' && !sources.length) { throw new Error('事实性发现缺少来源。'); }
    return { claim: str(f.claim, 700), kind: f.kind as Finding['kind'], sources, caveat: str(f.caveat, 500, true) };
  }) };
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
      catch { throw new Error('研究存储正在恢复或恢复曾中断，请检查服务状态。'); }
      try {
        const pid = Number(readFileSync(lockPath, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) { throw new Error('研究存储锁无效，需要检查服务状态。'); }
        try { process.kill(pid, 0); }
        catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
            rmSync(lockPath);
            this.lock = openSync(lockPath, 'wx', 0o600);
          } else { throw new Error('另一个服务正在使用研究项目存储。'); }
        }
        if (this.lock === undefined) { throw new Error('另一个服务正在使用研究项目存储。'); }
      } finally { closeSync(recovery); rmSync(recoveryPath, { force: true }); }
    }
    writeFileSync(this.lock, String(process.pid));
  }
  readAll(): ResearchProject[] {
    this.open();
    return readdirSync(this.directory).filter(n => /^[a-f0-9-]+\.json$/u.test(n)).map(n => {
      const p = JSON.parse(readFileSync(path.join(this.directory, n), 'utf8')) as ResearchProject;
      if (`${p.id}.json` !== n || !Array.isArray(p.directions) || !Array.isArray(p.history)) { throw new Error('研究项目数据损坏，原文件已保留。'); }
      return p;
    });
  }
  save(project: ResearchProject): void {
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
