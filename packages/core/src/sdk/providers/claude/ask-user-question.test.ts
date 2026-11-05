/**
 * Tests for the AskUserQuestion → host input channel bridge (T-057 / #5613).
 *
 * Covers the input mapping (AskUserQuestionInput.questions → channel
 * questions, fail-closed on malformed shapes) and the canUseTool permission
 * callback: answer flow, and every fail-closed path (no context, malformed
 * input, delivery failure, timeout, external abort, stale respond).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASK_USER_QUESTION_TIMEOUT_MS,
  createAskUserQuestionPermission,
  formatAgentInputAnswers,
  parseAskUserQuestions,
} from './ask-user-question.js';
import type { AgentInputAnswers, AgentInputContext, AgentInputRequest } from '../../user-input.js';

function toolInput(): Record<string, unknown> {
  return {
    questions: [
      {
        question: 'Deploy now?',
        header: 'Deploy',
        options: [
          { label: 'Yes', description: 'Ship it' },
          { label: 'No', description: 'Hold' },
        ],
      },
    ],
  };
}

function context(): AgentInputContext {
  return {
    actorId: 'user-1',
    chatId: 'chat-1',
    sourceMessageId: 'msg-1',
  } as AgentInputContext;
}

function bridge(overrides: Partial<Parameters<typeof createAskUserQuestionPermission>[0]> = {}) {
  const seen: Array<{ request: AgentInputRequest; context: AgentInputContext | undefined }> = [];
  let current: AgentInputContext | undefined = context();
  const permission = createAskUserQuestionPermission({
    onUserInput: (request, ctx) => { seen.push({ request, context: ctx }); return Promise.resolve(); },
    inputContext: () => current,
    sessionKey: 'sess',
    queryId: 'turn-1',
    ...overrides,
  });
  return { permission, seen, setContext: (next: AgentInputContext | undefined) => { current = next; } };
}

function callOptions(signal = new AbortController().signal) {
  return { signal, toolUseID: 'tooluse-1', requestId: 'req-1' };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('parseAskUserQuestions', () => {
  it('maps each question with sequential ids and the Other free-text fallback', () => {
    const questions = parseAskUserQuestions({
      questions: [
        {
          question: 'First?',
          header: 'One',
          options: [{ label: 'A', description: 'a' }, { label: 'B', description: '' }],
        },
        {
          question: 'Second?',
          header: 'Two',
          options: [{ label: 'C', description: 'c' }, { label: 'D', description: 'd' }],
        },
      ],
    });
    expect(questions).toEqual([
      {
        id: 'q1', header: 'One', question: 'First?', isOther: true, isSecret: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: '' }],
      },
      {
        id: 'q2', header: 'Two', question: 'Second?', isOther: true, isSecret: false,
        options: [{ label: 'C', description: 'c' }, { label: 'D', description: 'd' }],
      },
    ]);
  });

  it.each([
    ['no questions key', {}],
    ['empty questions', { questions: [] }],
    ['five questions', { questions: Array.from({ length: 5 }, (_, i) => ({ question: `q${i}`, header: 'h', options: [{ label: 'a' }, { label: 'b' }] })) }],
    ['one option', { questions: [{ question: 'q', header: 'h', options: [{ label: 'a' }] }] }],
    ['five options', { questions: [{ question: 'q', header: 'h', options: Array.from({ length: 5 }, (_, i) => ({ label: `o${i}` })) }] }],
    ['duplicate option labels', { questions: [{ question: 'q', header: 'h', options: [{ label: 'a' }, { label: 'a' }] }] }],
    ['missing question text', { questions: [{ header: 'h', options: [{ label: 'a' }, { label: 'b' }] }] }],
    ['over-long header', { questions: [{ question: 'q', header: 'h'.repeat(301), options: [{ label: 'a' }, { label: 'b' }] }] }],
    ['over-long question', { questions: [{ question: 'q'.repeat(6001), header: 'h', options: [{ label: 'a' }, { label: 'b' }] }] }],
    ['non-object question', { questions: ['nope'] }],
  ])('returns undefined for %s', (_name, input) => {
    expect(parseAskUserQuestions(input as Record<string, unknown>)).toBeUndefined();
  });
});

describe('createAskUserQuestionPermission', () => {
  it('returns the user answers as the deny message once respond() settles', async () => {
    const { permission, seen } = bridge();
    const pending = permission('AskUserQuestion', toolInput(), callOptions());
    expect(seen).toHaveLength(1);
    const [{request}] = seen;
    expect(request.kind).toBe('rpc');
    expect(request.itemId).toBe('tooluse-1');
    expect(request.questions[0].id).toBe('q1');
    await request.respond({ q1: { answers: ['Yes'] } });
    await expect(pending).resolves.toEqual({
      behavior: 'deny',
      message: 'The user answered your questions:\n- Deploy now? → Yes',
    });
  });

  it('denies with guidance when no verified input context exists', async () => {
    const { permission, seen, setContext } = bridge();
    setContext(undefined);
    await expect(permission('AskUserQuestion', toolInput(), callOptions()))
      .resolves.toEqual({ behavior: 'deny', message: 'This conversation cannot receive interactive questions; ask the user directly in your reply text instead.' });
    expect(seen).toHaveLength(0);
  });

  it('denies malformed AskUserQuestion input without delivering a card', async () => {
    const { permission, seen } = bridge();
    await expect(permission('AskUserQuestion', { questions: 'nope' }, callOptions()))
      .resolves.toEqual({ behavior: 'deny', message: 'The AskUserQuestion request was malformed and could not be presented to the user.' });
    expect(seen).toHaveLength(0);
  });

  it('denies any other tool: this callback is not an approval surface', async () => {
    const { permission, seen } = bridge();
    await expect(permission('Bash', { command: 'rm -rf /' }, callOptions()))
      .resolves.toEqual({ behavior: 'deny', message: 'This session has no interactive approval surface for this tool.' });
    expect(seen).toHaveLength(0);
  });

  it('denies with guidance when channel delivery fails', async () => {
    const { permission } = bridge({
      onUserInput: () => Promise.reject(new Error('card send failed')),
    });
    await expect(permission('AskUserQuestion', toolInput(), callOptions()))
      .resolves.toEqual({ behavior: 'deny', message: 'Your question could not be delivered to the user; ask them directly in your reply text instead.' });
  });

  it('denies on timeout after the configured wait', async () => {
    const { permission, seen } = bridge({ timeoutMs: 1_000 });
    const pending = permission('AskUserQuestion', toolInput(), callOptions());
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({
      behavior: 'deny',
      message: 'The user did not answer your question within the time limit.',
    });
    // Late answers after settlement must not revive the request.
    await expect(seen[0].request.respond({ q1: { answers: ['Yes'] } })).rejects.toThrow('no longer active');
  });

  it('denies as cancelled when the SDK aborts the tool call', async () => {
    const controller = new AbortController();
    const { permission } = bridge();
    const pending = permission('AskUserQuestion', toolInput(), callOptions(controller.signal));
    controller.abort();
    await expect(pending).resolves.toEqual({
      behavior: 'deny',
      message: 'Your question was cancelled before the user answered.',
    });
  });

  it('propagates validation errors from respond() and stays answerable', async () => {
    const { permission, seen } = bridge();
    const pending = permission('AskUserQuestion', toolInput(), callOptions());
    // Empty answers fail validation; isOther free text (any string) is valid.
    await expect(seen[0].request.respond({ q1: { answers: [] } })).rejects.toThrow('Missing answer');
    await seen[0].request.respond({ q1: { answers: ['Other: maybe'] } });
    await expect(pending).resolves.toEqual({
      behavior: 'deny',
      message: 'The user answered your questions:\n- Deploy now? → Other: maybe',
    });
  });

  it('joins multi-value answers in the deny message', () => {
    const questions = parseAskUserQuestions(toolInput())!;
    const answers: AgentInputAnswers = { q1: { answers: ['Yes', 'Other: notes'] } };
    expect(formatAgentInputAnswers(questions, answers))
      .toBe('The user answered your questions:\n- Deploy now? → Yes, Other: notes');
  });

  it('defaults the answer deadline to the shared transport window', () => {
    expect(ASK_USER_QUESTION_TIMEOUT_MS).toBe(15 * 60_000);
  });
});
