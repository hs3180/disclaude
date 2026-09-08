import { describe, expect, it } from 'vitest';
import { adaptDeepSeekEvent } from './event-adapter.js';

describe('adaptDeepSeekEvent (Issue #4743 contract)', () => {
  it('maps text deltas without changing their content', () => {
    expect(adaptDeepSeekEvent({ type: 'text_delta', delta: 'hello' })).toMatchObject({
      type: 'text',
      role: 'assistant',
      content: 'hello',
    });
  });

  it('maps tool calls and results with a stable call id', () => {
    expect(
      adaptDeepSeekEvent({ type: 'tool_call', id: 'call-1', name: 'lookup', input: { q: 'x' } })
    ).toMatchObject({
      type: 'tool_use',
      metadata: { messageId: 'call-1', toolName: 'lookup', toolInput: { q: 'x' } },
    });
    expect(
      adaptDeepSeekEvent({ type: 'tool_result', id: 'call-1', name: 'lookup', result: 'ok' })
    ).toMatchObject({
      type: 'tool_result',
      content: 'ok',
      metadata: { messageId: 'call-1', toolOutput: 'ok' },
    });
  });

  it('keeps completion usage on the result and distinguishes retryable errors', () => {
    expect(
      adaptDeepSeekEvent({ type: 'completed', usage: { input_tokens: 4, output_tokens: 2 } })
    ).toMatchObject({
      type: 'result',
      metadata: { inputTokens: 4, outputTokens: 2 },
    });
    expect(adaptDeepSeekEvent({ type: 'error', message: 'retry', retryable: true })?.type).toBe(
      'status'
    );
    expect(adaptDeepSeekEvent({ type: 'error', message: 'fatal' })?.type).toBe('error');
  });

  it('ignores unknown events instead of leaking arbitrary payloads to chat', () => {
    expect(adaptDeepSeekEvent({ type: 'future_event', text: 'do not display' })).toBeNull();
  });
});
