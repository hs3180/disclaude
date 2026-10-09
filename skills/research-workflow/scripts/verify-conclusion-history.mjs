#!/usr/bin/env node
/** Read-only preservation check. Does not edit documents or checkpoints. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyConclusionHistory({ before, after, replacedConclusions } = {}) {
  for (const snapshot of [before, after]) {
    requireValue(snapshot?.complete === true && typeof snapshot.body === 'string' &&
      typeof snapshot.documentId === 'string' && snapshot.documentId.length > 0 &&
      typeof snapshot.revision === 'string' && snapshot.revision.length > 0, 'complete_snapshot_required');
  }
  requireValue(before.documentId === after.documentId, 'document_mismatch');
  requireValue(Array.isArray(replacedConclusions) && replacedConclusions.length > 0,
    'actual_replaced_conclusions_required');
  for (const [index, conclusion] of replacedConclusions.entries()) {
    requireValue(typeof conclusion === 'string' && conclusion.trim().length > 0,
      `invalid_conclusion:${index}`);
    requireValue(before.body.includes(conclusion), `conclusion_not_in_before:${index}`);
    requireValue(after.body.includes(conclusion), `conclusion_missing_from_readback:${index}`);
  }
  return { ok: true, documentId: after.documentId, revision: after.revision,
    verifiedConclusions: replacedConclusions.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(verifyConclusionHistory(JSON.parse(readFileSync(0, 'utf8')))));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
