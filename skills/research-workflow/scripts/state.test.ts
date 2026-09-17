import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { apply, transition } from './state.mjs';

const initial = () => transition(null, 'init', { taskId: 'r1', documentId: 'd1' });
const snapshot = (body = '# Research', comments = [{ id: 'c1', body: 'Please add counterexamples' }]) =>
  ({ documentId: 'd1', revision: 'r1', body, comments, complete: true });
const synced = () => transition(initial(), 'sync', snapshot());
const prepare = (state = synced(), status = 'accepted') => transition(state, 'prepare', {
  decisions: state.feedback.filter(item => item.status === 'pending').map(item => ({ key: item.key, status, reason: 'Add a counterexample section before synthesis' })),
});
function ack(state, extra = {}) {
  return transition(state, 'ack', { operationId: state.pendingWrite.id,
    snapshot: { ...snapshot(state.documentBody + state.pendingWrite.fragment), revision: 'r2', ...extra } });
}

describe('document feedback checkpoints', () => {
  it('rejects a hand-edited body/hash mismatch without rewriting the checkpoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'research-integrity-'));
    const file = join(root, 'state.json');
    try {
      const state = synced();
      state.documentHash = '0'.repeat(64);
      const original = JSON.stringify(state);
      writeFileSync(file, original);
      expect(() => apply(file, 'sync', state.version, snapshot())).toThrow('checkpoint_body_hash_mismatch');
      expect(readFileSync(file, 'utf8')).toBe(original);
      expect(transition(state, 'cancel', {}).status).toBe('cancelled');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('commits feedback only after observing the receipt and allows completion', () => {
    const pending = prepare();
    expect(pending.feedback.every(item => item.status === 'pending')).toBe(true);
    expect(() => transition(pending, 'finish', {})).toThrow('feedback_unresolved');
    const handled = ack(pending);
    expect(handled.pendingWrite).toBeNull();
    expect(handled.feedback.every(item => item.status === 'accepted')).toBe(true);
    expect(transition(handled, 'finish', {}).status).toBe('completed');
  });

  it('deduplicates repeated snapshots but retains edited comments as new feedback', () => {
    const state = synced();
    expect(transition(state, 'sync', snapshot()).feedback).toEqual(state.feedback);
    const changed = transition(state, 'sync', snapshot('# Research', [{ id: 'c1', body: 'New scope' }]));
    expect(changed.feedback.filter(item => item.kind === 'comment')).toHaveLength(2);
  });

  it('rejects cross-document and incomplete snapshots without altering state', () => {
    const state = synced();
    const before = structuredClone(state);
    expect(() => transition(state, 'sync', { ...snapshot(), documentId: 'd2' })).toThrow('document_mismatch');
    expect(() => transition(state, 'sync', { ...snapshot(), complete: false })).toThrow('incomplete_snapshot');
    expect(state).toEqual(before);
  });

  it('does not replay an unknown write on restart', () => {
    const restored = JSON.parse(JSON.stringify(prepare()));
    expect(() => prepare(restored)).toThrow('write_pending');
    expect(() => transition(restored, 'sync', snapshot())).toThrow('write_pending');
    expect(() => ack(restored, { body: '# Research' })).toThrow('write_not_observed');
    expect(ack(restored).feedback.every(item => item.status === 'accepted')).toBe(true);
  });

  it('protects concurrent user edits and reconciles without claiming feedback handled', () => {
    const pending = prepare();
    const remote = { ...snapshot('User rewrote the scope' + pending.pendingWrite.fragment), revision: 'r3' };
    expect(() => ack(pending, remote)).toThrow('concurrent_document_edit');
    const recovered = transition(pending, 'reconcile', { operationId: pending.pendingWrite.id, snapshot: remote });
    expect(recovered.documentBody).toBe(remote.body);
    expect(recovered.pendingWrite).toBeNull();
    expect(recovered.feedback.every(item => item.status === 'pending')).toBe(true);
  });

  it('does not acknowledge a comment edited during write-back', () => {
    const pending = prepare();
    expect(() => ack(pending, { comments: [{ id: 'c1', body: 'Actually use another scope' }] })).toThrow('comment_changed_during_write');
  });

  it('keeps newly discovered comments pending after a successful receipt', () => {
    const pending = prepare();
    const state = ack(pending, { comments: [...snapshot().comments, { id: 'c2', body: 'One more question' }] });
    expect(state.feedback.find(item => item.commentId === 'c2').status).toBe('pending');
    expect(() => transition(state, 'phase', { phase: 'synthesis' })).toThrow('feedback_unresolved');
  });

  it('requires a new decision after clarification and preserves cancellation artifacts', () => {
    const state = ack(prepare(synced(), 'needs_clarification'));
    expect(() => transition(state, 'finish', {})).toThrow('feedback_unresolved');
    const reopened = transition(state, 'reopen', { key: state.feedback[0].key });
    expect(reopened.feedback[0].status).toBe('pending');
    const pending = prepare();
    const cancelled = transition(pending, 'cancel', {});
    expect(cancelled.pendingWrite).toEqual(pending.pendingWrite);
    expect(() => transition(cancelled, 'sync', snapshot())).toThrow('terminal_task');
  });

  it('rejects duplicate decision keys and requires a reason', () => {
    const state = synced();
    const decision = { key: state.feedback[0].key, status: 'accepted', reason: 'Update scope' };
    expect(() => transition(state, 'prepare', { decisions: [decision, decision] })).toThrow('feedback_not_pending');
    expect(() => transition(state, 'prepare', { decisions: [{ ...decision, reason: '' }] })).toThrow('invalid_decision');
  });

  it('persists across processes and prevents stale or concurrent writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'research state '));
    const file = join(dir, 'state.json');
    try {
      apply(file, 'init', -1, { taskId: 'r1', documentId: 'd1' });
      apply(file, 'sync', 0, snapshot());
      const before = readFileSync(file, 'utf8');
      expect(() => apply(file, 'cancel', 0, {})).toThrow('stale_checkpoint');
      writeFileSync(file + '.lock', 'other owner');
      expect(() => apply(file, 'cancel', 1, {})).toThrow('state_busy');
      rmSync(file + '.lock');
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const run = spawnSync(process.execPath, [new URL('./state.mjs', import.meta.url).pathname, 'status', file], { cwd: dir, encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout).state.version).toBe(1);
      expect(JSON.parse(run.stdout).state.feedback).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
