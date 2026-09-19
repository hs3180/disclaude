import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInputRequest } from '../../user-input.js';
import { CodexAsyncUserInput } from './async-user-input.js';

const event = { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'question-item', type: 'agentMessage',
  questions: [{ title: 'Choose an option', options: ['Alpha — first option', 'Beta — second option'] }, { title: 'Any constraint?' }] } };
afterEach(() => vi.useRealTimers());

describe('Codex asynchronous question notifications', () => {
  it('preserves question/option text and delivers one non-secret answer to the originating turn', async () => {
    const deliver = vi.fn<(request: AgentInputRequest) => Promise<void>>().mockResolvedValue();
    let release!: () => void;
    const steer = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const handler = new CodexAsyncUserInput(deliver, steer);
    try {
      expect(handler.receive(event)).toBe(true);
      expect(handler.receive(event)).toBe(true);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      const [[request]] = deliver.mock.calls;
      expect(request).toMatchObject({ kind: 'async-message', requestId: 'question-item', isBlocking: false });
      expect(request.questions.map(q => q.isSecret)).toEqual([false, false]);
      expect(request.questions[0].options?.map(o => o.label)).toEqual(event.item.questions[0].options);
      await expect(request.respond({})).rejects.toThrow();
      expect(steer).not.toHaveBeenCalled();
      const answer = { 'question-1': { answers: ['Beta — second option'] }, 'question-2': { answers: ['No extensions'] } };
      const first = request.respond(answer);
      await expect(request.respond(answer)).rejects.toThrow(/no longer active/);
      expect(steer).toHaveBeenCalledTimes(1);
      expect(steer.mock.calls[0]).toEqual(['thread-1', 'turn-1', 'Submitted answers to your questions:\n[{"question":"Choose an option","answers":["Beta — second option"]},{"question":"Any constraint?","answers":["No extensions"]}]']);
      release(); await first;
      await expect(request.respond(answer)).rejects.toThrow(/no longer active/);
    } finally { handler.cancel('closed'); }
  });

  it.each(['expired', 'cancelled', 'turn-ended', 'closed'])('invalidates pending questions on %s without steering', async reason => {
    vi.useFakeTimers();
    const deliver = vi.fn<(request: AgentInputRequest) => Promise<void>>().mockResolvedValue();
    const steer = vi.fn().mockResolvedValue(undefined);
    const handler = new CodexAsyncUserInput(deliver, steer, 100);
    handler.receive(event); await Promise.resolve();
    const [[request]] = deliver.mock.calls;
    handler.cancel('cancelled', 'other-thread');
    expect(request.signal.aborted).toBe(false);
    if (reason === 'expired') { await vi.advanceTimersByTimeAsync(100); }
    else { handler.cancel(reason, event.threadId, event.turnId); }
    expect(request.signal.reason).toBe(reason);
    await expect(request.respond({})).rejects.toThrow(/no longer active/);
    expect(steer).not.toHaveBeenCalled();
  });

  it('never retries an uncertain steer or marks it successful', async () => {
    const deliver = vi.fn<(request: AgentInputRequest) => Promise<void>>().mockResolvedValue();
    const steer = vi.fn().mockRejectedValue(new Error('response lost'));
    const handler = new CodexAsyncUserInput(deliver, steer);
    handler.receive(event); await Promise.resolve();
    const [[request]] = deliver.mock.calls;
    const answer = { 'question-1': { answers: ['Alpha'] }, 'question-2': { answers: ['None'] } };
    await expect(request.respond(answer)).rejects.toThrow(/delivery failed/);
    expect(request.signal.reason).toBe('unavailable');
    await expect(request.respond(answer)).rejects.toThrow(/no longer active/);
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary text and unsupported question shapes on the text path', () => {
    const deliver = vi.fn().mockResolvedValue(undefined), steer = vi.fn();
    const handler = new CodexAsyncUserInput(deliver, steer);
    expect(handler.receive({ ...event, item: { ...event.item, questions: [{ title: 'Bad', options: [42] }] } })).toBe(false);
    expect(handler.receive({ ...event, item: { ...event.item, questions: [] } })).toBe(false);
    expect(new CodexAsyncUserInput(undefined, steer).receive(event)).toBe(false);
    handler.close();
    expect(handler.receive(event)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});
