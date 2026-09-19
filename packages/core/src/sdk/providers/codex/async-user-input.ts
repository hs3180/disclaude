import { parseAgentInputParams, validateAgentInputAnswers, type AgentInputRequest } from '../../user-input.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Notification-based questions have no pending server RPC to answer. */
export class CodexAsyncUserInput {
  private closed = false;
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, { request: AgentInputRequest; abort: AbortController }>();

  constructor(
    private readonly deliver: ((request: AgentInputRequest) => Promise<void>) | undefined,
    private readonly steer: (threadId: string, turnId: string, text: string) => Promise<void>,
    private readonly timeoutMs = 15 * 60_000,
  ) {}

  receive(raw: unknown): boolean {
    if (this.closed || !this.deliver) { return false; }
    const event = object(raw), item = object(event.item);
    if (item.type !== 'agentMessage' || !Array.isArray(item.questions) || !item.questions.length) { return false; }
    let params;
    try {
      params = parseAgentInputParams({ threadId: event.threadId, turnId: event.turnId, itemId: item.id, isBlocking: false,
        questions: item.questions.map((value, index) => {
          const question = object(value);
          if (question.options !== undefined && question.options !== null && !Array.isArray(question.options)) { throw new Error('Invalid options'); }
          return { id: `question-${index + 1}`, header: '', question: question.title, isOther: true, isSecret: false,
            options: Array.isArray(question.options) ? question.options.map(label => ({ label, description: '' })) : null };
        }) });
    } catch { return false; }
    const key = JSON.stringify([params.threadId, params.turnId, params.itemId]);
    if (this.seen.has(key)) { return true; }
    if (this.seen.size >= 1000) { return false; }
    this.seen.add(key);
    const abort = new AbortController();
    let writing = false;
    const timer = setTimeout(() => abort.abort('expired'), this.timeoutMs);
    timer.unref();
    const cleanup = (): void => { clearTimeout(timer); this.pending.delete(key); };
    abort.signal.addEventListener('abort', cleanup, { once: true });
    const request: AgentInputRequest = { ...params, kind: 'async-message', requestId: params.itemId, signal: abort.signal,
      respond: async value => {
        if (abort.signal.aborted || writing || !this.pending.has(key)) { throw new Error('Async question is no longer active'); }
        const answers = validateAgentInputAnswers(params, value);
        writing = true;
        // Preserve complete option strings and question association. These are
        // ordinary, non-secret user answers; never approval decisions.
        const text = `Submitted answers to your questions:\n${JSON.stringify(params.questions.map(question => ({
          question: question.question, answers: answers[question.id].answers,
        })))}`;
        try {
          await this.steer(params.threadId, params.turnId, text);
          if (abort.signal.aborted) { throw new Error('Async answer delivery became uncertain'); }
          cleanup();
        } catch {
          abort.abort('unavailable');
          throw new Error('Async answer delivery failed');
        }
      },
    };
    this.pending.set(key, { request, abort });
    void Promise.resolve().then(() => {
      if (!abort.signal.aborted) { return this.deliver?.(request); }
      return undefined;
    }).catch(() => abort.abort('unavailable'));
    return true;
  }

  cancel(reason: string, threadId?: string, turnId?: string): void {
    for (const { request, abort } of this.pending.values()) {
      if ((!threadId || request.threadId === threadId) && (!turnId || request.turnId === turnId)) { abort.abort(reason); }
    }
  }

  close(): void {
    this.closed = true;
    this.cancel('closed');
  }
}
