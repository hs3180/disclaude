import { parseAgentInputParams, validateAgentInputAnswers, type AgentInputRequest, type AgentInputParams } from '../../user-input.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

export class CodexAsyncInputDeliveryError extends Error {
  readonly code: string;
  constructor(reason: 'unsupported' | 'delivery-failed' = 'delivery-failed') {
    super(reason === 'unsupported'
      ? 'Async question was not delivered: asynchronous answers are unsupported in this conversation.'
      : 'Async question was not delivered: the channel could not confirm card delivery.');
    this.code = reason === 'unsupported' ? 'CODEX_ASYNC_INPUT_UNSUPPORTED' : 'CODEX_ASYNC_INPUT_DELIVERY_FAILED';
    this.name = 'CodexAsyncInputDeliveryError';
  }
}

interface AsyncInputDelivery {
  deliver?: (request: AgentInputRequest) => Promise<void>;
  submit?: (request: AgentInputRequest, text: string) => Promise<void>;
  onError?: (error: CodexAsyncInputDeliveryError) => void;
  /**
   * Issue #5467: invoked instead of onError when the failure is a KNOWN
   * capability mismatch ("unsupported"), carrying the question preformatted
   * as plain text. The host renders it as an ordinary assistant message so
   * the user can still answer in-band; the turn completes normally instead
   * of dumping the host error string into the chat.
   */
  onDegraded?: (text: string) => void;
}

/** Plain-text rendering of an async question for sessions without interactive forms (#5467). */
export function formatAgentInputQuestionsAsText(params: AgentInputParams): string {
  const lines = ['💬 任务需要你的输入（当前会话不支持交互式回答，请直接在聊天中回复）：'];
  params.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.header ? `${question.header}：` : ''}${question.question}`);
    if (question.options?.length) {
      lines.push(`   选项：${question.options
        .map(option => option.label + (option.description ? `（${option.description}）` : ''))
        .join(' / ')}`);
    }
  });
  return lines.join('\n');
}

/** Notification-based questions have no pending server RPC to answer. */
export class CodexAsyncUserInput {
  private closed = false;
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, { request: AgentInputRequest; abort: AbortController }>();
  private readonly deliveries = new Map<string, { params: AgentInputParams; flight: Promise<void> }>();

  constructor(
    private readonly deliver: ((request: AgentInputRequest) => Promise<void>) | undefined,
    private readonly steer: (threadId: string, turnId: string, text: string) => Promise<void>,
    private readonly timeoutMs = 15 * 60_000,
  ) {}

  receive(raw: unknown, delivery: AsyncInputDelivery = {}): boolean {
    if (this.closed) { return false; }
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
    } catch {
      if (delivery.onError) { delivery.onError(new CodexAsyncInputDeliveryError()); return true; }
      return false;
    }
    const deliver = delivery.deliver ?? this.deliver;
    if (!deliver && !delivery.onError) { return false; }
    const key = JSON.stringify([params.threadId, params.turnId, params.itemId]);
    if (this.seen.has(key)) { return true; }
    if (this.seen.size >= 1000) {
      delivery.onError?.(new CodexAsyncInputDeliveryError());
      return !!delivery.onError;
    }
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
          if (delivery.submit) { await delivery.submit(request, text); }
          else { await this.steer(params.threadId, params.turnId, text); }
          if (abort.signal.aborted) { throw new Error('Async answer delivery became uncertain'); }
          cleanup();
        } catch {
          abort.abort('unavailable');
          throw new Error('Async answer delivery failed');
        }
      },
    };
    this.pending.set(key, { request, abort });
    let rejectCancelled!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = () => reject(new CodexAsyncInputDeliveryError());
      abort.signal.addEventListener('abort', rejectCancelled, { once: true });
    });
    const flight = Promise.race([
      cancelled,
      Promise.resolve().then(async () => {
        if (!deliver) { throw new CodexAsyncInputDeliveryError('unsupported'); }
        if (abort.signal.aborted) { throw new CodexAsyncInputDeliveryError(); }
        await deliver(request);
        if (abort.signal.aborted) { throw new CodexAsyncInputDeliveryError(); }
      }),
    ]).catch(error => {
      abort.abort('unavailable');
      let mapped: CodexAsyncInputDeliveryError;
      if (error instanceof CodexAsyncInputDeliveryError) { mapped = error; }
      else if (error instanceof Error && 'code' in error && error.code === 'AGENT_ASYNC_INPUT_UNSUPPORTED') {
        mapped = new CodexAsyncInputDeliveryError('unsupported');
      } else { mapped = new CodexAsyncInputDeliveryError(); }
      // #5467: "unsupported" is a session capability mismatch, not a delivery
      // accident — every origin (no interactive channel wired, no input
      // context / answer host, once-mode or stale-session rejection
      // downstream) degrades the same way: hand the host the question as
      // plain text and resolve, so the turn completes normally instead of
      // surfacing the host error string in the chat.
      if (mapped.code === 'CODEX_ASYNC_INPUT_UNSUPPORTED' && delivery.onDegraded) {
        delivery.onDegraded(formatAgentInputQuestionsAsText(params));
        return;
      }
      throw mapped;
    }).finally(() => abort.signal.removeEventListener('abort', rejectCancelled));
    this.deliveries.set(key, { params, flight });
    void flight.catch(error => delivery.onError?.(error as CodexAsyncInputDeliveryError));
    return true;
  }

  /** A native completed turn is not a delivery receipt for its questions. */
  async waitForDelivery(threadId: string, turnId: string): Promise<void> {
    await Promise.all([...this.deliveries.values()].filter(entry => entry.params.threadId === threadId
      && entry.params.turnId === turnId).map(entry => entry.flight));
  }

  releaseDelivery(threadId: string, turnId: string): void {
    for (const [key, entry] of this.deliveries) {
      if (entry.params.threadId === threadId && entry.params.turnId === turnId) { this.deliveries.delete(key); }
    }
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
