#!/usr/bin/env node
/** Assemble one replacement retaining the exact old paragraph. No remote writes. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function requireValue(condition, message) { if (!condition) throw new Error(message); }

export function prepareConclusionReplacement({ before, previousConclusion, nextConclusion } = {}) {
  requireValue(before?.complete === true && typeof before.body === 'string' &&
    typeof before.documentId === 'string' && before.documentId.length > 0 &&
    typeof before.revision === 'string' && before.revision.length > 0 &&
    !/[\r\n]/.test(before.revision), 'complete_snapshot_required');
  for (const paragraph of [previousConclusion, nextConclusion]) {
    requireValue(typeof paragraph === 'string' && paragraph.trim().length > 0 &&
      paragraph === paragraph.trim() && !/\r?\n\s*\r?\n/.test(paragraph), 'one_complete_paragraph_required');
  }
  requireValue(previousConclusion !== nextConclusion, 'unchanged_conclusion');
  const start = before.body.indexOf(previousConclusion);
  requireValue(start >= 0, 'conclusion_not_in_snapshot');
  requireValue(before.body.indexOf(previousConclusion, start + 1) === -1, 'ambiguous_conclusion');
  const end = start + previousConclusion.length;
  requireValue((start === 0 || before.body.slice(0, start).endsWith('\n\n')) &&
    (end === before.body.length || before.body.slice(end).startsWith('\n\n')), 'whole_paragraph_required');
  const content = `${nextConclusion}\n\n### 历史结论（修订 ${before.revision}）\n\n${previousConclusion}`;
  return {
    pattern: previousConclusion,
    content,
    historyCheck: { before, replacedConclusions: [previousConclusion] },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(prepareConclusionReplacement(JSON.parse(readFileSync(0, 'utf8')))));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
