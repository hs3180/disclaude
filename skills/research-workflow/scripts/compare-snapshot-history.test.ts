import { describe, expect, it } from 'vitest';
import { compareSnapshotHistory } from './compare-snapshot-history.mjs';

const snapshot = (revision: string, body: string) => ({ documentId: 'd', revision, body, complete: true });

describe('historical snapshot missing-block report', () => {
  it('finds a lost recommendation even when all historical headings remain', () => {
    const earlier = 'Earlier recommendation with source and caveat.';
    const latest = 'Latest recommendation with different limitations.';
    const current = snapshot('3', `# Current\n\nNew recommendation.\n\n## Round 1\n\n${earlier}\n\n## Round 2`);
    const report = compareSnapshotHistory({ sources: [snapshot('1', `## Round 1\n\n${earlier}`), snapshot('2', `## Round 2\n\n${latest}`)], current });
    expect(report.missingBlocks).toEqual([{ hash: expect.any(String), text: latest, sourceRevisions: ['2'] }]);
  });

  it('reports unchanged missing text once with every source revision', () => {
    const report = compareSnapshotHistory({ sources: [snapshot('1', 'Missing'), snapshot('2', 'Missing\n\nMissing')], current: snapshot('3', 'Present') });
    expect(report.missingBlocks).toHaveLength(1);
    expect(report.missingBlocks[0].sourceRevisions).toEqual(['1', '2']);
  });

  it('reports superseded metadata without declaring it a lost conclusion', () => {
    const report = compareSnapshotHistory({ sources: [snapshot('1', '# Running\n\nSame finding')], current: snapshot('2', '# Paused\n\nSame finding') });
    expect(report.missingBlocks[0].text).toBe('# Running');
    expect(report).not.toHaveProperty('historyComplete');
  });

  it('accepts moved verbatim blocks and preserves missing Unicode and code indentation', () => {
    const block = '    Café ß/ss\n    保留缩进';
    expect(compareSnapshotHistory({ sources: [snapshot('1', block)], current: snapshot('2', `# History\n\n${block}`) }).missingBlocks).toEqual([]);
    expect(compareSnapshotHistory({ sources: [snapshot('1', block)], current: snapshot('2', 'CAFÉ') }).missingBlocks[0].text).toBe(block);
  });

  it('rejects partial, missing and cross-document snapshots', () => {
    expect(() => compareSnapshotHistory({ sources: [], current: snapshot('2', '') })).toThrow('complete_snapshots_required');
    expect(() => compareSnapshotHistory({ sources: [{ ...snapshot('1', ''), complete: false }], current: snapshot('2', '') })).toThrow('complete_snapshots_required');
    expect(() => compareSnapshotHistory({ sources: [{ ...snapshot('1', ''), documentId: 'other' }], current: snapshot('2', '') })).toThrow('document_mismatch');
  });
});
