import { describe, expect, it } from 'vitest';
import { parseTaskCheckpoint } from './task-checkpoint.js';

const source = { title: 'Report', location: 'supplied report', excerpt: 'A costs 10' };
const finding = { claim: 'A costs 10', kind: 'fact', sources: [source], caveat: '' };
const checkpoint = () => ({ state: 'complete', message: 'Compared supplied evidence',
  work: [{ id: 'work-a', title: 'Check costs', status: 'done', findings: [structuredClone(finding)] }],
  feedback: [{ feedbackIndex: 0, status: 'applied', reason: 'Checked the requested cost', workIndexes: [0] }],
  summary: 'A costs 10 in the supplied report', questions: [] });
const parse = (value: unknown) => parseTaskCheckpoint(JSON.stringify(value));

describe('task checkpoint contract', () => {
  it('preserves evidence, sources, work and feedback without imposing stages', () => {
    expect(parse(checkpoint())).toEqual(checkpoint());
    expect(parseTaskCheckpoint(`\`\`\`json\n${  JSON.stringify(checkpoint())  }\n\`\`\``)).toEqual(checkpoint());
  });
  it.each(['state', 'work', 'evidence', 'feedback'])('rejects a non-string %s enum even when it stringifies to an allowed value', field => {
    const input: any = checkpoint();
    if (field === 'state') { input.state = ['complete']; }
    if (field === 'work') { input.work[0].status = ['done']; }
    if (field === 'evidence') { input.work[0].findings[0].kind = ['fact']; }
    if (field === 'feedback') { input.feedback[0].status = ['applied']; }
    expect(() => parse(input)).toThrow();
  });
  it('requires a completion summary and a waiting clarification', () => {
    expect(() => parse({ ...checkpoint(), summary: undefined })).toThrow('requires a result');
    expect(() => parse({ state: 'waiting-user', message: 'Need input' })).toThrow('requires a question');
    expect(parse({ state: 'waiting-user', message: 'Need input', clarification: 'Which source?' }).clarification).toBe('Which source?');
  });
  it('requires sources for facts, without claiming those sources are verified', () => {
    const input = checkpoint(); input.work[0].findings[0] = { ...finding, sources: [] };
    expect(() => parse(input)).toThrow('requires sources');
    input.work[0].findings[0].kind = 'inference';
    expect(parse(input).work[0].findings[0].sources).toEqual([]);
  });
  it('normalizes only omitted or empty caveats', () => {
    const input: any = checkpoint(); input.work[0].findings[0] = { ...finding, caveat: undefined };
    expect(parse(input).work[0].findings[0].caveat).toBe('');
    for (const caveat of [null, 1, {}, 'x'.repeat(501)]) {
      input.work[0].findings[0].caveat = caveat;
      expect(() => parse(input)).toThrow('Invalid task checkpoint text');
    }
  });
  it('rejects duplicate work IDs and duplicate feedback dispositions', () => {
    const input = checkpoint(); input.work.push({ ...input.work[0] });
    expect(() => parse(input)).toThrow('Duplicate work update');
    input.work.pop(); input.feedback.push({ ...input.feedback[0] });
    expect(() => parse(input)).toThrow('Duplicate feedback disposition');
  });
  it.each([-1, 1, 0.5, null])('rejects invalid feedback work index %s', index => {
    const input: any = checkpoint(); input.feedback[0].workIndexes = [index];
    expect(() => parse(input)).toThrow('Invalid feedback work reference');
  });
  it('requires actual work references for applied feedback and none for rejected feedback', () => {
    const input = checkpoint(); input.feedback[0].workIndexes = [];
    expect(() => parse(input)).toThrow('actual work update');
    input.feedback[0].status = 'rejected'; expect(parse(input).feedback[0].status).toBe('rejected');
    input.feedback[0].workIndexes = [0]; expect(() => parse(input)).toThrow('actual work update');
  });
  it('rejects oversized fields and collections rather than truncating them', () => {
    expect(() => parse({ ...checkpoint(), message: 'x'.repeat(1001) })).toThrow('text');
    expect(() => parse({ ...checkpoint(), work: Array.from({ length: 9 }, () => checkpoint().work[0]) })).toThrow('list');
    expect(() => parse({ ...checkpoint(), questions: Array(7).fill('Question') })).toThrow('list');
  });
});
