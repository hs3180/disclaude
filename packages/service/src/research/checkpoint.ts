/** Durable, domain-independent evidence and work updates, not execution stages. */
export interface Evidence {
  claim: string;
  kind: 'fact' | 'inference' | 'uncertain';
  sources: Array<{ title: string; location: string; excerpt: string }>;
  caveat: string;
}
export interface WorkUpdate {
  /** Omit for new work; existing completed/stopped work is immutable. */
  id?: string;
  title: string;
  status: 'pending' | 'done' | 'stopped';
  findings: Evidence[];
}
export interface ResearchCheckpoint {
  state: 'continue' | 'waiting-user' | 'complete';
  message: string;
  work: WorkUpdate[];
  feedback: Array<{ feedbackIndex: number; status: 'applied' | 'rejected'; reason: string; workIndexes: number[] }>;
  summary?: string;
  questions: string[];
  clarification?: string;
}

/** Shape/size validation only: valid source fields are not verification of truth. */
export function parseResearchCheckpoint(text: string): ResearchCheckpoint {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { throw new Error('Invalid task checkpoint object'); }
    return v as Record<string, unknown>;
  };
  const str = (v: unknown, max: number, empty = false): string => {
    if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max) { throw new Error('Invalid task checkpoint text'); }
    return v;
  };
  const list = (v: unknown, max: number): unknown[] => {
    if (!Array.isArray(v) || v.length > max) { throw new Error('Invalid task checkpoint list'); }
    return v;
  };
  const r = object(JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')));
  if (!['continue', 'waiting-user', 'complete'].includes(String(r.state))) { throw new Error('Invalid task checkpoint state'); }
  const work = list(r.work ?? [], 8).map(value => {
    const w = object(value);
    if (!['pending', 'done', 'stopped'].includes(String(w.status))) { throw new Error('Invalid work status'); }
    return { id: w.id === null || w.id === undefined ? undefined : str(w.id, 100), title: str(w.title, 180), status: w.status as WorkUpdate['status'],
      findings: list(w.findings ?? [], 4).map(value => {
        const f = object(value);
        if (!['fact', 'inference', 'uncertain'].includes(String(f.kind))) { throw new Error('Invalid evidence kind'); }
        const sources = list(f.sources, 4).map(value => {
          const s = object(value);
          return { title: str(s.title, 160), location: str(s.location, 500), excerpt: str(s.excerpt, 400) };
        });
        if (f.kind === 'fact' && !sources.length) { throw new Error('Factual evidence requires sources'); }
        return { claim: str(f.claim, 700), kind: f.kind as Evidence['kind'], sources, caveat: f.caveat === undefined ? '' : str(f.caveat, 500, true) };
      }) };
  });
  const ids = work.flatMap(w => w.id ? [w.id] : []);
  if (new Set(ids).size !== ids.length) { throw new Error('Duplicate work update'); }
  const feedback = list(r.feedback ?? [], 24).map(value => {
    const f = object(value);
    if (!Number.isSafeInteger(f.feedbackIndex) || Number(f.feedbackIndex) < 0 || !['applied', 'rejected'].includes(String(f.status))) {
      throw new Error('Invalid feedback disposition');
    }
    const workIndexes = list(f.workIndexes, 8).map(value => {
      if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= work.length) { throw new Error('Invalid feedback work reference'); }
      return Number(value);
    });
    if ((f.status === 'applied') !== (workIndexes.length > 0)) { throw new Error('Applied feedback requires an actual work update'); }
    return { feedbackIndex: Number(f.feedbackIndex), status: f.status as 'applied' | 'rejected', reason: str(f.reason, 700), workIndexes };
  });
  if (new Set(feedback.map(f => f.feedbackIndex)).size !== feedback.length) { throw new Error('Duplicate feedback disposition'); }
  const summary = r.summary === null || r.summary === undefined ? undefined : str(r.summary, 3000);
  const clarification = r.clarification === null || r.clarification === undefined ? undefined : str(r.clarification, 1000);
  if (r.state === 'complete' && !summary) { throw new Error('Completed task requires a result'); }
  if (r.state === 'waiting-user' && !clarification) { throw new Error('Waiting task requires a question'); }
  return { state: r.state as ResearchCheckpoint['state'], message: str(r.message, 1000), work, feedback, summary,
    questions: list(r.questions ?? [], 6).map(v => str(v, 300)), clarification };
}
