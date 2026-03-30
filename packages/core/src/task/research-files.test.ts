/**
 * Unit tests for ResearchFileManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  ResearchFileManager,
  parseResearchMd,
} from './research-files.js';

describe('ResearchFileManager', () => {
  let manager: ResearchFileManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-test-'));
    manager = new ResearchFileManager({ workspaceDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should use default research subdirectory', () => {
      const dir = manager.getResearchDir('test-topic');
      expect(dir).toContain(path.join('research', 'test-topic'));
    });

    it('should use custom subdirectory when provided', () => {
      const customManager = new ResearchFileManager({
        workspaceDir: tempDir,
        subdirectory: 'custom-research',
      });
      const dir = customManager.getResearchDir('test-topic');
      expect(dir).toContain(path.join('custom-research', 'test-topic'));
    });
  });

  describe('getResearchDir', () => {
    it('should sanitize topic for valid directory name', () => {
      const dir = manager.getResearchDir('My Topic!');
      expect(dir).not.toContain('!');
      expect(dir).toContain('My_Topic_');
    });

    it('should support Chinese characters in topic', () => {
      const dir = manager.getResearchDir('研究主题');
      expect(dir).toContain('研究主题');
    });

    it('should limit topic length to 100 characters', () => {
      const longTopic = 'a'.repeat(200);
      const dir = manager.getResearchDir(longTopic);
      const dirName = path.basename(dir);
      expect(dirName.length).toBeLessThanOrEqual(100);
    });
  });

  // ─── Phase 1: File Initialization ────────────────────────────────

  describe('initializeResearch (Phase 1)', () => {
    it('should create research directory and RESEARCH.md', async () => {
      await manager.initializeResearch('test-topic', 'Test description', ['Goal 1', 'Goal 2']);

      const exists = await manager.researchExists('test-topic');
      expect(exists).toBe(true);
    });

    it('should create RESEARCH.md with correct template content', async () => {
      await manager.initializeResearch('test-topic', 'A research about AI', ['Understand basics', 'Build prototype']);

      const raw = await manager.readRawMarkdown('test-topic');
      expect(raw).toContain('# test-topic');
      expect(raw).toContain('> A research about AI');
      expect(raw).toContain('## 研究目标');
      expect(raw).toContain('- [ ] Understand basics');
      expect(raw).toContain('- [ ] Build prototype');
      expect(raw).toContain('## 已收集的信息');
      expect(raw).toContain('（暂无发现）');
      expect(raw).toContain('## 待调查的问题');
      expect(raw).toContain('（暂无待调查问题）');
      expect(raw).toContain('## 研究结论');
      expect(raw).toContain('（研究完成后填写）');
    });

    it('should return the initial ResearchState', async () => {
      const state = await manager.initializeResearch('test-topic', 'Description', ['Obj 1']);

      expect(state.topic).toBe('test-topic');
      expect(state.description).toBe('Description');
      expect(state.objectives).toEqual(['Obj 1']);
      expect(state.findings).toEqual([]);
      expect(state.pendingQuestions).toEqual([]);
      expect(state.resources).toEqual([]);
      expect(state.createdAt).toBeDefined();
      expect(state.updatedAt).toBeDefined();
    });

    it('should not overwrite existing RESEARCH.md', async () => {
      const first = await manager.initializeResearch('test-topic', 'First description');
      const second = await manager.initializeResearch('test-topic', 'Second description');

      expect(second.description).toBe('First description');
      expect(second.createdAt).toBe(first.createdAt);
    });

    it('should work with empty objectives', async () => {
      const state = await manager.initializeResearch('test-topic', 'Description');
      expect(state.objectives).toEqual([]);
    });
  });

  // ─── Phase 2: Auto-Update Operations ─────────────────────────────

  describe('readResearchState (Phase 2)', () => {
    it('should return null for non-existent research', async () => {
      const state = await manager.readResearchState('non-existent');
      expect(state).toBeNull();
    });

    it('should return parsed state for existing research', async () => {
      await manager.initializeResearch('test-topic', 'Description', ['Goal 1']);
      const state = await manager.readResearchState('test-topic');

      expect(state).not.toBeNull();
      expect(state!.topic).toBe('test-topic');
      expect(state!.objectives).toEqual(['Goal 1']);
    });
  });

  describe('addFinding', () => {
    it('should add a finding to the research state', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      await manager.addFinding('test-topic', {
        title: 'Finding 1',
        source: 'Official docs',
        content: 'Key insight about X',
      });

      const state = await manager.readResearchState('test-topic');
      expect(state!.findings).toHaveLength(1);
      expect(state!.findings[0].title).toBe('Finding 1');
      expect(state!.findings[0].source).toBe('Official docs');
      expect(state!.findings[0].content).toBe('Key insight about X');
      expect(state!.findings[0].discoveredAt).toBeDefined();
    });

    it('should throw for non-existent research', async () => {
      await expect(
        manager.addFinding('non-existent', {
          title: 'Finding',
          source: 'Source',
          content: 'Content',
        }),
      ).rejects.toThrow('Research session not found');
    });

    it('should update the updatedAt timestamp', async () => {
      const initial = await manager.initializeResearch('test-topic', 'Description');
      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));
      await manager.addFinding('test-topic', {
        title: 'Finding',
        source: 'Source',
        content: 'Content',
      });

      const state = await manager.readResearchState('test-topic');
      expect(state!.updatedAt).not.toBe(initial.updatedAt);
    });
  });

  describe('addFindings', () => {
    it('should add multiple findings at once', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      await manager.addFindings('test-topic', [
        { title: 'Finding 1', source: 'Source 1', content: 'Content 1' },
        { title: 'Finding 2', source: 'Source 2', content: 'Content 2' },
      ]);

      const state = await manager.readResearchState('test-topic');
      expect(state!.findings).toHaveLength(2);
    });
  });

  describe('addPendingQuestion', () => {
    it('should add a question to pending list', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      await manager.addPendingQuestion('test-topic', 'How does X work?');

      const state = await manager.readResearchState('test-topic');
      expect(state!.pendingQuestions).toEqual(['How does X work?']);
    });

    it('should not add duplicate questions', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      await manager.addPendingQuestion('test-topic', 'Same question?');
      await manager.addPendingQuestion('test-topic', 'Same question?');

      const state = await manager.readResearchState('test-topic');
      expect(state!.pendingQuestions).toHaveLength(1);
    });
  });

  describe('resolveQuestion', () => {
    it('should move question to findings', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      await manager.addPendingQuestion('test-topic', 'How does X work?');
      await manager.resolveQuestion('test-topic', 'How does X work?', {
        title: 'Answer to X',
        source: 'Documentation',
        content: 'X works by doing Y',
      });

      const state = await manager.readResearchState('test-topic');
      expect(state!.pendingQuestions).toHaveLength(0);
      expect(state!.findings).toHaveLength(1);
      expect(state!.findings[0].title).toBe('Answer to X');
    });

    it('should handle question not in pending list gracefully', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      // Resolving a question that was never added should still add the finding
      await manager.resolveQuestion('test-topic', 'Unknown question?', {
        title: 'Finding',
        source: 'Source',
        content: 'Content',
      });

      const state = await manager.readResearchState('test-topic');
      expect(state!.findings).toHaveLength(1);
    });
  });

  describe('addResource', () => {
    it('should add a resource link', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      await manager.addResource('test-topic', {
        name: 'Official Docs',
        url: 'https://example.com/docs',
      });

      const state = await manager.readResearchState('test-topic');
      expect(state!.resources).toHaveLength(1);
      expect(state!.resources[0].name).toBe('Official Docs');
    });

    it('should not add duplicate resources by URL', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      await manager.addResource('test-topic', { name: 'Docs', url: 'https://example.com' });
      await manager.addResource('test-topic', { name: 'Docs v2', url: 'https://example.com' });

      const state = await manager.readResearchState('test-topic');
      expect(state!.resources).toHaveLength(1);
      expect(state!.resources[0].name).toBe('Docs'); // First one wins
    });
  });

  describe('completeObjective', () => {
    it('should mark an objective as completed', async () => {
      await manager.initializeResearch('test-topic', 'Description', ['Goal 1', 'Goal 2']);
      await manager.completeObjective('test-topic', 'Goal 1');

      const state = await manager.readResearchState('test-topic');
      expect(state!.objectives[0]).toContain('[completed]');
      expect(state!.objectives[0]).toContain('Goal 1');
      expect(state!.objectives[1]).toBe('Goal 2');
    });

    it('should return null for non-existent objective', async () => {
      await manager.initializeResearch('test-topic', 'Description', ['Goal 1']);
      const result = await manager.completeObjective('test-topic', 'Non-existent goal');
      expect(result).toBeNull();
    });
  });

  describe('readRawMarkdown', () => {
    it('should return raw markdown content', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      const raw = await manager.readRawMarkdown('test-topic');
      expect(raw).toContain('# test-topic');
    });

    it('should return null for non-existent research', async () => {
      const raw = await manager.readRawMarkdown('non-existent');
      expect(raw).toBeNull();
    });
  });

  // ─── Phase 3: Conclusion & Archive ───────────────────────────────

  describe('finalizeResearch (Phase 3)', () => {
    it('should write conclusion to research state', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      await manager.finalizeResearch('test-topic', 'Research concluded that X is better than Y.');

      const state = await manager.readResearchState('test-topic');
      expect(state!.conclusion).toBe('Research concluded that X is better than Y.');
    });

    it('should reflect conclusion in raw markdown', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      await manager.finalizeResearch('test-topic', 'Final conclusion here.');

      const raw = await manager.readRawMarkdown('test-topic');
      expect(raw).toContain('Final conclusion here.');
      expect(raw).not.toContain('（研究完成后填写）');
    });
  });

  describe('archiveResearch', () => {
    it('should move research to archive directory', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      const archivePath = await manager.archiveResearch('test-topic');

      expect(archivePath).toContain('_archived');
      expect(archivePath).toContain('test-topic');

      // Original should no longer exist
      const exists = await manager.researchExists('test-topic');
      expect(exists).toBe(false);
    });

    it('should use custom archive directory when provided', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      const archivePath = await manager.archiveResearch('test-topic', 'custom-archive');

      expect(archivePath).toContain('custom-archive');
      expect(archivePath).not.toContain('_archived');
    });

    it('should include timestamp in archive name', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      const archivePath = await manager.archiveResearch('test-topic');
      const dirName = path.basename(archivePath);
      // Should contain the topic and a timestamp-like suffix
      expect(dirName).toContain('test-topic_');
    });
  });

  // ─── Utility Methods ─────────────────────────────────────────────

  describe('researchExists', () => {
    it('should return false for non-existent research', async () => {
      expect(await manager.researchExists('non-existent')).toBe(false);
    });

    it('should return true after initialization', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      expect(await manager.researchExists('test-topic')).toBe(true);
    });
  });

  describe('listResearchTopics', () => {
    it('should return empty array when no research exists', async () => {
      const topics = await manager.listResearchTopics();
      expect(topics).toEqual([]);
    });

    it('should list all research topics', async () => {
      await manager.initializeResearch('topic-a', 'Description A');
      await manager.initializeResearch('topic-b', 'Description B');

      const topics = await manager.listResearchTopics();
      expect(topics).toContain('topic-a');
      expect(topics).toContain('topic-b');
    });

    it('should exclude archived directories', async () => {
      await manager.initializeResearch('active-topic', 'Description');
      await manager.archiveResearch('active-topic');

      const topics = await manager.listResearchTopics();
      expect(topics).not.toContain('active-topic');
    });
  });

  describe('getResearchStats', () => {
    it('should return null for non-existent research', async () => {
      const stats = await manager.getResearchStats('non-existent');
      expect(stats).toBeNull();
    });

    it('should return correct statistics', async () => {
      await manager.initializeResearch('test-topic', 'Description', ['Obj 1', 'Obj 2']);
      await manager.addFinding('test-topic', { title: 'F1', source: 'S1', content: 'C1' });
      await manager.addFinding('test-topic', { title: 'F2', source: 'S2', content: 'C2' });
      await manager.addPendingQuestion('test-topic', 'Question 1');
      await manager.addResource('test-topic', { name: 'R1', url: 'https://example.com' });

      const stats = await manager.getResearchStats('test-topic');
      expect(stats).toEqual({
        totalFindings: 2,
        pendingQuestions: 1,
        totalObjectives: 2,
        hasConclusion: false,
        totalResources: 1,
      });
    });

    it('should show hasConclusion as true after finalization', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      await manager.finalizeResearch('test-topic', 'Conclusion here');

      const stats = await manager.getResearchStats('test-topic');
      expect(stats!.hasConclusion).toBe(true);
    });
  });

  describe('deleteResearch', () => {
    it('should remove research directory', async () => {
      await manager.initializeResearch('test-topic', 'Description');
      await manager.deleteResearch('test-topic');

      expect(await manager.researchExists('test-topic')).toBe(false);
    });
  });

  // ─── Integration: Full Lifecycle ─────────────────────────────────

  describe('full research lifecycle', () => {
    it('should support complete research workflow', async () => {
      // Phase 1: Initialize
      const state = await manager.initializeResearch(
        'react-performance',
        'Research React rendering performance optimization techniques',
        ['Understand rendering pipeline', 'Identify bottlenecks', 'Propose solutions'],
      );
      expect(state.objectives).toHaveLength(3);

      // Phase 2: Add findings and questions
      await manager.addFinding('react-performance', {
        title: 'React DevTools Profiler',
        source: 'Official React Docs',
        content: 'React DevTools provides a Profiler component for measuring render performance',
      });
      await manager.addPendingQuestion('react-performance', 'How does concurrent mode affect rendering?');
      await manager.addResource('react-performance', {
        name: 'React Documentation',
        url: 'https://react.dev',
      });

      // Resolve a question
      await manager.resolveQuestion(
        'react-performance',
        'How does concurrent mode affect rendering?',
        {
          title: 'Concurrent Mode Rendering',
          source: 'React RFC',
          content: 'Concurrent mode allows React to interrupt rendering for higher-priority updates',
        },
      );

      // Complete an objective
      await manager.completeObjective('react-performance', 'Understand rendering pipeline');

      // Phase 3: Finalize
      await manager.finalizeResearch('react-performance', 'React offers several optimization techniques including memoization, code splitting, and concurrent features.');

      // Verify final state
      const finalState = await manager.readResearchState('react-performance');
      expect(finalState!.findings).toHaveLength(2);
      expect(finalState!.pendingQuestions).toHaveLength(0);
      expect(finalState!.conclusion).toBeDefined();
      expect(finalState!.resources).toHaveLength(1);

      // Archive
      const archivePath = await manager.archiveResearch('react-performance');
      expect(archivePath).toContain('react-performance');
      expect(await manager.researchExists('react-performance')).toBe(false);
    });
  });
});

describe('parseResearchMd', () => {
  it('should parse a valid RESEARCH.md template', () => {
    const content = `# AI Research

> Study artificial intelligence trends

## 研究目标

- [ ] Understand basics
- [ ] Build prototype

## 已收集的信息

### Finding One

- **来源**: Official docs
- **关键内容**: AI is growing fast
- **发现时间**: 2026-01-01T00:00:00.000Z

## 待调查的问题

- [ ] How to apply?

## 研究结论

（研究完成后填写）

## 相关资源

- [AI Paper](https://arxiv.org)

---

*创建时间: 2026-01-01T00:00:00.000Z*
*最后更新: 2026-01-02T00:00:00.000Z*
`;

    const state = parseResearchMd(content);
    expect(state).not.toBeNull();
    expect(state!.topic).toBe('AI Research');
    expect(state!.description).toBe('Study artificial intelligence trends');
    expect(state!.objectives).toEqual(['Understand basics', 'Build prototype']);
    expect(state!.findings).toHaveLength(1);
    expect(state!.findings[0].title).toBe('Finding One');
    expect(state!.findings[0].source).toBe('Official docs');
    expect(state!.findings[0].content).toBe('AI is growing fast');
    expect(state!.pendingQuestions).toEqual(['How to apply?']);
    expect(state!.resources).toEqual([{ name: 'AI Paper', url: 'https://arxiv.org' }]);
    expect(state!.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state!.updatedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('should return null for invalid content', () => {
    expect(parseResearchMd('')).toBeNull();
  });

  it('should handle content with conclusion', () => {
    const content = `# Topic

> Description

## 研究目标

- [ ] Goal

## 已收集的信息

（暂无发现）

## 待调查的问题

（暂无待调查问题）

## 研究结论

The research found that X is true.
Multiple lines of conclusion.

## 相关资源

（暂无相关资源）

---

*创建时间: 2026-01-01T00:00:00.000Z*
*最后更新: 2026-01-01T00:00:00.000Z*
`;

    const state = parseResearchMd(content);
    expect(state).not.toBeNull();
    expect(state!.conclusion).toContain('The research found that X is true.');
    expect(state!.conclusion).toContain('Multiple lines of conclusion.');
  });
});
