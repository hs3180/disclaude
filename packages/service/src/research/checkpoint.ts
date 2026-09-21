/**
 * Durable checkpoint contract for a project-scoped research turn.
 *
 * This is intentionally Research-specific. It is not a generic task runner
 * or a second task database: the checkpoint is only the model/runner boundary
 * for the Research lifecycle owned by ProjectManager.
 */

export type ResearchFindingKind = 'fact' | 'inference' | 'uncertain';

export interface ResearchSource {
  title: string;
  location: string;
  excerpt: string;
}

export interface ResearchFinding {
  claim: string;
  kind: ResearchFindingKind;
  sources: ResearchSource[];
  caveat?: string;
}

export type ResearchDirectionStatus = 'pending' | 'done' | 'stopped';

export interface ResearchWorkUpdate {
  /** Existing pending direction to update; omitted for a new direction. */
  id?: string;
  title: string;
  status: ResearchDirectionStatus;
  findings: ResearchFinding[];
}

export type ResearchFeedbackStatus = 'applied' | 'rejected';

export interface ResearchFeedbackReceipt {
  feedbackIndex: number;
  status: ResearchFeedbackStatus;
  reason: string;
  /** Indexes into this checkpoint's `work` array. */
  workIndexes: number[];
}

export interface ResearchCheckpoint {
  state: 'continue' | 'waiting-user' | 'complete';
  message: string;
  work: ResearchWorkUpdate[];
  feedback: ResearchFeedbackReceipt[];
  summary?: string;
  questions: string[];
  clarification?: string;
}

const MAX_MESSAGE = 1000;
const MAX_TITLE = 180;
const MAX_CLAIM = 700;
const MAX_LOCATION = 500;
const MAX_EXCERPT = 400;
const MAX_CAVEAT = 500;
const MAX_REASON = 700;
const MAX_SUMMARY = 3000;
const MAX_CLARIFICATION = 1000;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Research checkpoint ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) {
    throw new Error(
      `Research checkpoint ${label} must be a non-empty string of at most ${max} characters`
    );
  }
  return value;
}

function stringArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`Research checkpoint ${label} must contain at most ${maxItems} items`);
  }
  return value.map((item, index) => boundedString(item, `${label}[${index}]`, maxLength));
}

function parseSource(value: unknown, index: number): ResearchSource {
  const source = asRecord(value, `source[${index}]`);
  return {
    title: boundedString(source.title, `source[${index}].title`, 160),
    location: boundedString(source.location, `source[${index}].location`, MAX_LOCATION),
    excerpt: boundedString(source.excerpt, `source[${index}].excerpt`, MAX_EXCERPT),
  };
}

function parseFinding(value: unknown, index: number): ResearchFinding {
  const finding = asRecord(value, `finding[${index}]`);
  const { kind } = finding;
  if (kind !== 'fact' && kind !== 'inference' && kind !== 'uncertain') {
    throw new Error(`Research checkpoint finding[${index}].kind is invalid`);
  }
  if (
    !Array.isArray(finding.sources) ||
    finding.sources.length === 0 ||
    finding.sources.length > 4
  ) {
    throw new Error(`Research checkpoint finding[${index}].sources must contain 1–4 items`);
  }
  return {
    claim: boundedString(finding.claim, `finding[${index}].claim`, MAX_CLAIM),
    kind,
    sources: finding.sources.map((source, sourceIndex) => parseSource(source, sourceIndex)),
    ...(finding.caveat === undefined
      ? {}
      : { caveat: boundedString(finding.caveat, `finding[${index}].caveat`, MAX_CAVEAT, false) }),
  };
}

function parseWork(value: unknown, index: number): ResearchWorkUpdate {
  const work = asRecord(value, `work[${index}]`);
  const { status } = work;
  if (status !== 'pending' && status !== 'done' && status !== 'stopped') {
    throw new Error(`Research checkpoint work[${index}].status is invalid`);
  }
  if (!Array.isArray(work.findings) || work.findings.length > 4) {
    throw new Error(`Research checkpoint work[${index}].findings must contain at most 4 items`);
  }
  const id = work.id === undefined ? undefined : boundedString(work.id, `work[${index}].id`, 100);
  return {
    ...(id ? { id } : {}),
    title: boundedString(work.title, `work[${index}].title`, MAX_TITLE),
    status,
    findings: work.findings.map((finding, findingIndex) => parseFinding(finding, findingIndex)),
  };
}

function parseFeedback(value: unknown, index: number): ResearchFeedbackReceipt {
  const feedback = asRecord(value, `feedback[${index}]`);
  if (!Number.isSafeInteger(feedback.feedbackIndex) || (feedback.feedbackIndex as number) < 0) {
    throw new Error(`Research checkpoint feedback[${index}].feedbackIndex is invalid`);
  }
  if (feedback.status !== 'applied' && feedback.status !== 'rejected') {
    throw new Error(`Research checkpoint feedback[${index}].status is invalid`);
  }
  if (
    !Array.isArray(feedback.workIndexes) ||
    feedback.workIndexes.some((item) => !Number.isSafeInteger(item) || (item as number) < 0)
  ) {
    throw new Error(`Research checkpoint feedback[${index}].workIndexes is invalid`);
  }
  return {
    feedbackIndex: feedback.feedbackIndex as number,
    status: feedback.status,
    reason: boundedString(feedback.reason, `feedback[${index}].reason`, MAX_REASON),
    workIndexes: feedback.workIndexes as number[],
  };
}

/** Parse a model result, accepting a single JSON code fence but no free-form prose. */
export function parseResearchCheckpoint(input: string | unknown): ResearchCheckpoint {
  let value: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
    const json = (fenced?.[1] ?? trimmed).trim();
    try {
      value = JSON.parse(json) as unknown;
    } catch (error) {
      throw new Error(
        `Research checkpoint is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const checkpoint = asRecord(value, 'root');
  if (
    checkpoint.state !== 'continue' &&
    checkpoint.state !== 'waiting-user' &&
    checkpoint.state !== 'complete'
  ) {
    throw new Error('Research checkpoint state is invalid');
  }
  if (!Array.isArray(checkpoint.work) || checkpoint.work.length > 8) {
    throw new Error('Research checkpoint work must contain at most 8 items');
  }
  if (!Array.isArray(checkpoint.feedback) || checkpoint.feedback.length > 24) {
    throw new Error('Research checkpoint feedback must contain at most 24 items');
  }
  const questions =
    checkpoint.questions === undefined
      ? []
      : stringArray(checkpoint.questions, 'questions', 6, 300);
  const result: ResearchCheckpoint = {
    state: checkpoint.state,
    message: boundedString(checkpoint.message, 'message', MAX_MESSAGE),
    work: checkpoint.work.map((work, index) => parseWork(work, index)),
    feedback: checkpoint.feedback.map((feedback, index) => parseFeedback(feedback, index)),
    questions,
  };
  if (checkpoint.summary !== undefined) {
    result.summary = boundedString(checkpoint.summary, 'summary', MAX_SUMMARY);
  }
  if (checkpoint.clarification !== undefined) {
    result.clarification = boundedString(
      checkpoint.clarification,
      'clarification',
      MAX_CLARIFICATION
    );
  }
  if (result.state === 'complete' && !result.summary) {
    throw new Error('Research checkpoint complete requires summary');
  }
  if (result.state === 'waiting-user' && !result.clarification) {
    throw new Error('Research checkpoint waiting-user requires clarification');
  }
  return result;
}
