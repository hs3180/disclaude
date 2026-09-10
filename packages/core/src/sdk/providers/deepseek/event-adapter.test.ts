import { describe, expect, it } from 'vitest';
import { adaptDeepSeekEvent } from './event-adapter.js';

describe('adaptDeepSeekEvent (Issue #4743 contract)', () => {
  it('leaves token buffering to the provider', () => {
    expect(
      adaptDeepSeekEvent({
        type: 'assistant/chunk',
        data: { chunk: { type: 'text-delta', text: 'hi' } },
      })
    ).toEqual([]);
  });

  it('maps text from the official assistant/message envelope', () => {
    expect(
      adaptDeepSeekEvent({
        type: 'assistant/message',
        data: {
          message: {
            id: 'msg-1',
            content: [
              { type: 'reasoning', text: 'think' },
              { type: 'text', text: 'hello' },
            ],
          },
        },
      })
    ).toEqual([expect.objectContaining({ content: 'hello' })]);
  });

  it('maps tool calls and results with a stable call id', () => {
    expect(
      adaptDeepSeekEvent({
        type: 'tool/call',
        data: { callId: 'call-1', name: 'lookup', arguments: '{"q":"x"}' },
      })[0]
    ).toMatchObject({
      type: 'tool_use',
      metadata: { messageId: 'call-1', toolName: 'lookup', toolInput: { q: 'x' } },
    });
    expect(
      adaptDeepSeekEvent({
        type: 'tool/result',
        data: {
          message: {
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-1',
                content: [{ type: 'text', text: 'ok' }],
              },
            ],
          },
        },
      })[0]
    ).toMatchObject({
      type: 'tool_result',
      content: 'ok',
      metadata: { messageId: 'call-1', toolOutput: 'ok' },
    });
  });

  it('maps official turn/end completion and failure reasons', () => {
    expect(
      adaptDeepSeekEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } })[0]
    ).toMatchObject({
      type: 'result',
    });
    expect(
      adaptDeepSeekEvent({
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { message: 'fatal' } } },
      })[0]?.type
    ).toBe('error');
  });

  it('ignores unknown events instead of leaking arbitrary payloads to chat', () => {
    expect(adaptDeepSeekEvent({ type: 'future/event', data: { text: 'do not display' } })).toEqual(
      []
    );
  });
});
