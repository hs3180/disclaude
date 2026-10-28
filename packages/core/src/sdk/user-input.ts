/** Host-only input requests: RPC answers resolve their request; async answers retain their conversation. */
export interface AgentInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}
export interface AgentInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  isBlocking: boolean;
  questions: AgentInputQuestion[];
}
export type AgentInputAnswers = Record<string, { answers: string[] }>;
export interface AgentInputRequest extends AgentInputParams {
  /** Async messages use their live turn or new host-admitted input after normal completion. */
  kind?: 'rpc' | 'async-message';
  /** RPC request ID, or the message item ID when kind is async-message. */
  requestId: string | number;
  signal: AbortSignal;
  /** RPC: response written. Async: live-turn acknowledgement or new-input admission; never replay the original request. */
  respond(answers: AgentInputAnswers): Promise<void>;
}
export interface AgentInputContext {
  chatId: string;
  actorId: string;
  sourceMessageId: string;
  threadRootId?: string;
  /** Platform reply anchor; null explicitly means direct chat delivery. */
  replyRootId?: string | null;
}

/** Only bounded codes and host-owned labels cross the channel/provider error boundary. */
export class AgentInputDeliveryError extends Error {
  readonly code = 'AGENT_INPUT_DELIVERY_FAILED';
  readonly diagnostic;

  constructor(detail: {
    channel: 'feishu'; operation: 'public-card' | 'private-card';
    stage: 'send' | 'receipt' | 'target-check' | 'update'; outcome: 'rejected' | 'unknown' | 'delivered';
    httpStatus?: unknown; apiCode?: unknown; transportCode?: unknown;
  }) {
    const integer = (value: unknown, min: number, max: number): number | undefined =>
      typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
    const transportCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNABORTED',
      'ERR_NETWORK', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'ERR_CANCELED', 'ABORT_ERR',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'];
    const diagnostic = { channel: detail.channel, operation: detail.operation, stage: detail.stage, outcome: detail.outcome,
      httpStatus: integer(detail.httpStatus, 100, 599), apiCode: integer(detail.apiCode, -2147483648, 2147483647),
      transportCode: typeof detail.transportCode === 'string' && transportCodes.includes(detail.transportCode) ? detail.transportCode : undefined };
    super(`Input card could not be delivered: ${JSON.stringify(diagnostic)}`);
    this.name = 'AgentInputDeliveryError';
    this.diagnostic = Object.freeze(diagnostic);
  }
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid user-input request'); }
  return value as Record<string, unknown>;
};
const string = (value: unknown, max: number, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) { throw new Error('Invalid user-input field'); }
  return value;
};
export function parseAgentInputParams(value: unknown): AgentInputParams {
  const p = object(value);
  if (typeof p.isBlocking !== 'boolean' || !Array.isArray(p.questions) || !p.questions.length || p.questions.length > 10) {
    throw new Error('Unsupported user-input request');
  }
  const questions = p.questions.map(value => {
    const q = object(value);
    if ((q.isOther !== undefined && typeof q.isOther !== 'boolean') || (q.isSecret !== undefined && typeof q.isSecret !== 'boolean')) {
      throw new Error('Invalid user-input flags');
    }
    if (q.options !== undefined && q.options !== null && (!Array.isArray(q.options) || q.options.length > 30)) {
      throw new Error('Unsupported user-input options');
    }
    const options = Array.isArray(q.options) ? q.options.map(value => {
      const option = object(value);
      return { label: string(option.label, 300), description: string(option.description, 2000, true) };
    }) : null;
    if (options && new Set(options.map(o => o.label)).size !== options.length) { throw new Error('Ambiguous user-input options'); }
    return { id: string(q.id, 200), header: string(q.header, 300, true), question: string(q.question, 6000),
      isOther: q.isOther === true, isSecret: q.isSecret === true, options };
  });
  if (new Set(questions.map(q => q.id)).size !== questions.length) { throw new Error('Duplicate user-input question IDs'); }
  return { threadId: string(p.threadId, 200), turnId: string(p.turnId, 200), itemId: string(p.itemId, 200), isBlocking: p.isBlocking, questions };
}

export function validateAgentInputAnswers(params: AgentInputParams, value: unknown): AgentInputAnswers {
  const answers = object(value);
  const ids = params.questions.map(q => q.id);
  if (Object.keys(answers).length !== ids.length || Object.keys(answers).some(id => !ids.includes(id))) { throw new Error('Answer every question'); }
  const result: AgentInputAnswers = Object.create(null) as AgentInputAnswers;
  for (const q of params.questions) {
    const answer = object(answers[q.id]);
    if (!Array.isArray(answer.answers) || !answer.answers.length || answer.answers.length > 10) { throw new Error('Missing answer'); }
    const values = answer.answers.map(value => string(value, 12_000));
    if (q.options?.length && !q.isOther && values.some(value => !q.options?.some(option => option.label === value))) {
      throw new Error('Answer must match an offered option');
    }
    result[q.id] = { answers: values };
  }
  return result;
}
