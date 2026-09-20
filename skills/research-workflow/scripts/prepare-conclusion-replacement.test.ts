import { describe, expect, it } from 'vitest';
import { prepareConclusionReplacement } from './prepare-conclusion-replacement.mjs';
import { verifyConclusionHistory } from './verify-conclusion-history.mjs';

const old = '**当前建议**：保留 `Café`/`cafe` 的局部结果；组合边界仍未知。';
const updated = '**当前建议**：分别评估 `ß/ss`、NFC/NFD 和 `Café`/`cafe`；均未新增实验。';
const snapshot = (body = `# Research\n\n${old}\n\n## 用户修改\n\nKeep this text.`) =>
  ({ documentId: 'doc', revision: '17', body, complete: true });

describe('single conclusion replacement with retained history', () => {
  it('retains the exact old conclusion in the same replacement and preserves surrounding text', () => {
    const before = snapshot();
    const prepared = prepareConclusionReplacement({ before, previousConclusion: old, nextConclusion: updated });
    const after = { ...before, revision: '18', body: before.body.replace(prepared.pattern, () => prepared.content) };
    expect(after.body).toBe(`# Research\n\n${updated}\n\n### 历史结论（修订 17）\n\n${old}\n\n## 用户修改\n\nKeep this text.`);
    expect(verifyConclusionHistory({ ...prepared.historyCheck, after }).ok).toBe(true);
    expect(before).toEqual(snapshot());
  });

  it('retains each prior version once across successive edits', () => {
    let current = snapshot();
    for (const [previousConclusion, nextConclusion] of [[old, updated], [updated, '**当前建议**：等待用户明确恢复。']]) {
      const edit = prepareConclusionReplacement({ before: current, previousConclusion, nextConclusion });
      current = { ...current, revision: String(Number(current.revision) + 1), body: current.body.replace(edit.pattern, () => edit.content) };
    }
    expect(current.body.split(old)).toHaveLength(2);
    expect(current.body.split(updated)).toHaveLength(2);
  });

  it('rejects partial or ambiguous patterns instead of guessing which version to replace', () => {
    expect(() => prepareConclusionReplacement({ before: snapshot(), previousConclusion: '组合边界仍未知。', nextConclusion: updated })).toThrow('whole_paragraph_required');
    expect(() => prepareConclusionReplacement({ before: snapshot(`${old}\n\n${old}`), previousConclusion: old, nextConclusion: updated })).toThrow('ambiguous_conclusion');
    expect(() => prepareConclusionReplacement({ before: snapshot(), previousConclusion: 'absent', nextConclusion: updated })).toThrow('conclusion_not_in_snapshot');
  });

  it('rejects incomplete reads, multi-paragraph edits and unchanged text', () => {
    expect(() => prepareConclusionReplacement({ before: { ...snapshot(), complete: false }, previousConclusion: old, nextConclusion: updated })).toThrow('complete_snapshot_required');
    expect(() => prepareConclusionReplacement({ before: snapshot(), previousConclusion: old, nextConclusion: `${updated}\n\nOther` })).toThrow('one_complete_paragraph_required');
    expect(() => prepareConclusionReplacement({ before: snapshot(), previousConclusion: old, nextConclusion: old })).toThrow('unchanged_conclusion');
  });
});
