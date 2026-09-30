#!/usr/bin/env node
/** Report missing text blocks across full historical snapshots. No semantic verdict. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function valid(snapshot) {
  return snapshot?.complete === true && typeof snapshot.body === 'string' &&
    typeof snapshot.documentId === 'string' && snapshot.documentId.length > 0 &&
    typeof snapshot.revision === 'string' && snapshot.revision.length > 0;
}

export function compareSnapshotHistory({ sources, current } = {}) {
  if (!valid(current) || !Array.isArray(sources) || !sources.length || !sources.every(valid)) {
    throw new Error('complete_snapshots_required');
  }
  const missing = new Map();
  for (const source of sources) {
    if (source.documentId !== current.documentId) throw new Error('document_mismatch');
    for (const raw of source.body.split(/\r?\n[\t ]*\r?\n/)) {
      const block = raw.replace(/^[\r\n]+|[\r\n]+$/g, '');
      if (!block.trim() || current.body.includes(block)) continue;
      const hash = createHash('sha256').update(block).digest('hex');
      if (!missing.has(hash)) missing.set(hash, { hash, text: block, sourceRevisions: [] });
      const item = missing.get(hash);
      if (!item.sourceRevisions.includes(source.revision)) item.sourceRevisions.push(source.revision);
    }
  }
  return { documentId: current.documentId, currentRevision: current.revision,
    comparedSnapshots: sources.length, missingBlocks: [...missing.values()] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(compareSnapshotHistory(JSON.parse(readFileSync(0, 'utf8')))));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
