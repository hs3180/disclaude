/**
 * Unit tests for ResearchStateFile
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  ResearchStateFile,
  sanitizeTopic,
} from './research-state-file.js';

describe('ResearchStateFile', () => {
  let rsf: ResearchStateFile;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-test-'));
    rsf = new ResearchStateFile({ workspaceDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('sanitizeTopic', () => {
    it('should convert spaces to hyphens and lowercase', () => {
      expect(sanitizeTopic('AI Safety Research')).toBe('ai-safety-research');
    });

    it('should preserve Chinese characters', () => {
      expect(sanitizeTopic('AI安全研究')).toBe('ai安全研究');
    });

    it('should remove special characters', () => {
      expect(sanitizeTopic('test/topic@name!')).toBe('testtopicname');
    });

    it('should collapse multiple hyphens', () => {
      expect(sanitizeTopic('a  b---c')).toBe('a-b-c');
    });

    it('should trim leading and trailing hyphens', () => {
      expect(sanitizeTopic('--test--')).toBe('test');
    });

    it('should handle underscores', () => {
      expect(sanitizeTopic('test_topic')).toBe('test_topic');
    });

    it('should handle empty string', () => {
      expect(sanitizeTopic('')).toBe('');
    });

    it('should handle only special characters', () => {
      expect(sanitizeTopic('@#$%')).toBe('');
    });
  });

  describe('getResearchDir', () => {
    it('should return correct research directory path', () => {
      const dir = rsf.getResearchDir('ai-safety');
      expect(dir).toContain('research');
      expect(dir).toContain('ai-safety');
      expect(dir).toBe(path.join(tmpDir, 'research', 'ai-safety'));
    });

    it('should use custom subdir if configured', () => {
      const customRsf = new ResearchStateFile({
        workspaceDir: tmpDir,
        researchSubdir: 'studies',
      });
      const dir = customRsf.getResearchDir('ai-safety');
      expect(dir).toBe(path.join(tmpDir, 'studies', 'ai-safety'));
    });

    it('should sanitize topic in directory path', () => {
      const dir = rsf.getResearchDir('AI Safety Research');
      expect(dir).toContain('ai-safety-research');
    });
  });

  describe('getFilePath', () => {
    it('should return correct RESEARCH.md file path', () => {
      const filePath = rsf.getFilePath('ai-safety');
      expect(filePath).toContain('RESEARCH.md');
      expect(filePath).toBe(
        path.join(tmpDir, 'research', 'ai-safety', 'RESEARCH.md')
      );
    });
  });

  describe('exists', () => {
    it('should return false for non-existent topic', async () => {
      expect(await rsf.exists('non-existent')).toBe(false);
    });

    it('should return true after initialization', async () => {
      await rsf.initialize({
        topic: 'test-topic',
        description: 'Test description',
        goals: ['Goal 1'],
      });
      expect(await rsf.exists('test-topic')).toBe(true);
    });
  });

  describe('initialize', () => {
    it('should create RESEARCH.md with correct structure', async () => {
      await rsf.initialize({
        topic: 'test-topic',
        description: 'Research about testing',
        goals: ['Understand testing', 'Write tests'],
      });

      const content = await rsf.readRaw('test-topic');
      expect(content).toContain('# test-topic');
      expect(content).toContain('> Research about testing');
      expect(content).toContain('## 研究目标');
      expect(content).toContain('- [ ] Understand testing');
      expect(content).toContain('- [ ] Write tests');
      expect(content).toContain('## 已收集的信息');
      expect(content).toContain('## 待调查的问题');
      expect(content).toContain('## 研究结论');
      expect(content).toContain('## 相关资源');
      expect(content).toContain('创建时间');
      expect(content).toContain('最后更新');
    });

    it('should create research directory if it does not exist', async () => {
      await rsf.initialize({
        topic: 'new-topic',
        description: 'desc',
        goals: [],
      });

      const dir = rsf.getResearchDir('new-topic');
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should throw if RESEARCH.md already exists', async () => {
      await rsf.initialize({
        topic: 'dup-topic',
        description: 'desc',
        goals: [],
      });

      await expect(
        rsf.initialize({
          topic: 'dup-topic',
          description: 'desc',
          goals: [],
        })
      ).rejects.toThrow('already exists');
    });

    it('should handle empty goals array', async () => {
      await rsf.initialize({
        topic: 'empty-goals',
        description: 'desc',
        goals: [],
      });

      const content = await rsf.readRaw('empty-goals');
      expect(content).toContain('暂无研究目标');
    });
  });

  describe('readState', () => {
    it('should parse all sections correctly', async () => {
      await rsf.initialize({
        topic: 'parse-test',
        description: 'Test parsing',
        goals: ['Goal A', 'Goal B'],
      });

      const state = await rsf.readState('parse-test');
      expect(state.topic).toBe('parse-test');
      expect(state.description).toBe('Test parsing');
      expect(state.goals).toEqual(['Goal A', 'Goal B']);
      expect(state.findings).toEqual([]);
      expect(state.questions).toEqual([]);
      expect(state.resources).toEqual([]);
      expect(state.createdAt).toBeDefined();
      expect(state.updatedAt).toBeDefined();
    });

    it('should throw if RESEARCH.md does not exist', async () => {
      await expect(rsf.readState('no-such-topic')).rejects.toThrow(
        'not found'
      );
    });
  });

  describe('addFinding', () => {
    it('should add a finding with auto-generated timestamp', async () => {
      await rsf.initialize({
        topic: 'findings-test',
        description: 'desc',
        goals: [],
      });

      await rsf.addFinding('findings-test', {
        title: 'RLHF 方法',
        source: 'https://example.com/paper',
        content: '基于人类反馈的强化学习',
      });

      const state = await rsf.readState('findings-test');
      expect(state.findings).toHaveLength(1);
      expect(state.findings[0].title).toBe('RLHF 方法');
      expect(state.findings[0].source).toBe('https://example.com/paper');
      expect(state.findings[0].content).toBe('基于人类反馈的强化学习');
      expect(state.findings[0].timestamp).toBeDefined();
    });

    it('should add multiple findings in order', async () => {
      await rsf.initialize({
        topic: 'multi-findings',
        description: 'desc',
        goals: [],
      });

      await rsf.addFinding('multi-findings', {
        title: 'Finding 1',
        source: 'src1',
        content: 'content1',
      });
      await rsf.addFinding('multi-findings', {
        title: 'Finding 2',
        source: 'src2',
        content: 'content2',
      });

      const state = await rsf.readState('multi-findings');
      expect(state.findings).toHaveLength(2);
      expect(state.findings[0].title).toBe('Finding 1');
      expect(state.findings[1].title).toBe('Finding 2');
    });

    it('should update updatedAt timestamp', async () => {
      await rsf.initialize({
        topic: 'timestamp-test',
        description: 'desc',
        goals: [],
      });

      const stateBefore = await rsf.readState('timestamp-test');
      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));

      await rsf.addFinding('timestamp-test', {
        title: 'New Finding',
        source: 'src',
        content: 'content',
      });

      const stateAfter = await rsf.readState('timestamp-test');
      expect(stateAfter.updatedAt).not.toBe(stateBefore.updatedAt);
    });
  });

  describe('addQuestion', () => {
    it('should add a new question', async () => {
      await rsf.initialize({
        topic: 'questions-test',
        description: 'desc',
        goals: [],
      });

      await rsf.addQuestion('questions-test', 'What is RLHF?');

      const state = await rsf.readState('questions-test');
      expect(state.questions).toHaveLength(1);
      expect(state.questions[0].question).toBe('What is RLHF?');
      expect(state.questions[0].resolved).toBe(false);
    });

    it('should not add duplicate questions', async () => {
      await rsf.initialize({
        topic: 'dup-questions',
        description: 'desc',
        goals: [],
      });

      await rsf.addQuestion('dup-questions', 'Same question?');
      await rsf.addQuestion('dup-questions', 'Same question?');

      const state = await rsf.readState('dup-questions');
      expect(state.questions).toHaveLength(1);
    });
  });

  describe('resolveQuestion', () => {
    it('should mark question as resolved and add finding', async () => {
      await rsf.initialize({
        topic: 'resolve-test',
        description: 'desc',
        goals: [],
      });

      await rsf.addQuestion('resolve-test', 'What is AI?');
      await rsf.resolveQuestion('resolve-test', 'What is AI?', 'AI stands for...');

      const state = await rsf.readState('resolve-test');
      expect(state.questions[0].resolved).toBe(true);
      expect(state.questions[0].resolution).toBe('AI stands for...');

      // Should have created a finding from the resolved question
      const resolvedFinding = state.findings.find((f) =>
        f.title.includes('已解决')
      );
      expect(resolvedFinding).toBeDefined();
      expect(resolvedFinding?.content).toBe('AI stands for...');
    });

    it('should throw when resolving non-existent question', async () => {
      await rsf.initialize({
        topic: 'no-question',
        description: 'desc',
        goals: [],
      });

      await expect(
        rsf.resolveQuestion('no-question', 'No such question', 'answer')
      ).rejects.toThrow('not found');
    });

    it('should be idempotent when resolving same question twice', async () => {
      await rsf.initialize({
        topic: 'idempotent-resolve',
        description: 'desc',
        goals: [],
      });

      await rsf.addQuestion('idempotent-resolve', 'Question?');
      await rsf.resolveQuestion('idempotent-resolve', 'Question?', 'Answer');
      await rsf.resolveQuestion('idempotent-resolve', 'Question?', 'Answer');

      const state = await rsf.readState('idempotent-resolve');
      // Should only create one finding from the resolution
      const resolvedFindings = state.findings.filter((f) =>
        f.title.includes('已解决')
      );
      expect(resolvedFindings).toHaveLength(1);
    });
  });

  describe('addResource', () => {
    it('should add a resource link', async () => {
      await rsf.initialize({
        topic: 'resources-test',
        description: 'desc',
        goals: [],
      });

      await rsf.addResource('resources-test', {
        name: 'OpenAI Blog',
        url: 'https://openai.com/blog',
      });

      const state = await rsf.readState('resources-test');
      expect(state.resources).toHaveLength(1);
      expect(state.resources[0].name).toBe('OpenAI Blog');
      expect(state.resources[0].url).toBe('https://openai.com/blog');
    });

    it('should not add duplicate resources by URL', async () => {
      await rsf.initialize({
        topic: 'dup-resources',
        description: 'desc',
        goals: [],
      });

      await rsf.addResource('dup-resources', {
        name: 'Name A',
        url: 'https://same-url.com',
      });
      await rsf.addResource('dup-resources', {
        name: 'Name B',
        url: 'https://same-url.com',
      });

      const state = await rsf.readState('dup-resources');
      expect(state.resources).toHaveLength(1);
      expect(state.resources[0].name).toBe('Name A');
    });
  });

  describe('setConclusion', () => {
    it('should set research conclusion', async () => {
      await rsf.initialize({
        topic: 'conclusion-test',
        description: 'desc',
        goals: [],
      });

      await rsf.setConclusion(
        'conclusion-test',
        'AI safety is important for future development.'
      );

      const state = await rsf.readState('conclusion-test');
      expect(state.conclusion).toBe('AI safety is important for future development.');
    });
  });

  describe('complete', () => {
    it('should set provided conclusion and return state', async () => {
      await rsf.initialize({
        topic: 'complete-test',
        description: 'desc',
        goals: ['Goal 1'],
      });
      await rsf.addFinding('complete-test', {
        title: 'Finding',
        source: 'src',
        content: 'content',
      });

      const state = await rsf.complete(
        'complete-test',
        'Research complete with key findings.'
      );

      expect(state.conclusion).toBe('Research complete with key findings.');

      // Verify persisted
      const persisted = await rsf.readState('complete-test');
      expect(persisted.conclusion).toBe('Research complete with key findings.');
    });

    it('should auto-generate summary when no conclusion provided', async () => {
      await rsf.initialize({
        topic: 'auto-summary',
        description: 'desc',
        goals: [],
      });
      await rsf.addFinding('auto-summary', {
        title: 'Finding 1',
        source: 'src',
        content: 'content',
      });
      await rsf.addQuestion('auto-summary', 'Question?');
      await rsf.resolveQuestion('auto-summary', 'Question?', 'Answer');
      await rsf.addResource('auto-summary', {
        name: 'Res',
        url: 'https://example.com',
      });

      const state = await rsf.complete('auto-summary');
      expect(state.conclusion).toContain('auto-summary');
      expect(state.conclusion).toContain('2 条发现'); // 1 manual + 1 from resolved question
      expect(state.conclusion).toContain('1 个已解决');
      expect(state.conclusion).toContain('1 个相关资源');
    });
  });

  describe('cleanup', () => {
    it('should remove only RESEARCH.md by default', async () => {
      await rsf.initialize({
        topic: 'cleanup-test',
        description: 'desc',
        goals: [],
      });

      // Create an extra file in the research dir
      const extraFile = path.join(rsf.getResearchDir('cleanup-test'), 'notes.txt');
      await fs.writeFile(extraFile, 'some notes');

      await rsf.cleanup('cleanup-test');

      expect(await rsf.exists('cleanup-test')).toBe(false);
      // Directory should still exist with the extra file
      const stat = await fs.stat(rsf.getResearchDir('cleanup-test'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('should remove entire directory when deleteDir is true', async () => {
      await rsf.initialize({
        topic: 'full-cleanup',
        description: 'desc',
        goals: [],
      });

      await rsf.cleanup('full-cleanup', { deleteDir: true });

      await expect(
        fs.access(rsf.getResearchDir('full-cleanup'))
      ).rejects.toThrow();
    });
  });

  describe('listTopics', () => {
    it('should return empty array when no research exists', async () => {
      expect(await rsf.listTopics()).toEqual([]);
    });

    it('should list all topics with RESEARCH.md', async () => {
      await rsf.initialize({
        topic: 'alpha',
        description: 'desc',
        goals: [],
      });
      await rsf.initialize({
        topic: 'beta',
        description: 'desc',
        goals: [],
      });

      const topics = await rsf.listTopics();
      expect(topics).toContain('alpha');
      expect(topics).toContain('beta');
      expect(topics).toHaveLength(2);
    });

    it('should not include directories without RESEARCH.md', async () => {
      await rsf.initialize({
        topic: 'valid-topic',
        description: 'desc',
        goals: [],
      });

      // Create a directory without RESEARCH.md
      const orphanDir = path.join(tmpDir, 'research', 'orphan');
      await fs.mkdir(orphanDir, { recursive: true });

      const topics = await rsf.listTopics();
      expect(topics).toEqual(['valid-topic']);
    });

    it('should return topics in sorted order', async () => {
      await rsf.initialize({
        topic: 'charlie',
        description: 'desc',
        goals: [],
      });
      await rsf.initialize({
        topic: 'alpha',
        description: 'desc',
        goals: [],
      });

      const topics = await rsf.listTopics();
      expect(topics).toEqual(['alpha', 'charlie']);
    });
  });

  describe('round-trip serialization', () => {
    it('should preserve all data through write/read cycle', async () => {
      await rsf.initialize({
        topic: 'roundtrip',
        description: 'A comprehensive study',
        goals: ['Goal 1', 'Goal 2', 'Goal 3'],
      });

      await rsf.addFinding('roundtrip', {
        title: 'Key Discovery',
        source: 'https://example.com',
        content: 'Important finding about X',
      });

      await rsf.addQuestion('roundtrip', 'Open question?');
      await rsf.addQuestion('roundtrip', 'Another question?');
      await rsf.resolveQuestion('roundtrip', 'Open question?', 'Resolved!');

      await rsf.addResource('roundtrip', {
        name: 'Resource A',
        url: 'https://a.com',
      });

      const state = await rsf.readState('roundtrip');
      expect(state.topic).toBe('roundtrip');
      expect(state.description).toBe('A comprehensive study');
      expect(state.goals).toHaveLength(3);
      expect(state.findings).toHaveLength(2); // 1 added + 1 from resolved question
      expect(state.questions).toHaveLength(2);
      // After round-trip, unresolved questions come first in markdown order
      expect(state.questions[0].resolved).toBe(false);
      expect(state.questions[0].question).toBe('Another question?');
      expect(state.questions[1].resolved).toBe(true);
      expect(state.questions[1].resolution).toBe('Resolved!');
      expect(state.questions[1].question).toBe('Open question?');
      expect(state.resources).toHaveLength(1);
    });

    it('should produce readable Markdown', async () => {
      await rsf.initialize({
        topic: 'readability-test',
        description: 'Testing markdown output',
        goals: ['Readability goal'],
      });
      await rsf.addFinding('readability-test', {
        title: 'Test Finding',
        source: 'https://test.com',
        content: 'Test content',
      });

      const markdown = await rsf.readRaw('readability-test');
      // Should have proper markdown structure
      expect(markdown).toMatch(/^# readability-test\n/);
      expect(markdown).toContain('> Testing markdown output');
      expect(markdown).toContain('### 发现 1: Test Finding');
      expect(markdown).toContain('📌 来源');
      expect(markdown).toContain('📝 关键内容');
      expect(markdown).toContain('⏰ 时间');
      expect(markdown).toContain('---');
    });
  });

  describe('edge cases', () => {
    it('should handle Chinese topic names', async () => {
      await rsf.initialize({
        topic: 'AI安全研究',
        description: '研究AI安全',
        goals: ['了解对齐技术'],
      });

      expect(await rsf.exists('AI安全研究')).toBe(true);
      const state = await rsf.readState('AI安全研究');
      expect(state.topic).toBe('AI安全研究');
      expect(state.description).toBe('研究AI安全');
      expect(state.goals).toEqual(['了解对齐技术']);
    });

    it('should handle special characters in finding content', async () => {
      await rsf.initialize({
        topic: 'special-chars',
        description: 'desc',
        goals: [],
      });

      await rsf.addFinding('special-chars', {
        title: 'Finding with "quotes" & <tags>',
        source: 'https://example.com?param=value&other=123',
        content: 'Content with **markdown** formatting and `code`',
      });

      const state = await rsf.readState('special-chars');
      expect(state.findings[0].title).toContain('"quotes" & <tags>');
      expect(state.findings[0].content).toContain('**markdown**');
    });

    it('should handle very long content', async () => {
      await rsf.initialize({
        topic: 'long-content',
        description: 'desc',
        goals: [],
      });

      const longContent = 'A'.repeat(10000);
      await rsf.addFinding('long-content', {
        title: 'Long finding',
        source: 'src',
        content: longContent,
      });

      const state = await rsf.readState('long-content');
      expect(state.findings[0].content).toBe(longContent);
    });
  });
});
