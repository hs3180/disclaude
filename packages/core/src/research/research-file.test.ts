/**
 * Tests for ResearchFileManager (packages/core/src/research/research-file.ts)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  ResearchFileManager,
  isValidTopic,
  sanitizeTopic,
} from './research-file.js';
import type { ResearchInitOptions, ResearchFinding } from './research-file.js';

describe('ResearchFileManager', () => {
  let manager: ResearchFileManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-test-'));
    manager = new ResearchFileManager({ workspaceDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // isValidTopic
  // =========================================================================

  describe('isValidTopic', () => {
    it('should accept valid alphanumeric topics', () => {
      expect(isValidTopic('ai-safety')).toBe(true);
      expect(isValidTopic('web_performance')).toBe(true);
      expect(isValidTopic('react-hooks')).toBe(true);
      expect(isValidTopic('v2.0')).toBe(true);
      expect(isValidTopic('test.123')).toBe(true);
    });

    it('should reject empty or null topics', () => {
      expect(isValidTopic('')).toBe(false);
      expect(isValidTopic(null as unknown as string)).toBe(false);
      expect(isValidTopic(undefined as unknown as string)).toBe(false);
    });

    it('should reject path traversal attempts', () => {
      expect(isValidTopic('../etc/passwd')).toBe(false);
      expect(isValidTopic('..')).toBe(false);
      expect(isValidTopic('.')).toBe(false);
      expect(isValidTopic('/absolute/path')).toBe(false);
      expect(isValidTopic('foo/../bar')).toBe(false);
    });

    it('should reject topics with special characters', () => {
      expect(isValidTopic('foo bar')).toBe(false);
      expect(isValidTopic('foo;rm -rf')).toBe(false);
      expect(isValidTopic('a/b')).toBe(false);
      expect(isValidTopic('a\\b')).toBe(false);
    });

    it('should reject topics starting with non-alphanumeric', () => {
      expect(isValidTopic('-leading-dash')).toBe(false);
      expect(isValidTopic('_leading-underscore')).toBe(false);
    });

    it('should reject overly long topics', () => {
      expect(isValidTopic('a'.repeat(129))).toBe(false);
      expect(isValidTopic('a'.repeat(128))).toBe(true);
    });
  });

  // =========================================================================
  // sanitizeTopic
  // =========================================================================

  describe('sanitizeTopic', () => {
    it('should lowercase and replace spaces with hyphens', () => {
      expect(sanitizeTopic('AI Safety Research')).toBe('ai-safety-research');
    });

    it('should remove special characters', () => {
      expect(sanitizeTopic('foo@bar#baz!')).toBe('foo-bar-baz');
    });

    it('should collapse multiple hyphens', () => {
      expect(sanitizeTopic('a  b   c')).toBe('a-b-c');
    });

    it('should trim leading and trailing hyphens', () => {
      expect(sanitizeTopic('--foo--')).toBe('foo');
    });

    it('should return "untitled" for empty strings', () => {
      expect(sanitizeTopic('')).toBe('untitled');
      expect(sanitizeTopic('   ')).toBe('untitled');
    });

    it('should produce valid topic names', () => {
      const sanitized = sanitizeTopic('Hello World! (2024)');
      expect(isValidTopic(sanitized)).toBe(true);
    });
  });

  // =========================================================================
  // initialize
  // =========================================================================

  describe('initialize', () => {
    const defaultOptions: ResearchInitOptions = {
      topic: 'ai-safety',
      description: 'Research AI safety best practices',
      goals: ['Review alignment research', 'Analyze RLHF methods'],
    };

    it('should create RESEARCH.md with template content', async () => {
      await manager.initialize(defaultOptions);

      const content = await manager.read('ai-safety');
      expect(content).toContain('# Ai Safety');
      expect(content).toContain('> Research AI safety best practices');
      expect(content).toContain('## 研究目标');
      expect(content).toContain('- [ ] Review alignment research');
      expect(content).toContain('- [ ] Analyze RLHF methods');
      expect(content).toContain('## 已收集的信息');
      expect(content).toContain('## 待调查的问题');
      expect(content).toContain('## 研究结论');
      expect(content).toContain('## 相关资源');
    });

    it('should create the research directory structure', async () => {
      await manager.initialize(defaultOptions);

      const researchDir = manager.getResearchDir('ai-safety');
      const stat = await fs.stat(researchDir);
      expect(stat.isDirectory()).toBe(true);

      const filePath = manager.getResearchFilePath('ai-safety');
      const fileStat = await fs.stat(filePath);
      expect(fileStat.isFile()).toBe(true);
    });

    it('should use default goal when no goals provided', async () => {
      await manager.initialize({
        topic: 'test-topic',
        description: 'Test description',
      });

      const content = await manager.read('test-topic');
      expect(content).toContain('- [ ] Define research objectives');
    });

    it('should throw for invalid topic names', async () => {
      await expect(
        manager.initialize({
          topic: '../evil',
          description: 'Test',
        })
      ).rejects.toThrow('Invalid topic name');
    });

    it('should throw if RESEARCH.md already exists', async () => {
      await manager.initialize(defaultOptions);
      await expect(manager.initialize(defaultOptions)).rejects.toThrow('already exists');
    });

    it('should allow different topics to coexist', async () => {
      await manager.initialize(defaultOptions);
      await manager.initialize({
        topic: 'web-perf',
        description: 'Web performance research',
      });

      expect(await manager.exists('ai-safety')).toBe(true);
      expect(await manager.exists('web-perf')).toBe(true);
    });
  });

  // =========================================================================
  // read / readParsed
  // =========================================================================

  describe('read', () => {
    it('should return RESEARCH.md content', async () => {
      await manager.initialize({
        topic: 'test',
        description: 'Test research',
        goals: ['Goal 1'],
      });

      const content = await manager.read('test');
      expect(content).toContain('# Test');
      expect(content).toContain('> Test research');
    });

    it('should throw if RESEARCH.md does not exist', async () => {
      await expect(manager.read('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('readParsed', () => {
    it('should parse all sections correctly', async () => {
      await manager.initialize({
        topic: 'test',
        description: 'Test description',
        goals: ['Goal 1', 'Goal 2'],
      });

      await manager.addFinding('test', {
        title: 'Finding 1',
        source: 'https://example.com',
        content: 'Some content',
      });

      await manager.addQuestion('test', 'Question 1?');
      await manager.addResource('test', { name: 'Example', url: 'https://example.com' });

      const parsed = await manager.readParsed('test');

      expect(parsed.title).toBe('Test');
      expect(parsed.description).toBe('Test description');
      expect(parsed.goals).toEqual(['Goal 1', 'Goal 2']);
      expect(parsed.pendingGoals).toEqual(['Goal 1', 'Goal 2']);
      expect(parsed.completedGoals).toEqual([]);
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.findings[0].title).toBe('Finding 1');
      expect(parsed.findings[0].source).toBe('https://example.com');
      expect(parsed.findings[0].content).toBe('Some content');
      expect(parsed.questions).toEqual(['Question 1?']);
      expect(parsed.resources).toEqual([{ name: 'Example', url: 'https://example.com' }]);
    });

    it('should parse completed goals', async () => {
      await manager.initialize({
        topic: 'test',
        description: 'Test',
        goals: ['Goal 1'],
      });

      await manager.completeGoal('test', 'Goal 1');

      const parsed = await manager.readParsed('test');
      expect(parsed.completedGoals).toEqual(['Goal 1']);
      expect(parsed.pendingGoals).toEqual([]);
    });

    it('should parse conclusion', async () => {
      await manager.initialize({
        topic: 'test',
        description: 'Test',
      });

      await manager.setConclusion('test', 'This is the conclusion.');

      const parsed = await manager.readParsed('test');
      expect(parsed.conclusion).toContain('This is the conclusion.');
    });
  });

  // =========================================================================
  // exists / listTopics
  // =========================================================================

  describe('exists', () => {
    it('should return false for non-existent topic', async () => {
      expect(await manager.exists('nonexistent')).toBe(false);
    });

    it('should return true after initialization', async () => {
      await manager.initialize({
        topic: 'test',
        description: 'Test',
      });
      expect(await manager.exists('test')).toBe(true);
    });
  });

  describe('listTopics', () => {
    it('should return empty array when no topics exist', async () => {
      expect(await manager.listTopics()).toEqual([]);
    });

    it('should list all initialized topics', async () => {
      await manager.initialize({ topic: 'alpha', description: 'A' });
      await manager.initialize({ topic: 'beta', description: 'B' });
      await manager.initialize({ topic: 'gamma', description: 'C' });

      const topics = await manager.listTopics();
      expect(topics).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('should skip directories without RESEARCH.md', async () => {
      await manager.initialize({ topic: 'valid', description: 'V' });
      // Create a directory without RESEARCH.md
      await fs.mkdir(path.join(tmpDir, 'research', 'no-file'));

      const topics = await manager.listTopics();
      expect(topics).toEqual(['valid']);
    });

    it('should skip _archived directory', async () => {
      await manager.initialize({ topic: 'active', description: 'A' });
      await fs.mkdir(path.join(tmpDir, 'research', '_archived'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'research', '_archived', 'RESEARCH.md'), '# archived');

      const topics = await manager.listTopics();
      expect(topics).toEqual(['active']);
    });
  });

  // =========================================================================
  // addFinding
  // =========================================================================

  describe('addFinding', () => {
    it('should add a finding with source and content', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });

      const finding: ResearchFinding = {
        title: 'RLHF Effectiveness',
        source: 'https://arxiv.org/abs/2309.15087',
        content: 'RLHF reduces harmful outputs by 50%',
      };

      await manager.addFinding('test', finding);
      const content = await manager.read('test');

      expect(content).toContain('### RLHF Effectiveness');
      expect(content).toContain('- 来源：https://arxiv.org/abs/2309.15087');
      expect(content).toContain('- 关键内容：RLHF reduces harmful outputs by 50%');
    });

    it('should add a finding without source', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });

      await manager.addFinding('test', {
        title: 'Observation',
        content: 'No source available',
      });

      const content = await manager.read('test');
      expect(content).toContain('### Observation');
      expect(content).toContain('- 关键内容：No source available');
    });

    it('should append multiple findings in order', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });

      await manager.addFinding('test', { title: 'First', content: 'C1' });
      await manager.addFinding('test', { title: 'Second', content: 'C2' });

      const parsed = await manager.readParsed('test');
      expect(parsed.findings).toHaveLength(2);
      expect(parsed.findings[0].title).toBe('First');
      expect(parsed.findings[1].title).toBe('Second');
    });
  });

  // =========================================================================
  // addQuestion
  // =========================================================================

  describe('addQuestion', () => {
    it('should add a question as a checklist item', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });

      await manager.addQuestion('test', 'How does RLHF work?');

      const content = await manager.read('test');
      expect(content).toContain('- [ ] How does RLHF work?');
    });

    it('should append multiple questions', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });

      await manager.addQuestion('test', 'Question 1?');
      await manager.addQuestion('test', 'Question 2?');

      const parsed = await manager.readParsed('test');
      expect(parsed.questions).toEqual(['Question 1?', 'Question 2?']);
    });
  });

  // =========================================================================
  // resolveQuestion
  // =========================================================================

  describe('resolveQuestion', () => {
    it('should mark question as resolved and add finding', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });
      await manager.addQuestion('test', 'How does it work?');

      await manager.resolveQuestion('test', 'How does it work?', 'It works via transformers.');

      const content = await manager.read('test');
      expect(content).toContain('- [x] How does it work? (resolved)');
      expect(content).toContain('### Q: How does it work?');
      expect(content).toContain('It works via transformers.');
    });

    it('should remove resolved question from pending list', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });
      await manager.addQuestion('test', 'Q1');
      await manager.addQuestion('test', 'Q2');

      await manager.resolveQuestion('test', 'Q1', 'Answer 1');

      const parsed = await manager.readParsed('test');
      expect(parsed.questions).toEqual(['Q2']);
      expect(parsed.findings).toHaveLength(1);
    });

    it('should handle resolving non-existent question gracefully', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });

      // Should not throw, just adds the finding
      await manager.resolveQuestion('test', 'Non-existent', 'Answer');

      const parsed = await manager.readParsed('test');
      expect(parsed.findings).toHaveLength(1);
    });
  });

  // =========================================================================
  // addResource
  // =========================================================================

  describe('addResource', () => {
    it('should add a resource link', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });

      await manager.addResource('test', { name: 'Anthropic', url: 'https://anthropic.com' });

      const content = await manager.read('test');
      expect(content).toContain('- [Anthropic](https://anthropic.com)');
    });

    it('should add multiple resources', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });

      await manager.addResource('test', { name: 'A', url: 'https://a.com' });
      await manager.addResource('test', { name: 'B', url: 'https://b.com' });

      const parsed = await manager.readParsed('test');
      expect(parsed.resources).toEqual([
        { name: 'A', url: 'https://a.com' },
        { name: 'B', url: 'https://b.com' },
      ]);
    });
  });

  // =========================================================================
  // setConclusion
  // =========================================================================

  describe('setConclusion', () => {
    it('should set conclusion content', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });

      await manager.setConclusion('test', 'Research complete. Key finding: X is better than Y.');

      const content = await manager.read('test');
      expect(content).toContain('Research complete. Key finding: X is better than Y.');
    });

    it('should overwrite existing conclusion', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });
      await manager.setConclusion('test', 'First conclusion');
      await manager.setConclusion('test', 'Updated conclusion');

      const parsed = await manager.readParsed('test');
      expect(parsed.conclusion).toContain('Updated conclusion');
      expect(parsed.conclusion).not.toContain('First conclusion');
    });
  });

  // =========================================================================
  // completeGoal / addGoal
  // =========================================================================

  describe('completeGoal', () => {
    it('should mark a goal as completed', async () => {
      await manager.initialize({
        topic: 'test',
        description: 'Test',
        goals: ['Goal A', 'Goal B'],
      });

      await manager.completeGoal('test', 'Goal A');

      const content = await manager.read('test');
      expect(content).toContain('- [x] Goal A');
      expect(content).toContain('- [ ] Goal B');
    });

    it('should not throw if goal text does not match exactly', async () => {
      await manager.initialize({
        topic: 'test',
        description: 'Test',
        goals: ['Goal A'],
      });

      // Should not throw, just silently skip
      await manager.completeGoal('test', 'Non-existent Goal');

      const parsed = await manager.readParsed('test');
      expect(parsed.completedGoals).toEqual([]);
    });
  });

  describe('addGoal', () => {
    it('should add a new goal', async () => {
      await manager.initialize({
        topic: 'test',
        description: 'Test',
        goals: ['Goal A'],
      });

      await manager.addGoal('test', 'Goal B');

      const parsed = await manager.readParsed('test');
      expect(parsed.goals).toEqual(['Goal A', 'Goal B']);
    });
  });

  // =========================================================================
  // archive
  // =========================================================================

  describe('archive', () => {
    it('should move research directory to archive with timestamp', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });

      const archivePath = await manager.archive('test');

      expect(archivePath).toContain('test_');
      expect(archivePath).toContain(path.join('_archived'));

      // Original should be gone
      expect(await manager.exists('test')).toBe(false);

      // Archive should exist
      const stat = await fs.stat(archivePath);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should throw for non-existent topic', async () => {
      await expect(manager.archive('nonexistent')).rejects.toThrow('not found');
    });

    it('should preserve RESEARCH.md content in archive', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });
      await manager.addFinding('test', { title: 'Important', content: 'Data' });

      const archivePath = await manager.archive('test');
      const archivedContent = await fs.readFile(
        path.join(archivePath, 'RESEARCH.md'),
        'utf-8'
      );

      expect(archivedContent).toContain('### Important');
    });
  });

  // =========================================================================
  // delete
  // =========================================================================

  describe('delete', () => {
    it('should remove the research directory', async () => {
      await manager.initialize({ topic: 'test', description: 'Test' });

      await manager.delete('test');

      expect(await manager.exists('test')).toBe(false);
    });

    it('should not throw for non-existent topic', async () => {
      // Should not throw due to { force: true }
      await manager.delete('nonexistent');
    });
  });

  // =========================================================================
  // Path helpers
  // =========================================================================

  describe('path helpers', () => {
    it('should return correct research directory path', () => {
      const dir = manager.getResearchDir('my-topic');
      expect(dir).toBe(path.join(tmpDir, 'research', 'my-topic'));
    });

    it('should return correct RESEARCH.md path', () => {
      const filePath = manager.getResearchFilePath('my-topic');
      expect(filePath).toBe(path.join(tmpDir, 'research', 'my-topic', 'RESEARCH.md'));
    });

    it('should return correct archive directory path', () => {
      const archiveDir = manager.getArchiveDir();
      expect(archiveDir).toBe(path.join(tmpDir, 'research', '_archived'));
    });
  });

  // =========================================================================
  // Integration: Full lifecycle
  // =========================================================================

  describe('full lifecycle', () => {
    it('should support complete research session lifecycle', async () => {
      // 1. Initialize
      await manager.initialize({
        topic: 'full-lifecycle-test',
        description: 'A complete research session',
        goals: ['Investigate A', 'Investigate B'],
      });

      // 2. Add findings
      await manager.addFinding('full-lifecycle-test', {
        title: 'Finding A',
        source: 'https://source-a.com',
        content: 'Discovered that A is true',
      });

      // 3. Add questions
      await manager.addQuestion('full-lifecycle-test', 'What about B?');

      // 4. Resolve a question
      await manager.resolveQuestion('full-lifecycle-test', 'What about B?', 'B is also true');

      // 5. Complete a goal
      await manager.completeGoal('full-lifecycle-test', 'Investigate A');

      // 6. Add resources
      await manager.addResource('full-lifecycle-test', {
        name: 'Source A',
        url: 'https://source-a.com',
      });

      // 7. Set conclusion
      await manager.setConclusion('full-lifecycle-test', 'Both A and B are confirmed.');

      // 8. Verify final state
      const parsed = await manager.readParsed('full-lifecycle-test');
      expect(parsed.completedGoals).toEqual(['Investigate A']);
      expect(parsed.pendingGoals).toEqual(['Investigate B']);
      expect(parsed.findings).toHaveLength(2); // Finding A + resolved question
      expect(parsed.questions).toEqual([]); // All resolved
      expect(parsed.resources).toHaveLength(1);
      expect(parsed.conclusion).toContain('Both A and B are confirmed');

      // 9. Archive
      const archivePath = await manager.archive('full-lifecycle-test');
      expect(await manager.exists('full-lifecycle-test')).toBe(false);

      // Verify archived content
      const archivedContent = await fs.readFile(
        path.join(archivePath, 'RESEARCH.md'),
        'utf-8'
      );
      expect(archivedContent).toContain('Both A and B are confirmed');
    });
  });
});
