import { describe, expect, it } from 'vitest';
import { parseResearchCheckpoint } from './checkpoint.js';

const complete = {
  state: 'complete',
  message: '已核验一个方向。',
  work: [
    {
      title: '核验来源',
      status: 'done',
      findings: [
        {
          claim: '来源支持该结论。',
          kind: 'fact',
          sources: [
            { title: '官方文档', location: 'https://example.test/doc', excerpt: '支持该结论' },
          ],
          caveat: '样本有限。',
        },
      ],
    },
  ],
  feedback: [],
  summary: '结论保留证据和限制。',
  questions: ['还需扩大样本。'],
};

describe('Research checkpoint', () => {
  it('accepts a single JSON fence and preserves evidence fields', () => {
    const result = parseResearchCheckpoint(`\n\`\`\`json\n${JSON.stringify(complete)}\n\`\`\`\n`);
    expect(result.state).toBe('complete');
    expect(result.work[0]?.findings[0]?.sources[0]?.location).toBe('https://example.test/doc');
    expect(result.summary).toContain('证据');
  });

  it('rejects completion without a summary and malformed sources', () => {
    expect(() => parseResearchCheckpoint(JSON.stringify({ ...complete, summary: '' }))).toThrow(
      /summary/
    );
    expect(() =>
      parseResearchCheckpoint(
        JSON.stringify({
          ...complete,
          work: [
            { ...complete.work[0], findings: [{ ...complete.work[0].findings[0], sources: [] }] },
          ],
        })
      )
    ).toThrow(/sources/);
    expect(() =>
      parseResearchCheckpoint(
        JSON.stringify({
          ...complete,
          work: [
            {
              ...complete.work[0],
              findings: [{ ...complete.work[0].findings[0], kind: 'made-up' }],
            },
          ],
        })
      )
    ).toThrow(/kind/);
  });

  it('requires a concrete clarification for waiting-user', () => {
    expect(() =>
      parseResearchCheckpoint(
        JSON.stringify({
          state: 'waiting-user',
          message: '需要补充',
          work: [],
          feedback: [],
          questions: [],
        })
      )
    ).toThrow(/clarification/);
  });
});
