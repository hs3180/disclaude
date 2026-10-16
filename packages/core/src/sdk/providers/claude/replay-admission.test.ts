import { describe, expect, it } from 'vitest';
import { claudeReplayBlock, type ClaudeAttemptEvidence } from './replay-admission.js';
import { preventAutomaticReplay, automaticReplayBlock } from '../../../utils/replay-safety.js';
import type { AttemptExit } from './attempt-process.js';

const beforeWork = (): ClaudeAttemptEvidence => ({ messages: 0, partials: false, permissionRequests: 0,
  toolObserved: false, inputOffered: false, inputPullPending: false, processStarted: false });
const stopped: AttemptExit = { status: 'not-started', confirmed: true, closeFailed: false, signals: [], inspectionAvailable: true };
describe('Claude replay evidence', () => {
  it('permits a fenced, unstarted attempt with no input in flight', () => {
    expect(claudeReplayBlock(beforeWork(), stopped)).toBeUndefined();
  });
  it.each([
    ['messages', 1, 'messages-observed'], ['partials', true, 'partials-observed'],
    ['permissionRequests', 1, 'permission-request-observed'], ['toolObserved', true, 'tool-execution-observed'],
    ['inputOffered', true, 'input-delivery-uncertain'], ['inputPullPending', true, 'input-pull-pending'],
    ['processStarted', true, 'native-startup-outcome-uncertain'],
  ] as const)('blocks on %s without relying on missing host output', (key, value, reason) => {
    expect(claudeReplayBlock({ ...beforeWork(), [key]: value }, stopped)).toBe(reason);
  });
  it('never treats missing process confirmation as a safe retry', () => {
    expect(claudeReplayBlock(beforeWork(), { ...stopped, status: 'unconfirmed', confirmed: false })).toBe('process-exit-unconfirmed');
  });
  it('retains replay denial across wrappers and a frozen original error', () => {
    const original = Object.freeze(Object.assign(new Error('HTTP 429'), { status: 429 }));
    const denied = preventAutomaticReplay(original, 'input-delivery-uncertain');
    expect(denied.cause).toBe(original);
    expect(automaticReplayBlock(new Error('wrapper', { cause: denied }))).toBe('input-delivery-uncertain');
  });
});
