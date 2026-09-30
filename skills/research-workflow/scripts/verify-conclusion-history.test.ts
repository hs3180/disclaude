import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyConclusionHistory } from './verify-conclusion-history.mjs';

const first = 'Use SQLite if the existing data layer and word-query assumptions hold. [source](https://example.org/one)';
const second = 'Use a recall prototype; the combined trigram and fallback path remains unverified.';
const snapshot = (body: string, revision = '8') => ({ documentId: 'doc', revision, body, complete: true });
const before = snapshot(`# Current\n${second}\n\n# History\n${first}`);

describe('read-back conclusion preservation', () => {
  it('rejects preserving an older conclusion while losing the one just replaced', () => {
    expect(() => verifyConclusionHistory({ before,
      after: snapshot(`# Current\nNew recommendation\n# History\n${first}\nBoth prior conclusions preserved.`, '9'),
      replacedConclusions: [second],
    })).toThrow('conclusion_missing_from_readback:0');
  });

  it('accepts all actual old paragraphs including their conditions and citations', () => {
    expect(verifyConclusionHistory({ before,
      after: snapshot(`# Current\nNew recommendation\n# History\n${first}\n\n${second}`, '9'),
      replacedConclusions: [first, second],
    })).toMatchObject({ ok: true, verifiedConclusions: 2, revision: '9' });
  });

  it('does not accept an abbreviated history that drops a limitation or source', () => {
    expect(() => verifyConclusionHistory({ before,
      after: snapshot('# Current\nNew recommendation\n# History\nUse SQLite.'),
      replacedConclusions: [first],
    })).toThrow('conclusion_missing_from_readback:0');
  });

  it('rejects incomplete reads, cross-document reads, guessed originals and empty checks', () => {
    const input = { before, after: before, replacedConclusions: [second] };
    expect(() => verifyConclusionHistory({ ...input, after: { ...before, complete: false } })).toThrow('complete_snapshot_required');
    expect(() => verifyConclusionHistory({ ...input, after: { ...before, documentId: 'other' } })).toThrow('document_mismatch');
    expect(() => verifyConclusionHistory({ ...input, replacedConclusions: ['not observed'] })).toThrow('conclusion_not_in_before:0');
    expect(() => verifyConclusionHistory({ ...input, replacedConclusions: [] })).toThrow('actual_replaced_conclusions_required');
  });

  it('returns a failing CLI exit code without echoing document content', () => {
    const result = spawnSync(process.execPath,
      [fileURLToPath(new URL('./verify-conclusion-history.mjs', import.meta.url))], {
        input: JSON.stringify({ before, after: snapshot('New recommendation'), replacedConclusions: [second] }),
        encoding: 'utf8',
      });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'conclusion_missing_from_readback:0' });
  });
});
