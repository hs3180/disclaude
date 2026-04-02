/**
 * Tests for ResearchStateFile - RESEARCH.md state file manager.
 *
 * Issue #1710: Tests for research session state file management.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ResearchStateFile } from './research-state-file.js';

describe('ResearchStateFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('should create RESEARCH.md with topic and goals', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: {
          topic: 'AI Safety Research',
          goals: ['Survey alignment techniques', 'Analyze benchmarks'],
          background: 'Investigating state-of-the-art approaches',
        },
      });

      const content = await rsf.read();
      expect(content).toContain('# AI Safety Research');
      expect(content).toContain('> Investigating state-of-the-art approaches');
      expect(content).toContain('- [ ] Survey alignment techniques');
      expect(content).toContain('- [ ] Analyze benchmarks');
    });

    it('should create research directory if it does not exist', async () => {
      const researchDir = path.join(tempDir, 'deep', 'nested', 'dir');
      await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      const stat = await fs.stat(researchDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should include all required sections', async () => {
      const researchDir = path.join(tempDir, 'sections-test');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      const content = await rsf.read();
      expect(content).toContain('## 研究目标');
      expect(content).toContain('## 已收集的信息');
      expect(content).toContain('## 待调查的问题');
      expect(content).toContain('## 研究结论');
      expect(content).toContain('## 相关资源');
    });

    it('should show placeholder when no goals are provided', async () => {
      const researchDir = path.join(tempDir, 'no-goals');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      const content = await rsf.read();
      expect(content).toContain('- [ ] (待定义)');
    });

    it('should omit background line when not provided', async () => {
      const researchDir = path.join(tempDir, 'no-background');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: ['Goal 1'] },
      });

      const content = await rsf.read();
      // The line after the title should not start with >
      const lines = content.split('\n');
      const titleIdx = lines.findIndex(l => l.startsWith('# Test'));
      expect(lines[titleIdx + 1]).not.toMatch(/^>/);
    });

    it('should return correct file path', async () => {
      const researchDir = path.join(tempDir, 'path-test');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      expect(rsf.getFilePath()).toBe(path.join(researchDir, 'RESEARCH.md'));
      expect(rsf.getResearchDir()).toBe(researchDir);
    });
  });

  describe('load', () => {
    it('should load an existing RESEARCH.md file', async () => {
      const researchDir = path.join(tempDir, 'load-test');
      await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Existing Research', goals: ['Goal 1'] },
      });

      const rsf = await ResearchStateFile.load(researchDir);
      const content = await rsf.read();
      expect(content).toContain('# Existing Research');
    });

    it('should throw when RESEARCH.md does not exist', async () => {
      const researchDir = path.join(tempDir, 'missing');

      await expect(ResearchStateFile.load(researchDir)).rejects.toThrow(
        'RESEARCH.md not found'
      );
    });
  });

  describe('exists', () => {
    it('should return true when file exists', async () => {
      const researchDir = path.join(tempDir, 'exists-test');
      await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      const rsf = await ResearchStateFile.load(researchDir);
      expect(await rsf.exists()).toBe(true);
    });

    it('should return false when file does not exist', async () => {
      const rsf = new (ResearchStateFile as any)({
        researchDir: path.join(tempDir, 'nonexistent'),
        topic: { topic: 'Test', goals: [] },
      });
      expect(await rsf.exists()).toBe(false);
    });
  });

  describe('addFinding', () => {
    it('should add a finding with source to the findings section', async () => {
      const researchDir = path.join(tempDir, 'finding-test');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      await rsf.addFinding({
        title: 'RLHF Effectiveness',
        source: 'https://arxiv.org/abs/2209.07858',
        content: 'RLHF reduces harmful outputs by 50%',
      });

      const content = await rsf.read();
      expect(content).toContain('### RLHF Effectiveness');
      expect(content).toContain('- 来源：https://arxiv.org/abs/2209.07858');
      expect(content).toContain('- 关键内容：RLHF reduces harmful outputs by 50%');
    });

    it('should add multiple findings in order', async () => {
      const researchDir = path.join(tempDir, 'multi-finding');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      await rsf.addFinding({
        title: 'Finding 1',
        content: 'First finding',
      });
      await rsf.addFinding({
        title: 'Finding 2',
        content: 'Second finding',
      });

      const content = await rsf.read();
      const finding1Idx = content.indexOf('### Finding 1');
      const finding2Idx = content.indexOf('### Finding 2');
      expect(finding1Idx).toBeLessThan(finding2Idx);
    });

    it('should use "未知" as default source', async () => {
      const researchDir = path.join(tempDir, 'no-source');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      await rsf.addFinding({
        title: 'Finding without source',
        content: 'Some content',
      });

      const content = await rsf.read();
      expect(content).toContain('- 来源：未知');
    });
  });

  describe('addQuestion', () => {
    it('should add a question to the questions section', async () => {
      const researchDir = path.join(tempDir, 'question-test');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      await rsf.addQuestion('What are the limitations of constitutional AI?');

      const content = await rsf.read();
      expect(content).toContain('- [ ] What are the limitations of constitutional AI?');
    });

    it('should add multiple questions', async () => {
      const researchDir = path.join(tempDir, 'multi-question');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      await rsf.addQuestion('Question A?');
      await rsf.addQuestion('Question B?');

      const content = await rsf.read();
      expect(content).toContain('- [ ] Question A?');
      expect(content).toContain('- [ ] Question B?');
    });
  });

  describe('resolveQuestion', () => {
    it('should mark a question as resolved', async () => {
      const researchDir = path.join(tempDir, 'resolve-test');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      await rsf.addQuestion('To be resolved?');
      const result = await rsf.resolveQuestion('To be resolved?');

      expect(result).toBe(true);

      const content = await rsf.read();
      expect(content).toContain('- [x] To be resolved?');
      expect(content).not.toContain('- [ ] To be resolved?');
    });

    it('should return false when question is not found', async () => {
      const researchDir = path.join(tempDir, 'resolve-missing');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      const result = await rsf.resolveQuestion('Nonexistent question?');
      expect(result).toBe(false);
    });

    it('should not mark already resolved questions', async () => {
      const researchDir = path.join(tempDir, 'resolve-twice');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      await rsf.addQuestion('Already resolved?');
      await rsf.resolveQuestion('Already resolved?');
      const secondResult = await rsf.resolveQuestion('Already resolved?');

      // Should return false because the unresolved version no longer exists
      expect(secondResult).toBe(false);
    });
  });

  describe('addResource', () => {
    it('should add a resource link to the resources section', async () => {
      const researchDir = path.join(tempDir, 'resource-test');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      await rsf.addResource('Anthropic Safety', 'https://www.anthropic.com/safety');

      const content = await rsf.read();
      expect(content).toContain('- [Anthropic Safety](https://www.anthropic.com/safety)');
    });

    it('should add multiple resources', async () => {
      const researchDir = path.join(tempDir, 'multi-resource');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      await rsf.addResource('Resource A', 'https://a.com');
      await rsf.addResource('Resource B', 'https://b.com');

      const content = await rsf.read();
      expect(content).toContain('- [Resource A](https://a.com)');
      expect(content).toContain('- [Resource B](https://b.com)');
    });
  });

  describe('finalizeConclusion', () => {
    it('should write conclusion to the conclusions section', async () => {
      const researchDir = path.join(tempDir, 'conclusion-test');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      await rsf.finalizeConclusion(
        'RLHF and CAI together provide robust safety alignment for large language models.'
      );

      const content = await rsf.read();
      expect(content).toContain('RLHF and CAI together provide robust safety alignment');
    });

    it('should support multi-line conclusions', async () => {
      const researchDir = path.join(tempDir, 'multiline-conclusion');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: { topic: 'Test', goals: [] },
      });

      await rsf.finalizeConclusion(
        'Key findings:\n1. RLHF is effective\n2. CAI adds constraints\n3. Combined approach recommended'
      );

      const content = await rsf.read();
      expect(content).toContain('Key findings:');
      expect(content).toContain('1. RLHF is effective');
      expect(content).toContain('3. Combined approach recommended');
    });
  });

  describe('integration: full research lifecycle', () => {
    it('should handle a complete research session', async () => {
      const researchDir = path.join(tempDir, 'full-lifecycle');
      const rsf = await ResearchStateFile.init({
        researchDir,
        topic: {
          topic: 'Web Framework Comparison',
          goals: ['Compare performance', 'Evaluate developer experience'],
          background: 'Choosing between React, Vue, and Svelte for a new project',
        },
      });

      // Add findings
      await rsf.addFinding({
        title: 'React Performance',
        source: 'https://react.dev/blog/2024/performance',
        content: 'React 19 introduces compiler optimizations reducing re-renders by 40%',
      });
      await rsf.addFinding({
        title: 'Vue Developer Experience',
        source: 'Vue.js Survey 2024',
        content: '92% of developers report satisfaction with Vue DX',
      });

      // Add questions
      await rsf.addQuestion('How does Svelte 5 runes compare to React signals?');
      await rsf.addQuestion('What is the bundle size impact of each framework?');

      // Resolve one question
      await rsf.resolveQuestion('What is the bundle size impact of each framework?');

      // Add resources
      await rsf.addResource('React Docs', 'https://react.dev');
      await rsf.addResource('Vue Guide', 'https://vuejs.org/guide');

      // Finalize
      await rsf.finalizeConclusion(
        'React and Vue are both excellent choices. React has a larger ecosystem,\n' +
        'while Vue offers better DX. Svelte 5 shows promise but the ecosystem is smaller.'
      );

      // Verify final state
      const content = await rsf.read();

      // Topic and background
      expect(content).toContain('# Web Framework Comparison');
      expect(content).toContain('Choosing between React, Vue, and Svelte');

      // Goals
      expect(content).toContain('- [ ] Compare performance');
      expect(content).toContain('- [ ] Evaluate developer experience');

      // Findings
      expect(content).toContain('### React Performance');
      expect(content).toContain('### Vue Developer Experience');

      // Questions - one resolved, one pending
      expect(content).toContain('- [ ] How does Svelte 5 runes compare to React signals?');
      expect(content).toContain('- [x] What is the bundle size impact of each framework?');

      // Resources
      expect(content).toContain('- [React Docs](https://react.dev)');
      expect(content).toContain('- [Vue Guide](https://vuejs.org/guide)');

      // Conclusion
      expect(content).toContain('React and Vue are both excellent choices');
    });
  });
});
