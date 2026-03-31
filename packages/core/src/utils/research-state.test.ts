/**
 * Tests for research state file management (RESEARCH.md).
 *
 * Issue #1710: 实现 RESEARCH.md 研究状态文件
 *
 * Tests cover:
 * - sanitizeTopicName
 * - renderResearchMarkdown (round-trip with parse)
 * - parseResearchMarkdown (including edge cases)
 * - initResearchState / initResearchTopic (file creation)
 * - loadResearchState (sidecar + fallback)
 * - updateResearchState (all update operations)
 * - Convenience wrappers (addFinding, addQuestion, etc.)
 * - cleanupResearchState
 *
 * All I/O tests use a temp directory and clean up after themselves.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  sanitizeTopicName,
  renderResearchMarkdown,
  parseResearchMarkdown,
  initResearchState,
  initResearchTopic,
  loadResearchState,
  researchStateExists,
  updateResearchState,
  addFinding,
  addQuestion,
  resolveQuestion,
  setConclusion,
  cleanupResearchState,
  type ResearchState,
} from './research-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-state-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Create a minimal state for testing. */
function minimalState(overrides?: Partial<ResearchState>): ResearchState {
  return {
    topic: 'Test Topic',
    description: 'Test description',
    goals: ['Goal 1', 'Goal 2'],
    findings: [],
    questions: [],
    conclusion: null,
    resources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ===========================================================================
// sanitizeTopicName
// ===========================================================================

describe('sanitizeTopicName', () => {
  it('should lowercase and replace spaces with hyphens', () => {
    expect(sanitizeTopicName('Machine Learning')).toBe('machine-learning');
  });

  it('should handle Chinese characters', () => {
    expect(sanitizeTopicName('机器学习研究')).toBe('机器学习研究');
  });

  it('should handle mixed Chinese and English', () => {
    expect(sanitizeTopicName('AI Agent 研究')).toBe('ai-agent-研究');
  });

  it('should collapse multiple special characters', () => {
    expect(sanitizeTopicName('Hello!!! World???')).toBe('hello-world');
  });

  it('should trim leading/trailing hyphens', () => {
    expect(sanitizeTopicName('---test---')).toBe('test');
  });

  it('should truncate to 80 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeTopicName(long)).toHaveLength(80);
  });

  it('should return "untitled" for empty string', () => {
    expect(sanitizeTopicName('')).toBe('untitled');
  });

  it('should return "untitled" for only special characters', () => {
    expect(sanitizeTopicName('!!! ???')).toBe('untitled');
  });
});

// ===========================================================================
// renderResearchMarkdown
// ===========================================================================

describe('renderResearchMarkdown', () => {
  it('should render a minimal state', () => {
    const state = minimalState();
    const md = renderResearchMarkdown(state);

    expect(md).toContain('# Test Topic');
    expect(md).toContain('> Test description');
    expect(md).toContain('## 研究目标');
    expect(md).toContain('- [ ] Goal 1');
    expect(md).toContain('- [ ] Goal 2');
    expect(md).toContain('## 已收集的信息');
    expect(md).toContain('暂无发现');
    expect(md).toContain('## 待调查的问题');
    expect(md).toContain('暂无问题');
    expect(md).toContain('## 研究结论');
    expect(md).toContain('（研究完成后填写）');
    expect(md).toContain('## 相关资源');
    expect(md).toContain('暂无资源');
  });

  it('should render findings with sources', () => {
    const state = minimalState({
      findings: [
        {
          id: 'f1',
          title: 'Finding 1',
          content: 'Detailed content here',
          source: 'https://example.com',
          recordedAt: '2026-01-15T10:00:00.000Z',
        },
      ],
    });
    const md = renderResearchMarkdown(state);

    expect(md).toContain('### 发现 1: Finding 1');
    expect(md).toContain('Detailed content here');
    expect(md).toContain('- 来源：https://example.com');
    expect(md).toContain('- 记录时间：2026-01-15T10:00:00.000Z');
  });

  it('should render pending and resolved questions', () => {
    const state = minimalState({
      questions: [
        { id: 'q1', question: 'Open question', resolved: false },
        { id: 'q2', question: 'Closed question', resolved: true, resolvedAt: '2026-01-20T00:00:00.000Z', resolvedById: 'f1' },
      ],
    });
    const md = renderResearchMarkdown(state);

    expect(md).toContain('- [ ] Open question');
    expect(md).toContain('#### 已解决');
    expect(md).toContain('- [x] Closed question');
    expect(md).toContain('关联发现：f1');
  });

  it('should render conclusion when present', () => {
    const state = minimalState({
      conclusion: 'The answer is 42.',
    });
    const md = renderResearchMarkdown(state);

    expect(md).toContain('The answer is 42.');
    expect(md).not.toContain('（研究完成后填写）');
  });

  it('should render resources as links', () => {
    const state = minimalState({
      resources: [{ title: 'MDN', url: 'https://developer.mozilla.org' }],
    });
    const md = renderResearchMarkdown(state);

    expect(md).toContain('- [MDN](https://developer.mozilla.org)');
  });

  it('should handle empty description gracefully', () => {
    const state = minimalState({ description: '' });
    const md = renderResearchMarkdown(state);

    expect(md).toContain('# Test Topic');
    expect(md).not.toContain('> ');
  });

  it('should handle empty goals', () => {
    const state = minimalState({ goals: [] });
    const md = renderResearchMarkdown(state);

    expect(md).toContain('待补充');
  });

  it('should handle findings from resolved questions', () => {
    const state = minimalState({
      findings: [
        {
          id: 'f1',
          title: 'Answer',
          content: 'Resolved finding',
          resolvedFrom: 'q1',
        },
      ],
    });
    const md = renderResearchMarkdown(state);

    expect(md).toContain('- 来源问题：q1');
  });
});

// ===========================================================================
// parseResearchMarkdown
// ===========================================================================

describe('parseResearchMarkdown', () => {
  it('should parse a basic rendered markdown back to state', () => {
    const original = minimalState();
    const md = renderResearchMarkdown(original);
    const parsed = parseResearchMarkdown(md);

    expect(parsed.topic).toBe('Test Topic');
    expect(parsed.description).toBe('Test description');
    expect(parsed.goals).toEqual(['Goal 1', 'Goal 2']);
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.questions).toHaveLength(0);
    expect(parsed.conclusion).toBeNull();
    expect(parsed.resources).toHaveLength(0);
  });

  it('should preserve findings through round-trip', () => {
    const original = minimalState({
      findings: [
        {
          id: 'f1',
          title: 'Discovery',
          content: 'Important finding\nWith multiple lines',
          source: 'https://example.com',
          recordedAt: '2026-01-15T10:00:00.000Z',
        },
      ],
    });
    const md = renderResearchMarkdown(original);
    const parsed = parseResearchMarkdown(md);

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].title).toBe('Discovery');
    expect(parsed.findings[0].content).toContain('Important finding');
    expect(parsed.findings[0].content).toContain('With multiple lines');
    expect(parsed.findings[0].source).toBe('https://example.com');
  });

  it('should preserve questions through round-trip', () => {
    const original = minimalState({
      questions: [
        { id: 'q1', question: 'What is X?', resolved: false },
        { id: 'q2', question: 'What is Y?', resolved: true, resolvedAt: '2026-01-20T00:00:00.000Z', resolvedById: 'f1' },
      ],
    });
    const md = renderResearchMarkdown(original);
    const parsed = parseResearchMarkdown(md);

    expect(parsed.questions).toHaveLength(2);
    const pending = parsed.questions.find(q => !q.resolved);
    const resolved = parsed.questions.find(q => q.resolved);
    expect(pending?.question).toBe('What is X?');
    expect(resolved?.question).toBe('What is Y?');
  });

  it('should preserve conclusion through round-trip', () => {
    const original = minimalState({ conclusion: 'Final answer.' });
    const md = renderResearchMarkdown(original);
    const parsed = parseResearchMarkdown(md);

    expect(parsed.conclusion).toContain('Final answer.');
  });

  it('should preserve resources through round-trip', () => {
    const original = minimalState({
      resources: [{ title: 'Docs', url: 'https://docs.example.com' }],
    });
    const md = renderResearchMarkdown(original);
    const parsed = parseResearchMarkdown(md);

    expect(parsed.resources).toHaveLength(1);
    expect(parsed.resources[0].title).toBe('Docs');
    expect(parsed.resources[0].url).toBe('https://docs.example.com');
  });

  it('should use existingState createdAt if provided', () => {
    const original = minimalState({ createdAt: '2025-01-01T00:00:00.000Z' });
    const md = renderResearchMarkdown(original);
    const parsed = parseResearchMarkdown(md, { createdAt: '2025-01-01T00:00:00.000Z' });

    expect(parsed.createdAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('should handle multiple findings with correct numbering', () => {
    const original = minimalState({
      findings: [
        { id: 'f1', title: 'First', content: 'Content 1' },
        { id: 'f2', title: 'Second', content: 'Content 2' },
        { id: 'f3', title: 'Third', content: 'Content 3' },
      ],
    });
    const md = renderResearchMarkdown(original);
    const parsed = parseResearchMarkdown(md);

    expect(parsed.findings).toHaveLength(3);
    expect(parsed.findings[0].title).toBe('First');
    expect(parsed.findings[1].title).toBe('Second');
    expect(parsed.findings[2].title).toBe('Third');
  });

  it('should handle empty markdown gracefully', () => {
    const parsed = parseResearchMarkdown('');

    expect(parsed.topic).toBe('未命名研究');
    expect(parsed.goals).toHaveLength(0);
    expect(parsed.findings).toHaveLength(0);
  });
});

// ===========================================================================
// initResearchState
// ===========================================================================

describe('initResearchState', () => {
  it('should create directory and RESEARCH.md', async () => {
    const dirPath = path.join(tmpDir, 'new-research');
    const result = await initResearchState(dirPath, 'AI Safety Research', {
      description: 'Exploring AI safety',
      goals: ['Understand alignment', 'Review literature'],
    });

    expect(result.dirPath).toBe(dirPath);
    expect(result.filePath).toBe(path.join(dirPath, 'RESEARCH.md'));
    expect(result.state.topic).toBe('AI Safety Research');
    expect(result.state.description).toBe('Exploring AI safety');
    expect(result.state.goals).toEqual(['Understand alignment', 'Review literature']);

    // Verify files exist
    const stat = await fs.stat(result.filePath);
    expect(stat.isFile()).toBe(true);

    const sidecarStat = await fs.stat(path.join(dirPath, '.research-state.json'));
    expect(sidecarStat.isFile()).toBe(true);
  });

  it('should use custom file name', async () => {
    const dirPath = path.join(tmpDir, 'custom-name');
    const result = await initResearchState(dirPath, 'Test', {
      fileName: 'CUSTOM.md',
    });

    expect(result.filePath).toBe(path.join(dirPath, 'CUSTOM.md'));
    const content = await fs.readFile(result.filePath, 'utf-8');
    expect(content).toContain('# Test');
  });

  it('should preserve existing RESEARCH.md content', async () => {
    const dirPath = path.join(tmpDir, 'preserve');
    await fs.mkdir(dirPath, { recursive: true });

    // Write an existing RESEARCH.md
    await fs.writeFile(
      path.join(dirPath, 'RESEARCH.md'),
      '# Old Topic\n\n> Old description\n\n## 研究目标\n\n- [ ] Old goal\n',
      'utf-8',
    );

    const result = await initResearchState(dirPath, 'New Topic');
    // Should have parsed the old content
    expect(result.state.topic).toBe('Old Topic');
    expect(result.state.goals).toContain('Old goal');
  });

  it('should write valid sidecar JSON', async () => {
    const dirPath = path.join(tmpDir, 'sidecar');
    await initResearchState(dirPath, 'Test');

    const raw = await fs.readFile(
      path.join(dirPath, '.research-state.json'),
      'utf-8',
    );
    const sidecar = JSON.parse(raw) as ResearchState;

    expect(sidecar.topic).toBe('Test');
    expect(sidecar.createdAt).toBeDefined();
    expect(sidecar.updatedAt).toBeDefined();
  });
});

// ===========================================================================
// initResearchTopic
// ===========================================================================

describe('initResearchTopic', () => {
  it('should create topic-named subdirectory', async () => {
    const result = await initResearchTopic(tmpDir, 'Machine Learning Basics');

    expect(result.dirPath).toContain('machine-learning-basics');
    expect(result.state.topic).toBe('Machine Learning Basics');

    // Directory should exist
    const stat = await fs.stat(result.dirPath);
    expect(stat.isDirectory()).toBe(true);
  });
});

// ===========================================================================
// loadResearchState
// ===========================================================================

describe('loadResearchState', () => {
  it('should load from sidecar if available', async () => {
    const dirPath = path.join(tmpDir, 'load-test');
    const initState = await initResearchState(dirPath, 'Test');

    // Modify state and write new sidecar
    const modified = { ...initState.state, conclusion: 'Done!' };
    await fs.writeFile(
      path.join(dirPath, '.research-state.json'),
      JSON.stringify(modified),
      'utf-8',
    );

    const loaded = await loadResearchState(dirPath);
    expect(loaded?.conclusion).toBe('Done!');
  });

  it('should fall back to parsing markdown', async () => {
    const dirPath = path.join(tmpDir, 'fallback-test');
    await fs.mkdir(dirPath, { recursive: true });

    // Write only RESEARCH.md, no sidecar
    await fs.writeFile(
      path.join(dirPath, 'RESEARCH.md'),
      '# My Research\n\n> Testing fallback\n\n## 研究目标\n\n- [ ] Goal A\n',
      'utf-8',
    );

    const loaded = await loadResearchState(dirPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.topic).toBe('My Research');
    expect(loaded!.description).toBe('Testing fallback');
  });

  it('should return null for non-existent directory', async () => {
    const loaded = await loadResearchState('/non/existent/path');
    expect(loaded).toBeNull();
  });
});

// ===========================================================================
// researchStateExists
// ===========================================================================

describe('researchStateExists', () => {
  it('should return true when RESEARCH.md exists', async () => {
    const dirPath = path.join(tmpDir, 'exists-test');
    await initResearchState(dirPath, 'Test');

    expect(await researchStateExists(dirPath)).toBe(true);
  });

  it('should return false when RESEARCH.md does not exist', async () => {
    const dirPath = path.join(tmpDir, 'no-exist');
    await fs.mkdir(dirPath, { recursive: true });

    expect(await researchStateExists(dirPath)).toBe(false);
  });
});

// ===========================================================================
// updateResearchState
// ===========================================================================

describe('updateResearchState', () => {
  let dirPath: string;

  beforeEach(async () => {
    dirPath = path.join(tmpDir, 'update-test');
    await initResearchState(dirPath, 'Update Test', {
      description: 'Testing updates',
      goals: ['Goal A'],
    });
  });

  it('should add findings', async () => {
    const updated = await updateResearchState(dirPath, {
      addFindings: [
        { title: 'Finding A', content: 'Content A', source: 'https://a.com' },
        { title: 'Finding B', content: 'Content B' },
      ],
    });

    expect(updated.findings).toHaveLength(2);
    expect(updated.findings[0].title).toBe('Finding A');
    expect(updated.findings[0].source).toBe('https://a.com');
    expect(updated.findings[1].title).toBe('Finding B');
  });

  it('should add questions', async () => {
    const updated = await updateResearchState(dirPath, {
      addQuestions: [{ question: 'What is X?' }, { question: 'How does Y work?' }],
    });

    expect(updated.questions).toHaveLength(2);
    expect(updated.questions[0].question).toBe('What is X?');
    expect(updated.questions[0].resolved).toBe(false);
  });

  it('should resolve a question', async () => {
    // First add a question
    const withQuestion = await updateResearchState(dirPath, {
      addQuestions: [{ question: 'To resolve?' }],
    });
    const questionId = withQuestion.questions[0].id!;

    // Then resolve it
    const resolved = await updateResearchState(dirPath, {
      resolveQuestion: questionId,
      resolvedByFindingId: 'f1',
    });

    expect(resolved.questions[0].resolved).toBe(true);
    expect(resolved.questions[0].resolvedAt).toBeDefined();
    expect(resolved.questions[0].resolvedById).toBe('f1');
  });

  it('should set conclusion', async () => {
    const updated = await updateResearchState(dirPath, {
      conclusion: 'Research complete.',
    });

    expect(updated.conclusion).toBe('Research complete.');
  });

  it('should clear conclusion with null', async () => {
    await updateResearchState(dirPath, { conclusion: 'Temp' });
    const updated = await updateResearchState(dirPath, { conclusion: null });

    expect(updated.conclusion).toBeNull();
  });

  it('should add resources', async () => {
    const updated = await updateResearchState(dirPath, {
      addResources: [{ title: 'Docs', url: 'https://docs.com' }],
    });

    expect(updated.resources).toHaveLength(1);
    expect(updated.resources[0].title).toBe('Docs');
  });

  it('should remove a finding by ID', async () => {
    const withFinding = await updateResearchState(dirPath, {
      addFindings: [{ title: 'Keep', content: 'Keep this' }, { title: 'Remove', content: 'Remove this' }],
    });
    const removeId = withFinding.findings.find(f => f.title === 'Remove')!.id!;

    const updated = await updateResearchState(dirPath, { removeFinding: removeId });
    expect(updated.findings).toHaveLength(1);
    expect(updated.findings[0].title).toBe('Keep');
  });

  it('should remove a question by ID', async () => {
    const withQ = await updateResearchState(dirPath, {
      addQuestions: [{ question: 'Keep?' }, { question: 'Remove?' }],
    });
    const removeId = withQ.questions.find(q => q.question === 'Remove?')!.id!;

    const updated = await updateResearchState(dirPath, { removeQuestion: removeId });
    expect(updated.questions).toHaveLength(1);
    expect(updated.questions[0].question).toBe('Keep?');
  });

  it('should update updatedAt timestamp', async () => {
    const original = await loadResearchState(dirPath)!;
    // Small delay to ensure timestamp difference
    await new Promise(resolve => setTimeout(resolve, 10));

    const updated = await updateResearchState(dirPath, { conclusion: 'Done' });
    expect(updated.updatedAt >= original!.updatedAt).toBe(true);
  });

  it('should throw if no research state exists', async () => {
    await expect(
      updateResearchState(path.join(tmpDir, 'nonexistent'), { conclusion: 'X' }),
    ).rejects.toThrow('No research state found');
  });

  it('should persist updates to both RESEARCH.md and sidecar', async () => {
    await updateResearchState(dirPath, {
      addFindings: [{ title: 'Persisted', content: 'Yes' }],
    });

    // Reload from sidecar
    const fromSidecar = await loadResearchState(dirPath);
    expect(fromSidecar!.findings).toHaveLength(1);

    // Reload from markdown (delete sidecar first)
    await fs.unlink(path.join(dirPath, '.research-state.json'));
    const fromMd = await loadResearchState(dirPath);
    expect(fromMd!.findings).toHaveLength(1);
    expect(fromMd!.findings[0].title).toBe('Persisted');
  });
});

// ===========================================================================
// Convenience wrappers
// ===========================================================================

describe('addFinding', () => {
  it('should add a finding and return updated state', async () => {
    const dirPath = path.join(tmpDir, 'conv-finding');
    await initResearchState(dirPath, 'Test');

    const updated = await addFinding(dirPath, {
      title: 'Quick finding',
      content: 'Auto-recorded',
      source: 'https://quick.com',
    });

    expect(updated.findings).toHaveLength(1);
    expect(updated.findings[0].id).toBeDefined();
    expect(updated.findings[0].recordedAt).toBeDefined();
  });
});

describe('addQuestion', () => {
  it('should add a question and return updated state', async () => {
    const dirPath = path.join(tmpDir, 'conv-question');
    await initResearchState(dirPath, 'Test');

    const updated = await addQuestion(dirPath, 'How does this work?');

    expect(updated.questions).toHaveLength(1);
    expect(updated.questions[0].question).toBe('How does this work?');
    expect(updated.questions[0].resolved).toBe(false);
  });
});

describe('resolveQuestion', () => {
  it('should resolve a question by ID', async () => {
    const dirPath = path.join(tmpDir, 'conv-resolve');
    await initResearchState(dirPath, 'Test');
    const withQ = await addQuestion(dirPath, 'To resolve?');

    const updated = await resolveQuestion(dirPath, withQ.questions[0].id!, 'f1');
    expect(updated.questions[0].resolved).toBe(true);
    expect(updated.questions[0].resolvedById).toBe('f1');
  });
});

describe('setConclusion', () => {
  it('should set the conclusion', async () => {
    const dirPath = path.join(tmpDir, 'conv-conclusion');
    await initResearchState(dirPath, 'Test');

    const updated = await setConclusion(dirPath, 'Final answer: 42.');
    expect(updated.conclusion).toBe('Final answer: 42.');
  });
});

// ===========================================================================
// cleanupResearchState
// ===========================================================================

describe('cleanupResearchState', () => {
  it('should remove RESEARCH.md and sidecar', async () => {
    const dirPath = path.join(tmpDir, 'cleanup-test');
    await initResearchState(dirPath, 'Test');

    await cleanupResearchState(dirPath);

    expect(await researchStateExists(dirPath)).toBe(false);
    try {
      await fs.access(path.join(dirPath, '.research-state.json'));
      expect.fail('Sidecar should be deleted');
    } catch {
      // Expected
    }
  });

  it('should not delete the directory itself', async () => {
    const dirPath = path.join(tmpDir, 'cleanup-dir');
    await initResearchState(dirPath, 'Test');

    await cleanupResearchState(dirPath);

    const stat = await fs.stat(dirPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should not throw if files do not exist', async () => {
    const dirPath = path.join(tmpDir, 'cleanup-missing');
    await fs.mkdir(dirPath, { recursive: true });

    await expect(cleanupResearchState(dirPath)).resolves.not.toThrow();
  });

  it('should handle custom file names', async () => {
    const dirPath = path.join(tmpDir, 'cleanup-custom');
    await initResearchState(dirPath, 'Test', { fileName: 'CUSTOM.md' });

    await cleanupResearchState(dirPath, 'CUSTOM.md');

    expect(await researchStateExists(dirPath, 'CUSTOM.md')).toBe(false);
  });
});

// ===========================================================================
// Integration: full workflow
// ===========================================================================

describe('full research workflow', () => {
  it('should support init → add findings → add questions → resolve → conclude', async () => {
    // 1. Initialize
    const { state: initState } = await initResearchTopic(tmpDir, 'WebAssembly Performance', {
      description: 'Benchmarking WASM vs JavaScript performance',
      goals: ['Benchmark computation speed', 'Compare memory usage'],
    });
    expect(initState.topic).toBe('WebAssembly Performance');
    expect(initState.goals).toHaveLength(2);

    const researchDir = path.join(tmpDir, 'webassembly-performance');

    // 2. Add questions
    await addQuestion(researchDir, 'What are the startup overhead differences?');
    const withQuestions2 = await addQuestion(researchDir, 'How does GC affect WASM?');
    expect(withQuestions2.questions).toHaveLength(2);

    // 3. Add findings
    const withFindings = await addFinding(researchDir, {
      title: 'Startup overhead is 2-5ms',
      content: 'WASM modules require compilation on first load, adding 2-5ms overhead.',
      source: 'https://webassembly.org/docs',
    });
    expect(withFindings.findings).toHaveLength(1);

    // 4. Resolve a question
    const qId = withFindings.questions[0].id!;
    const fId = withFindings.findings[0].id!;
    const resolved = await resolveQuestion(researchDir, qId, fId);
    expect(resolved.questions[0].resolved).toBe(true);

    // 5. Set conclusion
    const concluded = await setConclusion(researchDir, 'WASM shows 10-30% speed improvement for compute-heavy tasks, but 2-5ms startup overhead makes it unsuitable for short-lived operations.');
    expect(concluded.conclusion).toContain('WASM shows');

    // 6. Verify round-trip via markdown
    await fs.unlink(path.join(researchDir, '.research-state.json'));
    const reloaded = await loadResearchState(researchDir);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.topic).toBe('WebAssembly Performance');
    expect(reloaded!.findings).toHaveLength(1);
    expect(reloaded!.questions).toHaveLength(2);
    // After markdown round-trip, pending questions come first, then resolved
    const resolvedQ = reloaded!.questions.find(q => q.resolved);
    expect(resolvedQ).toBeDefined();
    expect(resolvedQ!.question).toBe('What are the startup overhead differences?');
    expect(reloaded!.conclusion).toContain('WASM shows');
  });
});
