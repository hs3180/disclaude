#!/usr/bin/env node
/** Local, optimistic checkpoints for document-led research. No remote side effects. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, openSync, closeSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = text => createHash('sha256').update(text).digest('hex');
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function text(value) { return typeof value === 'string' && value.trim().length > 0; }

function snapshotFor(state, snapshot) {
  requireValue(snapshot && snapshot.documentId === state.documentId, 'document_mismatch');
  requireValue(text(snapshot.revision) && typeof snapshot.body === 'string' && Array.isArray(snapshot.comments), 'invalid_snapshot');
  const ids = new Set();
  for (const comment of snapshot.comments) {
    requireValue(text(comment.id) && typeof comment.body === 'string' && !ids.has(comment.id), 'invalid_comments');
    ids.add(comment.id);
  }
  // The adapter must fetch all pages; a partial/failed read cannot advance the checkpoint.
  requireValue(snapshot.complete === true, 'incomplete_snapshot');
  return snapshot;
}

function observe(state, snapshot, ownWrite = false) {
  const bodyHash = digest(snapshot.body);
  if (state.documentHash !== bodyHash && !ownWrite) {
    const key = `document:${snapshot.revision}:${bodyHash}`;
    if (!state.feedback.some(item => item.key === key)) {
      state.feedback.push({ key, kind: 'document', revision: snapshot.revision, status: 'pending' });
    }
  }
  for (const comment of snapshot.comments) {
    const key = `comment:${comment.id}:${digest(comment.body)}`;
    if (!state.feedback.some(item => item.key === key)) {
      state.feedback.push({ key, kind: 'comment', commentId: comment.id, body: comment.body,
        revision: snapshot.revision, status: 'pending' });
    }
  }
  state.documentRevision = snapshot.revision;
  state.documentHash = bodyHash;
  state.documentBody = snapshot.body;
  state.comments = snapshot.comments;
}

export function transition(previous, command, input) {
  if (command === 'init') {
    requireValue(previous === null, 'already_initialized');
    requireValue(input && text(input.taskId) && text(input.documentId), 'invalid_binding');
    return { schema: 1, version: 0, taskId: input.taskId, documentId: input.documentId,
      phase: 'planning', status: 'active', documentRevision: null, documentHash: null,
      documentBody: '', comments: [], feedback: [], pendingWrite: null };
  }
  requireValue(previous?.schema === 1, 'invalid_state');
  requireValue(!['completed', 'cancelled'].includes(previous.status), 'terminal_task');
  const state = structuredClone(previous);
  switch (command) {
    case 'sync': {
      requireValue(!state.pendingWrite, 'write_pending_read_back_before_sync');
      observe(state, snapshotFor(state, input));
      break;
    }
    case 'prepare': {
      requireValue(!state.pendingWrite, 'write_pending_read_back_before_retry');
      requireValue(state.documentRevision !== null, 'sync_required');
      requireValue(Array.isArray(input?.decisions) && input.decisions.length > 0, 'decisions_required');
      const keys = new Set();
      for (const decision of input.decisions) {
        const item = state.feedback.find(item => item.key === decision.key);
        requireValue(item?.status === 'pending' && !keys.has(decision.key), 'feedback_not_pending');
        requireValue(['accepted', 'needs_clarification', 'not_adopted'].includes(decision.status) && text(decision.reason), 'invalid_decision');
        keys.add(decision.key);
      }
      const id = randomUUID();
      const fragment = `\n### Feedback checkpoint ${id}\n\n` + input.decisions.map(decision =>
        `- ${decision.key}: ${decision.status} — ${decision.reason.replace(/[\r\n]+/g, ' ')}`
      ).join('\n') + '\n';
      state.pendingWrite = { id, baseRevision: state.documentRevision, baseHash: state.documentHash,
        fragment, decisions: input.decisions, phase: state.phase };
      break;
    }
    case 'ack': {
      requireValue(state.pendingWrite && input?.operationId === state.pendingWrite.id, 'operation_mismatch');
      const snapshot = snapshotFor(state, input.snapshot);
      const fragment = state.pendingWrite.fragment;
      // Feishu Markdown readback adds a heading separator and drops the final
      // newline. Match the entire append, preserving every byte of the base
      // and receipt content; never trim user content or ignore other edits.
      const normalizedAppend = state.documentBody + '\n\n' + fragment.slice(1, -1);
      const matchesAppendBoundary = snapshot.body === normalizedAppend;
      requireValue(matchesAppendBoundary || snapshot.body.includes(fragment), 'write_not_observed');
      // Any concurrent body change needs reconciliation, not a false "feedback handled" result.
      const priorBody = matchesAppendBoundary ? state.documentBody : snapshot.body.replace(fragment, '');
      requireValue(digest(priorBody) === state.pendingWrite.baseHash, 'concurrent_document_edit');
      for (const decision of state.pendingWrite.decisions) {
        const item = state.feedback.find(item => item.key === decision.key);
        if (item.kind === 'comment' && decision.status !== 'not_adopted') {
          requireValue(snapshot.comments.some(comment => comment.id === item.commentId &&
            `comment:${comment.id}:${digest(comment.body)}` === item.key), 'comment_changed_during_write');
        }
        item.status = decision.status;
        item.reason = decision.reason;
        item.operationId = state.pendingWrite.id;
        item.phase = state.pendingWrite.phase;
      }
      observe(state, snapshot, true);
      state.pendingWrite = null;
      break;
    }
    case 'reconcile': {
      requireValue(state.pendingWrite && input?.operationId === state.pendingWrite.id, 'operation_mismatch');
      // Explicit recovery after an unknown write: refresh all feedback without claiming it handled.
      const snapshot = snapshotFor(state, input.snapshot);
      state.pendingWrite = null;
      observe(state, snapshot);
      break;
    }
    case 'phase': {
      requireValue(!state.pendingWrite, 'write_pending');
      requireValue(text(input?.phase), 'phase_required');
      requireValue(!state.feedback.some(item => ['pending', 'needs_clarification'].includes(item.status)), 'feedback_unresolved');
      state.phase = input.phase;
      break;
    }
    case 'reopen': {
      const item = state.feedback.find(item => item.key === input?.key);
      requireValue(!state.pendingWrite && item?.status === 'needs_clarification', 'feedback_not_waiting');
      item.status = 'pending';
      break;
    }
    case 'finish': {
      requireValue(!state.pendingWrite && !state.feedback.some(item => ['pending', 'needs_clarification'].includes(item.status)), 'feedback_unresolved');
      requireValue(state.documentRevision !== null, 'sync_required');
      state.status = 'completed';
      break;
    }
    case 'cancel': state.status = 'cancelled'; break; // Retain unknown writes and all artifacts for inspection.
    default: throw new Error('unknown_command');
  }
  state.version += 1;
  return state;
}

export function apply(file, command, expectedVersion, input) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let handle;
  try { handle = openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('state_busy'); throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    let previous = null;
    try { previous = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    requireValue(command === 'init' ? expectedVersion === -1 : previous?.version === expectedVersion, 'stale_checkpoint');
    const next = transition(previous, command, input);
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
    return next;
  } finally {
    rmSync(temporary, { force: true });
    closeSync(handle);
    rmSync(lock, { force: true });
  }
}

const main = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  try {
    const [command, file, version] = process.argv.slice(2);
    requireValue(command && file, 'usage: state.mjs <init|sync|prepare|ack|reconcile|reopen|phase|finish|cancel|status> <state-file> <expected-version>; JSON input on stdin');
    const result = command === 'status' ? JSON.parse(readFileSync(resolve(file), 'utf8')) :
      apply(resolve(file), command, Number(version), JSON.parse(readFileSync(0, 'utf8')));
    console.log(JSON.stringify({ ok: true, state: result }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
