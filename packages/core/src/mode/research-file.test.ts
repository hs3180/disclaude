/**
 * Tests for RESEARCH.md file management module.
 *
 * Issue #1710: Research state file for tracking research progress.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createInitialResearchFile,
  generateResearchMarkdown,
  parseResearchMarkdown,
  addFinding,
  addOpenQuestion,
  resolveOpenQuestion,
  setConclusion,
  addResource,
  addObjective,
  completeObjective,
  archiveResearch,
  type ResearchFileData,
} from './research-file.js';

describe('createInitialResearchFile', () => {
  it('should create with topic only', () => {
    const data = createInitialResearchFile({ topic: 'machine-learning' });
    expect(data.metadata.topic).toBe('machine-learning');
    expect(data.metadata.createdAt).toBeTruthy();
    expect(data.metadata.updatedAt).toBeTruthy();
    expect(data.goal).toBe('');
    expect(data.objectives).toEqual([]);
    expect(data.findings).toEqual([]);
    expect(data.openQuestions).toEqual([]);
    expect(data.conclusion).toBe('');
    expect(data.resources).toEqual([]);
  });

  it('should create with topic and goal', () => {
    const data = createInitialResearchFile({
      topic: 'rust-async',
      goal: 'Understand Rust async/await patterns',
    });
    expect(data.metadata.topic).toBe('rust-async');
    expect(data.goal).toBe('Understand Rust async/await patterns');
  });

  it('should create with initial objectives', () => {
    const data = createInitialResearchFile({
      topic: 'web-performance',
      objectives: ['Measure LCP', 'Reduce CLS', 'Improve FID'],
    });
    expect(data.objectives).toEqual(['Measure LCP', 'Reduce CLS', 'Improve FID']);
  });

  it('should set createdAt and updatedAt to current time', () => {
    const before = new Date().toISOString();
    const data = createInitialResearchFile({ topic: 'test' });
    const after = new Date().toISOString();
    expect(data.metadata.createdAt >= before).toBe(true);
    expect(data.metadata.createdAt <= after).toBe(true);
    expect(data.metadata.updatedAt).toBe(data.metadata.createdAt);
  });
});

describe('generateResearchMarkdown', () => {
  let data: ResearchFileData;

  beforeEach(() => {
    data = createInitialResearchFile({
      topic: 'machine-learning',
      goal: 'Study transformer architectures',
      objectives: ['Read Attention Is All You Need', 'Implement a simple transformer'],
    });
  });

  it('should include the topic in the title', () => {
    const md = generateResearchMarkdown(data);
    expect(md).toContain('# 研究: machine-learning');
  });

  it('should include the goal as a blockquote', () => {
    const md = generateResearchMarkdown(data);
    expect(md).toContain('> Study transformer architectures');
  });

  it('should include creation and update timestamps', () => {
    const md = generateResearchMarkdown(data);
    expect(md).toContain('创建时间:');
    expect(md).toContain('最后更新:');
    expect(md).toContain(data.metadata.createdAt);
  });

  it('should list objectives as checkboxes', () => {
    const md = generateResearchMarkdown(data);
    expect(md).toContain('- [ ] Read Attention Is All You Need');
    expect(md).toContain('- [ ] Implement a simple transformer');
  });

  it('should show placeholder for empty findings', () => {
    const md = generateResearchMarkdown(data);
    expect(md).toContain('(尚无发现)');
  });

  it('should show placeholder for empty open questions', () => {
    const md = generateResearchMarkdown(data);
    expect(md).toContain('(无待调查问题)');
  });

  it('should show placeholder for empty conclusion', () => {
    const md = generateResearchMarkdown(data);
    expect(md).toContain('(研究尚未完成)');
  });

  it('should render findings with title, source, content, and timestamp', () => {
    data = addFinding(data, {
      title: 'Transformer Architecture',
      content: 'Self-attention mechanism allows parallel processing.',
      source: 'https://arxiv.org/abs/1706.03762',
    });
    const md = generateResearchMarkdown(data);
    expect(md).toContain('### Transformer Architecture');
    expect(md).toContain('**来源**: https://arxiv.org/abs/1706.03762');
    expect(md).toContain('Self-attention mechanism allows parallel processing.');
    expect(md).toContain('添加时间:');
  });

  it('should render resources as markdown links', () => {
    data = addResource(data, { name: 'Attention Paper', url: 'https://arxiv.org/abs/1706.03762' });
    data = addResource(data, { name: 'Local notes' });
    const md = generateResearchMarkdown(data);
    expect(md).toContain('[Attention Paper](https://arxiv.org/abs/1706.03762)');
    expect(md).toContain('- Local notes');
  });

  it('should include all section headers', () => {
    const md = generateResearchMarkdown(data);
    expect(md).toContain('## 研究目标清单');
    expect(md).toContain('## 已收集的信息');
    expect(md).toContain('## 待调查的问题');
    expect(md).toContain('## 研究结论');
    expect(md).toContain('## 相关资源');
  });
});

describe('parseResearchMarkdown', () => {
  it('should parse a basic research file', () => {
    const data = createInitialResearchFile({
      topic: 'test-topic',
      goal: 'Test goal',
      objectives: ['Objective 1', 'Objective 2'],
    });
    const md = generateResearchMarkdown(data);
    const parsed = parseResearchMarkdown(md);

    expect(parsed.metadata.topic).toBe('test-topic');
    expect(parsed.goal).toBe('Test goal');
    expect(parsed.objectives).toEqual(['Objective 1', 'Objective 2']);
    expect(parsed.findings).toEqual([]);
    expect(parsed.openQuestions).toEqual([]);
    expect(parsed.resources).toEqual([]);
  });

  it('should round-trip with findings', () => {
    let data = createInitialResearchFile({
      topic: 'deep-learning',
      goal: 'Study neural networks',
    });
    data = addFinding(data, {
      title: 'Backpropagation',
      content: 'Chain rule applied to neural networks.',
      source: 'https://en.wikipedia.org/wiki/Backpropagation',
    });
    data = addFinding(data, {
      title: 'Gradient Descent',
      content: 'Optimization algorithm for minimization.',
    });

    const md = generateResearchMarkdown(data);
    const parsed = parseResearchMarkdown(md);

    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0].title).toBe('Backpropagation');
    expect(parsed.findings[0].content).toBe('Chain rule applied to neural networks.');
    expect(parsed.findings[0].source).toBe('https://en.wikipedia.org/wiki/Backpropagation');
    expect(parsed.findings[1].title).toBe('Gradient Descent');
    expect(parsed.findings[1].source).toBeUndefined();
  });

  it('should round-trip with open questions', () => {
    let data = createInitialResearchFile({ topic: 'quantum' });
    data = addOpenQuestion(data, 'How does entanglement work?');
    data = addOpenQuestion(data, 'What is superposition?');

    const md = generateResearchMarkdown(data);
    const parsed = parseResearchMarkdown(md);

    expect(parsed.openQuestions).toEqual([
      'How does entanglement work?',
      'What is superposition?',
    ]);
  });

  it('should round-trip with resources', () => {
    let data = createInitialResearchFile({ topic: 'rust' });
    data = addResource(data, { name: 'The Rust Book', url: 'https://doc.rust-lang.org/book/' });
    data = addResource(data, { name: 'Rust by Example' });

    const md = generateResearchMarkdown(data);
    const parsed = parseResearchMarkdown(md);

    expect(parsed.resources).toHaveLength(2);
    expect(parsed.resources[0].name).toBe('The Rust Book');
    expect(parsed.resources[0].url).toBe('https://doc.rust-lang.org/book/');
    expect(parsed.resources[1].name).toBe('Rust by Example');
    expect(parsed.resources[1].url).toBeUndefined();
  });

  it('should round-trip with conclusion', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = setConclusion(data, 'The research found that X is better than Y for use case Z.');

    const md = generateResearchMarkdown(data);
    const parsed = parseResearchMarkdown(md);

    expect(parsed.conclusion).toBe('The research found that X is better than Y for use case Z.');
  });

  it('should extract timestamps correctly', () => {
    const data = createInitialResearchFile({ topic: 'time-test' });
    const md = generateResearchMarkdown(data);
    const parsed = parseResearchMarkdown(md);

    expect(parsed.metadata.createdAt).toBe(data.metadata.createdAt);
    expect(parsed.metadata.updatedAt).toBe(data.metadata.updatedAt);
  });

  it('should handle unknown topic gracefully', () => {
    const parsed = parseResearchMarkdown('Some random content without headers');
    expect(parsed.metadata.topic).toBe('unknown');
  });

  it('should handle English-style title prefix', () => {
    const parsed = parseResearchMarkdown('# Research: english-topic\n> A goal');
    expect(parsed.metadata.topic).toBe('english-topic');
    expect(parsed.goal).toBe('A goal');
  });
});

describe('addFinding', () => {
  it('should add a finding with all fields', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = addFinding(data, {
      title: 'Discovery',
      content: 'Something found',
      source: 'https://example.com',
    });

    expect(updated.findings).toHaveLength(1);
    expect(updated.findings[0].title).toBe('Discovery');
    expect(updated.findings[0].content).toBe('Something found');
    expect(updated.findings[0].source).toBe('https://example.com');
    expect(updated.findings[0].addedAt).toBeTruthy();
  });

  it('should add a finding without source', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = addFinding(data, {
      title: 'Local Finding',
      content: 'Found locally',
    });

    expect(updated.findings[0].source).toBeUndefined();
  });

  it('should update the updatedAt timestamp', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = addFinding(data, { title: 'F', content: 'C' });

    expect(updated.metadata.updatedAt >= data.metadata.updatedAt).toBe(true);
  });

  it('should not mutate the original data', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const originalUpdatedAt = data.metadata.updatedAt;

    // Small delay to ensure timestamp difference
    addFinding(data, { title: 'F', content: 'C' });

    expect(data.findings).toHaveLength(0);
    expect(data.metadata.updatedAt).toBe(originalUpdatedAt);
  });

  it('should accumulate multiple findings', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = addFinding(data, { title: 'First', content: 'C1' });
    data = addFinding(data, { title: 'Second', content: 'C2' });
    data = addFinding(data, { title: 'Third', content: 'C3' });

    expect(data.findings).toHaveLength(3);
  });
});

describe('addOpenQuestion', () => {
  it('should add a question', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = addOpenQuestion(data, 'Why is the sky blue?');

    expect(updated.openQuestions).toEqual(['Why is the sky blue?']);
  });

  it('should avoid duplicate questions (case-insensitive)', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = addOpenQuestion(data, 'Why is the sky blue?');
    data = addOpenQuestion(data, 'WHY IS THE SKY BLUE?');
    data = addOpenQuestion(data, 'why is the sky blue?');

    expect(data.openQuestions).toHaveLength(1);
  });

  it('should ignore empty questions', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = addOpenQuestion(data, '  ');

    expect(updated.openQuestions).toHaveLength(0);
  });

  it('should trim whitespace', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = addOpenQuestion(data, '  A question  ');

    expect(updated.openQuestions).toEqual(['A question']);
  });

  it('should not mutate the original data', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    addOpenQuestion(data, 'A question?');
    expect(data.openQuestions).toHaveLength(0);
  });
});

describe('resolveOpenQuestion', () => {
  it('should remove a matching question', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = addOpenQuestion(data, 'Question A');
    data = addOpenQuestion(data, 'Question B');
    data = resolveOpenQuestion(data, 'Question A');

    expect(data.openQuestions).toEqual(['Question B']);
  });

  it('should match by partial substring (case-insensitive)', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = addOpenQuestion(data, 'How does quantum entanglement work?');
    data = resolveOpenQuestion(data, 'quantum entanglement');

    expect(data.openQuestions).toHaveLength(0);
  });

  it('should not modify if question not found', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = addOpenQuestion(data, 'Question A');
    const before = data.metadata.updatedAt;
    data = resolveOpenQuestion(data, 'Nonexistent question');

    expect(data.openQuestions).toHaveLength(1);
    // Should return same reference since no change
    expect(data.metadata.updatedAt).toBe(before);
  });

  it('should handle empty input', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = addOpenQuestion(data, 'Question A');
    data = resolveOpenQuestion(data, '  ');

    expect(data.openQuestions).toHaveLength(1);
  });
});

describe('setConclusion', () => {
  it('should set the conclusion text', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = setConclusion(data, 'Research complete. X is the answer.');

    expect(updated.conclusion).toBe('Research complete. X is the answer.');
  });

  it('should trim whitespace', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = setConclusion(data, '  Conclusion text  ');

    expect(updated.conclusion).toBe('Conclusion text');
  });

  it('should update the updatedAt timestamp', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = setConclusion(data, 'Done');

    expect(updated.metadata.updatedAt >= data.metadata.updatedAt).toBe(true);
  });
});

describe('addResource', () => {
  it('should add a resource with URL', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = addResource(data, {
      name: 'MDN Web Docs',
      url: 'https://developer.mozilla.org',
    });

    expect(updated.resources).toHaveLength(1);
    expect(updated.resources[0].name).toBe('MDN Web Docs');
    expect(updated.resources[0].url).toBe('https://developer.mozilla.org');
  });

  it('should add a resource without URL', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = addResource(data, { name: 'Personal notes' });

    expect(updated.resources[0].url).toBeUndefined();
  });

  it('should avoid duplicates by name (case-insensitive)', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = addResource(data, { name: 'MDN', url: 'https://mdn.com' });
    data = addResource(data, { name: 'mdn', url: 'https://mdn.org' });

    expect(data.resources).toHaveLength(1);
    expect(data.resources[0].url).toBe('https://mdn.com');
  });
});

describe('addObjective', () => {
  it('should add an objective', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = addObjective(data, 'Benchmark performance');

    expect(updated.objectives).toEqual(['Benchmark performance']);
  });

  it('should avoid duplicates (case-insensitive)', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = addObjective(data, 'Write tests');
    data = addObjective(data, 'WRITE TESTS');

    expect(data.objectives).toHaveLength(1);
  });

  it('should ignore empty objectives', () => {
    const data = createInitialResearchFile({ topic: 'test' });
    const updated = addObjective(data, '');

    expect(updated.objectives).toHaveLength(0);
  });
});

describe('completeObjective', () => {
  it('should remove a matching objective', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = addObjective(data, 'Write code');
    data = addObjective(data, 'Write tests');
    data = completeObjective(data, 'Write code');

    expect(data.objectives).toEqual(['Write tests']);
  });

  it('should match by partial substring (case-insensitive)', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = addObjective(data, 'Implement authentication middleware');
    data = completeObjective(data, 'authentication');

    expect(data.objectives).toHaveLength(0);
  });

  it('should not modify if objective not found', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = addObjective(data, 'Task A');
    const before = data.metadata.updatedAt;
    data = completeObjective(data, 'Nonexistent');

    expect(data.objectives).toHaveLength(1);
    expect(data.metadata.updatedAt).toBe(before);
  });
});

describe('archiveResearch', () => {
  it('should produce archive content with header', () => {
    let data = createInitialResearchFile({
      topic: 'archived-topic',
      goal: 'Completed research',
    });
    data = setConclusion(data, 'Research concluded successfully.');

    const result = archiveResearch(data);

    expect(result.archivedContent).toContain('📁 研究归档: archived-topic');
    expect(result.archivedContent).toContain('本研究已于');
    expect(result.archivedContent).toContain('完成。');
    expect(result.archivedContent).toContain('研究目标清单');
    expect(result.archivedContent).toContain('Research concluded successfully.');
  });

  it('should include archive timestamp', () => {
    const before = new Date().toISOString();
    let data = createInitialResearchFile({ topic: 'test' });
    data = setConclusion(data, 'Done');
    const result = archiveResearch(data);
    const after = new Date().toISOString();

    expect(result.archivedAt >= before).toBe(true);
    expect(result.archivedAt <= after).toBe(true);
  });

  it('should include the full research content', () => {
    let data = createInitialResearchFile({
      topic: 'full-test',
      goal: 'Full test',
      objectives: ['Obj 1'],
    });
    data = addFinding(data, { title: 'F1', content: 'Finding content' });
    data = addOpenQuestion(data, 'Question?');
    data = addResource(data, { name: 'Resource', url: 'https://example.com' });
    data = setConclusion(data, 'Conclusion text');

    const result = archiveResearch(data);
    expect(result.archivedContent).toContain('### F1');
    expect(result.archivedContent).toContain('Finding content');
    expect(result.archivedContent).toContain('Question?');
    expect(result.archivedContent).toContain('[Resource](https://example.com)');
    expect(result.archivedContent).toContain('Conclusion text');
  });

  it('should update the updatedAt timestamp in archived content', () => {
    let data = createInitialResearchFile({ topic: 'test' });
    data = setConclusion(data, 'Done');
    const result = archiveResearch(data);

    expect(result.archivedContent).toContain(result.archivedAt);
  });
});

describe('full workflow', () => {
  it('should support a complete research lifecycle', () => {
    // Phase 1: Initialize
    let data = createInitialResearchFile({
      topic: 'typescript-generics',
      goal: 'Understand advanced TypeScript generic patterns',
      objectives: [
        'Study conditional types',
        'Learn mapped types',
        'Understand template literal types',
      ],
    });

    // Phase 2: Add findings and questions during research
    data = addFinding(data, {
      title: 'Conditional Types',
      content: 'Conditional types allow type-level branching with `T extends U ? X : Y`.',
      source: 'https://www.typescriptlang.org/docs/handbook/2/conditional-types.html',
    });

    data = addOpenQuestion(data, 'How do conditional types interact with infer?');
    data = addOpenQuestion(data, 'What are distributive conditional types?');

    // Resolve a question
    data = resolveOpenQuestion(data, 'distributive conditional types');

    // Complete an objective
    data = completeObjective(data, 'conditional types');

    // Add a resource
    data = addResource(data, {
      name: 'TypeScript Handbook - Generics',
      url: 'https://www.typescriptlang.org/docs/handbook/2/generics.html',
    });

    // Phase 3: Conclude and archive
    data = setConclusion(
      data,
      'TypeScript generics are a powerful type-level programming feature. Conditional types, mapped types, and template literal types form the foundation of advanced type manipulation.'
    );

    const result = archiveResearch(data);

    // Verify the archive
    expect(result.archivedContent).toContain('typescript-generics');
    expect(result.archivedContent).toContain('Understand advanced TypeScript generic patterns');
    expect(result.archivedContent).toContain('Conditional Types');
    expect(result.archivedContent).toContain('How do conditional types interact with infer?');
    expect(result.archivedContent).not.toContain('distributive conditional types');
    expect(data.objectives).toHaveLength(2); // One completed
    expect(data.findings).toHaveLength(1);
    expect(data.openQuestions).toHaveLength(1); // One resolved

    // Verify round-trip: parse the inner research content (not the archive wrapper)
    // The archive content has a wrapper header, so we parse the inner part
    const innerContent = result.archivedContent.split('---\n')[1];
    const parsed = parseResearchMarkdown(innerContent);
    expect(parsed.metadata.topic).toBe('typescript-generics');
    expect(parsed.goal).toBe('Understand advanced TypeScript generic patterns');
  });
});
