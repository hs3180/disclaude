/**
 * ResearchStateFile unit tests.
 *
 * Issue #1710 - RESEARCH.md research state file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ResearchStateFile } from './research-state.js';

describe('ResearchStateFile', () => {
  let rsf: ResearchStateFile;
  let tempDir: string;

  beforeEach(async () => {
    rsf = new ResearchStateFile();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-state-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // ============================================================================
  // initialize()
  // ============================================================================

  describe('initialize()', () => {
    it('should create RESEARCH.md with topic and description', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      const result = await rsf.initialize(researchDir, {
        topic: 'AI Safety Research',
        description: 'Investigating alignment and safety approaches',
      });

      expect(result.created).toBe(true);
      expect(result.filePath).toBe(path.join(researchDir, 'RESEARCH.md'));

      const content = await fs.readFile(result.filePath, 'utf-8');
      expect(content).toContain('# AI Safety Research');
      expect(content).toContain('Investigating alignment and safety approaches');
      expect(content).toContain('## Research Goals');
      expect(content).toContain('## Collected Findings');
      expect(content).toContain('## Questions to Investigate');
      expect(content).toContain('## Research Conclusion');
      expect(content).toContain('## Related Resources');
    });

    it('should create RESEARCH.md with initial goals', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, {
        topic: 'Test Topic',
        goals: ['Survey literature', 'Identify risks', 'Write report'],
      });

      const content = await fs.readFile(
        path.join(researchDir, 'RESEARCH.md'), 'utf-8',
      );
      expect(content).toContain('- [ ] Survey literature');
      expect(content).toContain('- [ ] Identify risks');
      expect(content).toContain('- [ ] Write report');
    });

    it('should create RESEARCH.md with initial resources', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, {
        topic: 'Test Topic',
        resources: [
          { name: 'Anthropic Safety', url: 'https://anthropic.com/safety' },
        ],
      });

      const content = await fs.readFile(
        path.join(researchDir, 'RESEARCH.md'), 'utf-8',
      );
      expect(content).toContain('[Anthropic Safety](https://anthropic.com/safety)');
    });

    it('should not overwrite existing RESEARCH.md', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      const result1 = await rsf.initialize(researchDir, {
        topic: 'Original Topic',
      });
      expect(result1.created).toBe(true);

      const result2 = await rsf.initialize(researchDir, {
        topic: 'Different Topic',
      });
      expect(result2.created).toBe(false);

      const content = await fs.readFile(result2.filePath, 'utf-8');
      expect(content).toContain('# Original Topic');
      expect(content).not.toContain('# Different Topic');
    });

    it('should throw for relative path', async () => {
      await expect(
        rsf.initialize('relative/path', { topic: 'Test' }),
      ).rejects.toThrow('absolute path');
    });

    it('should throw for empty topic', async () => {
      await expect(
        rsf.initialize(tempDir, { topic: '' }),
      ).rejects.toThrow('topic is required');
    });

    it('should include LAST_UPDATED timestamp', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test Topic' });

      const content = await fs.readFile(
        path.join(researchDir, 'RESEARCH.md'), 'utf-8',
      );
      expect(content).toMatch(/<!-- LAST_UPDATED:\d{4}-\d{2}-\d{2}T/);
    });

    it('should create research directory if it does not exist', async () => {
      const researchDir = path.join(tempDir, 'nested', 'new', 'dir');
      await rsf.initialize(researchDir, { topic: 'Test' });

      const stat = await fs.stat(researchDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  // ============================================================================
  // read()
  // ============================================================================

  describe('read()', () => {
    it('should read and parse a valid RESEARCH.md', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, {
        topic: 'Test Research',
        description: 'Testing research state file',
        goals: ['Goal 1', 'Goal 2'],
      });

      const state = await rsf.read(researchDir);

      expect(state.topic).toBe('Test Research');
      expect(state.description).toBe('Testing research state file');
      expect(state.goals).toHaveLength(2);
      expect(state.goals[0].text).toBe('Goal 1');
      expect(state.goals[0].completed).toBe(false);
      expect(state.findings).toHaveLength(0);
      expect(state.questions).toHaveLength(0);
      expect(state.archived).toBe(false);
    });

    it('should throw if RESEARCH.md does not exist', async () => {
      await expect(rsf.read(tempDir)).rejects.toThrow('RESEARCH.md not found');
    });
  });

  // ============================================================================
  // parse()
  // ============================================================================

  describe('parse()', () => {
    it('should parse a complete RESEARCH.md with all sections', () => {
      const markdown = `# AI Safety Research

> Investigating alignment approaches

<!-- LAST_UPDATED:2026-04-01T12:00:00.000Z -->

## Research Goals

- [x] Survey literature
- [ ] Identify key risks
- [ ] Write report

## Collected Findings

### Alignment Tax
- **Source**: https://arxiv.org/abs/2307.15217
- **Recorded**: 2026-04-01T10:00:00.000Z

Additional cost of ensuring AI alignment

### Constitutional AI
- **Source**: https://arxiv.org/abs/2212.08073
- **Recorded**: 2026-04-01T11:00:00.000Z

Training AI systems using constitutional principles

## Questions to Investigate

- [ ] What is the current state of scalable oversight?
- [x] How do reward models generalize? — Reward models show distribution shift

## Research Conclusion

Research concluded. Key finding: alignment tax is manageable.

## Related Resources

- [Anthropic Safety](https://anthropic.com/safety)
- [AI Alignment Forum](https://alignmentforum.org)
`;

      const state = rsf.parse(markdown);

      expect(state.topic).toBe('AI Safety Research');
      expect(state.description).toBe('Investigating alignment approaches');
      expect(state.lastUpdatedAt).toBe('2026-04-01T12:00:00.000Z');

      // Goals
      expect(state.goals).toHaveLength(3);
      expect(state.goals[0]).toEqual({ text: 'Survey literature', completed: true });
      expect(state.goals[1]).toEqual({ text: 'Identify key risks', completed: false });

      // Findings
      expect(state.findings).toHaveLength(2);
      expect(state.findings[0].title).toBe('Alignment Tax');
      expect(state.findings[0].source).toBe('https://arxiv.org/abs/2307.15217');
      expect(state.findings[0].content).toBe('Additional cost of ensuring AI alignment');
      expect(state.findings[1].title).toBe('Constitutional AI');

      // Questions
      expect(state.questions).toHaveLength(2);
      expect(state.questions[0].text).toBe('What is the current state of scalable oversight?');
      expect(state.questions[0].resolved).toBe(false);
      expect(state.questions[1].text).toBe('How do reward models generalize?');
      expect(state.questions[1].resolved).toBe(true);
      expect(state.questions[1].resolution).toBe('Reward models show distribution shift');

      // Conclusion
      expect(state.conclusion).toContain('Research concluded');
      expect(state.archived).toBe(true);

      // Resources
      expect(state.resources).toHaveLength(2);
      expect(state.resources[0]).toEqual({
        name: 'Anthropic Safety',
        url: 'https://anthropic.com/safety',
      });
    });

    it('should parse a minimal RESEARCH.md with empty sections', () => {
      const markdown = `# Test Topic

> Description here

<!-- LAST_UPDATED:2026-04-01T00:00:00.000Z -->

## Research Goals

- [ ] Define research goals

## Collected Findings

_No findings yet_

## Questions to Investigate

_No questions yet_

## Research Conclusion

_Research not yet concluded_

## Related Resources

- _No resources yet_
`;

      const state = rsf.parse(markdown);

      expect(state.topic).toBe('Test Topic');
      expect(state.description).toBe('Description here');
      expect(state.goals).toHaveLength(1);
      expect(state.findings).toHaveLength(0);
      expect(state.questions).toHaveLength(0);
      expect(state.archived).toBe(false);
      expect(state.resources).toHaveLength(0);
    });
  });

  // ============================================================================
  // addFinding()
  // ============================================================================

  describe('addFinding()', () => {
    it('should add a finding to RESEARCH.md', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await rsf.addFinding(researchDir, {
        title: 'New Discovery',
        source: 'https://example.com/paper',
        content: 'This is an important finding about X.',
      });

      const state = await rsf.read(researchDir);
      expect(state.findings).toHaveLength(1);
      expect(state.findings[0].title).toBe('New Discovery');
      expect(state.findings[0].source).toBe('https://example.com/paper');
      expect(state.findings[0].content).toBe('This is an important finding about X.');
      expect(state.findings[0].recordedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('should add multiple findings in sequence', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await rsf.addFinding(researchDir, {
        title: 'Finding 1',
        content: 'Content 1',
      });
      await rsf.addFinding(researchDir, {
        title: 'Finding 2',
        content: 'Content 2',
      });

      const state = await rsf.read(researchDir);
      expect(state.findings).toHaveLength(2);
      expect(state.findings[0].title).toBe('Finding 1');
      expect(state.findings[1].title).toBe('Finding 2');
    });

    it('should update LAST_UPDATED timestamp', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      // Small delay to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));

      await rsf.addFinding(researchDir, {
        title: 'Finding',
        content: 'Content',
      });

      const state = await rsf.read(researchDir);
      expect(state.lastUpdatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('should throw if RESEARCH.md does not exist', async () => {
      await expect(
        rsf.addFinding(tempDir, { title: 'F', content: 'C' }),
      ).rejects.toThrow('RESEARCH.md not found');
    });
  });

  // ============================================================================
  // addQuestion()
  // ============================================================================

  describe('addQuestion()', () => {
    it('should add a question to RESEARCH.md', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await rsf.addQuestion(researchDir, 'What is the best approach for X?');

      const state = await rsf.read(researchDir);
      expect(state.questions).toHaveLength(1);
      expect(state.questions[0].text).toBe('What is the best approach for X?');
      expect(state.questions[0].resolved).toBe(false);
    });

    it('should add multiple questions', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await rsf.addQuestion(researchDir, 'Question 1?');
      await rsf.addQuestion(researchDir, 'Question 2?');

      const state = await rsf.read(researchDir);
      expect(state.questions).toHaveLength(2);
    });
  });

  // ============================================================================
  // resolveQuestion()
  // ============================================================================

  describe('resolveQuestion()', () => {
    it('should resolve a question and add resolution notes', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await rsf.addQuestion(researchDir, 'Open question?');
      await rsf.resolveQuestion(researchDir, 0, 'Resolved: The answer is 42.');

      const state = await rsf.read(researchDir);
      expect(state.questions[0].resolved).toBe(true);
      expect(state.questions[0].resolution).toBe('Resolved: The answer is 42.');
      expect(state.questions[0].resolvedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('should add related finding when resolving', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await rsf.addQuestion(researchDir, 'What did we find?');
      await rsf.resolveQuestion(researchDir, 0, 'Found the answer', {
        title: 'Related Finding',
        content: 'This finding answers the question.',
      });

      const state = await rsf.read(researchDir);
      expect(state.questions[0].resolved).toBe(true);
      expect(state.findings).toHaveLength(1);
      expect(state.findings[0].title).toBe('Related Finding');
    });

    it('should throw for out-of-bounds index', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await expect(
        rsf.resolveQuestion(researchDir, 5, 'Resolution'),
      ).rejects.toThrow('out of bounds');
    });

    it('should throw for negative index', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await expect(
        rsf.resolveQuestion(researchDir, -1, 'Resolution'),
      ).rejects.toThrow('out of bounds');
    });
  });

  // ============================================================================
  // toggleGoal()
  // ============================================================================

  describe('toggleGoal()', () => {
    it('should mark a goal as completed', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, {
        topic: 'Test',
        goals: ['Goal 1', 'Goal 2'],
      });

      await rsf.toggleGoal(researchDir, 0, true);

      const state = await rsf.read(researchDir);
      expect(state.goals[0].completed).toBe(true);
      expect(state.goals[1].completed).toBe(false);
    });

    it('should unmark a goal as completed', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, {
        topic: 'Test',
        goals: ['Goal 1'],
      });

      await rsf.toggleGoal(researchDir, 0, true);
      await rsf.toggleGoal(researchDir, 0, false);

      const state = await rsf.read(researchDir);
      expect(state.goals[0].completed).toBe(false);
    });

    it('should throw for out-of-bounds index', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await expect(
        rsf.toggleGoal(researchDir, 10, true),
      ).rejects.toThrow('out of bounds');
    });
  });

  // ============================================================================
  // addGoal()
  // ============================================================================

  describe('addGoal()', () => {
    it('should add a new goal', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, {
        topic: 'Test',
        goals: ['Existing Goal'],
      });

      await rsf.addGoal(researchDir, 'New goal');

      const state = await rsf.read(researchDir);
      expect(state.goals).toHaveLength(2);
      expect(state.goals[1].text).toBe('New goal');
      expect(state.goals[1].completed).toBe(false);
    });
  });

  // ============================================================================
  // conclude()
  // ============================================================================

  describe('conclude()', () => {
    it('should add conclusion and mark as archived', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await rsf.conclude(researchDir, 'Research complete. Key insight: X is true.');

      const state = await rsf.read(researchDir);
      expect(state.conclusion).toBe('Research complete. Key insight: X is true.');
      expect(state.archived).toBe(true);
    });

    it('should overwrite existing conclusion', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await rsf.conclude(researchDir, 'First conclusion');
      await rsf.conclude(researchDir, 'Updated conclusion');

      const state = await rsf.read(researchDir);
      expect(state.conclusion).toBe('Updated conclusion');
    });
  });

  // ============================================================================
  // addResource()
  // ============================================================================

  describe('addResource()', () => {
    it('should add a resource link', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await rsf.addResource(researchDir, {
        name: 'Example Paper',
        url: 'https://example.com/paper',
      });

      const state = await rsf.read(researchDir);
      expect(state.resources).toHaveLength(1);
      expect(state.resources[0]).toEqual({
        name: 'Example Paper',
        url: 'https://example.com/paper',
      });
    });

    it('should not add duplicate resources', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      await rsf.addResource(researchDir, {
        name: 'Example',
        url: 'https://example.com',
      });
      await rsf.addResource(researchDir, {
        name: 'Example (duplicate)',
        url: 'https://example.com',
      });

      const state = await rsf.read(researchDir);
      expect(state.resources).toHaveLength(1);
      expect(state.resources[0].name).toBe('Example');
    });
  });

  // ============================================================================
  // exists()
  // ============================================================================

  describe('exists()', () => {
    it('should return false when RESEARCH.md does not exist', async () => {
      expect(await rsf.exists(tempDir)).toBe(false);
    });

    it('should return true when RESEARCH.md exists', async () => {
      const researchDir = path.join(tempDir, 'test-topic');
      await rsf.initialize(researchDir, { topic: 'Test' });

      expect(await rsf.exists(researchDir)).toBe(true);
    });
  });

  // ============================================================================
  // Integration: Full Research Lifecycle
  // ============================================================================

  describe('full research lifecycle', () => {
    it('should support a complete research workflow', async () => {
      const researchDir = path.join(tempDir, 'full-lifecycle');

      // Phase 1: Initialize
      const initResult = await rsf.initialize(researchDir, {
        topic: 'Rust Async Runtime Comparison',
        description: 'Comparing tokio vs async-std performance',
        goals: ['Benchmark tokio', 'Benchmark async-std', 'Write comparison'],
        resources: [
          { name: 'Tokio Docs', url: 'https://tokio.rs' },
        ],
      });
      expect(initResult.created).toBe(true);

      // Phase 2: Add findings during research
      await rsf.addFinding(researchDir, {
        title: 'Tokio I/O Performance',
        source: 'https://tokio.rs/blog/2024-01-perf',
        content: 'Tokio shows 15% better throughput for I/O-bound workloads.',
      });

      await rsf.addFinding(researchDir, {
        title: 'async-std Simplicity',
        content: 'async-std has simpler API but slightly lower performance.',
      });

      // Add a question and resolve it
      await rsf.addQuestion(researchDir, 'Which runtime is better for CPU-bound tasks?');
      await rsf.resolveQuestion(researchDir, 0, 'Tokio is slightly better due to work-stealing scheduler', {
        title: 'CPU-bound Performance',
        content: 'Tokio\'s work-stealing scheduler provides better CPU utilization.',
      });

      // Mark goals as completed
      await rsf.toggleGoal(researchDir, 0, true);
      await rsf.toggleGoal(researchDir, 1, true);

      // Add more resources
      await rsf.addResource(researchDir, {
        name: 'async-std Docs',
        url: 'https://async.rs',
      });

      // Phase 3: Conclude
      await rsf.conclude(researchDir,
        'Tokio is recommended for production use due to better performance ' +
        'and broader ecosystem support. async-std is suitable for simpler projects.',
      );

      // Verify final state
      const state = await rsf.read(researchDir);

      expect(state.topic).toBe('Rust Async Runtime Comparison');
      expect(state.description).toBe('Comparing tokio vs async-std performance');
      expect(state.goals).toHaveLength(3);
      expect(state.goals[0].completed).toBe(true);
      expect(state.goals[1].completed).toBe(true);
      expect(state.goals[2].completed).toBe(false);
      expect(state.findings).toHaveLength(3); // 2 direct + 1 from resolveQuestion
      expect(state.questions).toHaveLength(1);
      expect(state.questions[0].resolved).toBe(true);
      expect(state.resources).toHaveLength(2);
      expect(state.archived).toBe(true);
      expect(state.conclusion).toContain('Tokio is recommended');

      // Verify the file is valid markdown
      const content = await fs.readFile(
        path.join(researchDir, 'RESEARCH.md'), 'utf-8',
      );
      expect(content).toContain('# Rust Async Runtime Comparison');
      expect(content).toContain('## Collected Findings');
      expect(content).toContain('### Tokio I/O Performance');
      expect(content).toContain('### CPU-bound Performance');
    });
  });

  // ============================================================================
  // Markdown Round-trip
  // ============================================================================

  describe('markdown round-trip', () => {
    it('should preserve structure after multiple updates', async () => {
      const researchDir = path.join(tempDir, 'round-trip');
      await rsf.initialize(researchDir, {
        topic: 'Round Trip Test',
        description: 'Testing round-trip preservation',
        goals: ['Goal A', 'Goal B'],
      });

      // Multiple updates
      await rsf.addFinding(researchDir, { title: 'F1', content: 'C1' });
      await rsf.addQuestion(researchDir, 'Q1?');
      await rsf.addResource(researchDir, { name: 'R1', url: 'https://r1.com' });
      await rsf.toggleGoal(researchDir, 0, true);
      await rsf.addFinding(researchDir, { title: 'F2', content: 'C2' });
      await rsf.addQuestion(researchDir, 'Q2?');
      await rsf.resolveQuestion(researchDir, 0, 'Answer to Q1');

      // Read and verify all data is preserved
      const state = await rsf.read(researchDir);
      expect(state.topic).toBe('Round Trip Test');
      expect(state.goals).toHaveLength(2);
      expect(state.goals[0].completed).toBe(true);
      expect(state.findings).toHaveLength(2);
      expect(state.questions).toHaveLength(2);
      expect(state.questions[0].resolved).toBe(true);
      expect(state.resources).toHaveLength(1);

      // Verify section headings are still present
      const content = await fs.readFile(
        path.join(researchDir, 'RESEARCH.md'), 'utf-8',
      );
      expect(content).toContain('## Research Goals');
      expect(content).toContain('## Collected Findings');
      expect(content).toContain('## Questions to Investigate');
      expect(content).toContain('## Research Conclusion');
      expect(content).toContain('## Related Resources');
      expect(content).toContain('<!-- LAST_UPDATED:');
    });
  });
});
