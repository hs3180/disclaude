/**
 * Tests for skills/research-note.ts
 *
 * Tests the RESEARCH.md lifecycle management utilities:
 * - generateInitialResearchMd: template generation with topic, goals, questions
 * - parseResearchStatus: status extraction from RESEARCH.md content
 * - generateConclusionSection: conclusion content generation
 * - updateResearchStatus: status marker transition
 */

import { describe, it, expect } from 'vitest';
import {
  generateInitialResearchMd,
  parseResearchStatus,
  generateConclusionSection,
  updateResearchStatus,
  RESEARCH_STATUS_MARKERS,
  RESEARCH_STATUS_LABELS,
} from './research-note.js';

describe('RESEARCH_STATUS_MARKERS', () => {
  it('should have correct emoji markers for each status', () => {
    expect(RESEARCH_STATUS_MARKERS['in-progress']).toBe('🟡');
    expect(RESEARCH_STATUS_MARKERS['paused']).toBe('🟠');
    expect(RESEARCH_STATUS_MARKERS['completed']).toBe('🟢');
  });
});

describe('RESEARCH_STATUS_LABELS', () => {
  it('should have correct Chinese labels for each status', () => {
    expect(RESEARCH_STATUS_LABELS['in-progress']).toBe('进行中');
    expect(RESEARCH_STATUS_LABELS['paused']).toBe('已暂停');
    expect(RESEARCH_STATUS_LABELS['completed']).toBe('已完成');
  });
});

describe('generateInitialResearchMd', () => {
  it('should generate valid markdown with topic and description', () => {
    const content = generateInitialResearchMd({
      topic: 'React Performance',
      description: 'Investigate React rendering performance',
      goals: ['Identify bottlenecks'],
    });

    expect(content).toContain('# React Performance');
    expect(content).toContain('Investigate React rendering performance');
    expect(content).toContain('🟡 进行中');
  });

  it('should include creation date in ISO format', () => {
    const content = generateInitialResearchMd({
      topic: 'Test Topic',
      description: 'Test description',
      goals: [],
    });

    const dateMatch = content.match(/创建时间:\s*(\d{4}-\d{2}-\d{2})/);
    expect(dateMatch).not.toBeNull();

    const date = new Date(dateMatch![1]);
    expect(date.toISOString()).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('should include all goals as checkboxes', () => {
    const content = generateInitialResearchMd({
      topic: 'Test Topic',
      description: 'Test description',
      goals: ['Goal 1', 'Goal 2', 'Goal 3'],
    });

    expect(content).toContain('- [ ] Goal 1');
    expect(content).toContain('- [ ] Goal 2');
    expect(content).toContain('- [ ] Goal 3');
  });

  it('should include questions when provided', () => {
    const content = generateInitialResearchMd({
      topic: 'Test Topic',
      description: 'Test description',
      goals: ['Goal 1'],
      questions: ['Question 1', 'Question 2'],
    });

    expect(content).toContain('- [ ] Question 1');
    expect(content).toContain('- [ ] Question 2');
  });

  it('should show placeholder when no questions provided', () => {
    const content = generateInitialResearchMd({
      topic: 'Test Topic',
      description: 'Test description',
      goals: ['Goal 1'],
    });

    expect(content).toContain('暂无待调查问题');
  });

  it('should show placeholder when questions array is empty', () => {
    const content = generateInitialResearchMd({
      topic: 'Test Topic',
      description: 'Test description',
      goals: ['Goal 1'],
      questions: [],
    });

    expect(content).toContain('暂无待调查问题');
  });

  it('should include all required sections', () => {
    const content = generateInitialResearchMd({
      topic: 'Test Topic',
      description: 'Test description',
      goals: ['Goal 1'],
    });

    expect(content).toContain('## 研究目标');
    expect(content).toContain('## 已收集的信息');
    expect(content).toContain('## 待调查的问题');
    expect(content).toContain('## 研究结论');
    expect(content).toContain('## 相关资源');
  });

  it('should include placeholder text for empty sections', () => {
    const content = generateInitialResearchMd({
      topic: 'Test Topic',
      description: 'Test description',
      goals: ['Goal 1'],
    });

    expect(content).toContain('暂无发现');
    expect(content).toContain('研究完成后填写');
    expect(content).toContain('相关资源');
  });
});

describe('parseResearchStatus', () => {
  it('should parse in-progress status', () => {
    const content = '# Test Topic\n\n> Status info\n> 创建时间: 2026-01-15\n> 状态: 🟡 进行中\n\n## 研究目标';
    const result = parseResearchStatus(content);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('in-progress');
    expect(result!.topic).toBe('Test Topic');
    expect(result!.createdAt).toBe('2026-01-15');
  });

  it('should parse paused status', () => {
    const content = '# My Research\n\n> 状态: 🟠 已暂停';
    const result = parseResearchStatus(content);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('paused');
  });

  it('should parse completed status', () => {
    const content = '# Done Research\n\n> 状态: 🟢 已完成';
    const result = parseResearchStatus(content);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('completed');
  });

  it('should return null when no status marker found', () => {
    const content = '# No Status\n\nSome content without status marker';
    const result = parseResearchStatus(content);

    expect(result).toBeNull();
  });

  it('should return null for empty content', () => {
    const result = parseResearchStatus('');
    expect(result).toBeNull();
  });

  it('should handle missing creation date gracefully', () => {
    const content = '# Test\n\n> 状态: 🟡 进行中';
    const result = parseResearchStatus(content);

    expect(result).not.toBeNull();
    expect(result!.createdAt).toBeNull();
  });

  it('should handle missing topic gracefully', () => {
    const content = '> 状态: 🟡 进行中\n\nNo heading';
    const result = parseResearchStatus(content);

    expect(result).not.toBeNull();
    expect(result!.topic).toBe('Unknown');
  });

  it('should extract topic from H1 heading', () => {
    const content = '# Advanced TypeScript Patterns\n\n> 状态: 🟡 进行中';
    const result = parseResearchStatus(content);

    expect(result).not.toBeNull();
    expect(result!.topic).toBe('Advanced TypeScript Patterns');
  });
});

describe('generateConclusionSection', () => {
  it('should generate core findings section', () => {
    const result = generateConclusionSection({
      coreFindings: ['Finding 1', 'Finding 2'],
    });

    expect(result).toContain('### 核心发现');
    expect(result).toContain('- Finding 1');
    expect(result).toContain('- Finding 2');
  });

  it('should include recommendations when provided', () => {
    const result = generateConclusionSection({
      coreFindings: ['Finding 1'],
      recommendations: ['Recommendation 1'],
    });

    expect(result).toContain('### 建议');
    expect(result).toContain('- Recommendation 1');
  });

  it('should include unresolved issues when provided', () => {
    const result = generateConclusionSection({
      coreFindings: ['Finding 1'],
      unresolvedIssues: ['Issue 1'],
    });

    expect(result).toContain('### 未解决问题');
    expect(result).toContain('- Issue 1');
  });

  it('should include follow-up directions when provided', () => {
    const result = generateConclusionSection({
      coreFindings: ['Finding 1'],
      followUpDirections: ['Direction 1'],
    });

    expect(result).toContain('### 后续方向');
    expect(result).toContain('- Direction 1');
  });

  it('should generate complete conclusion with all sections', () => {
    const result = generateConclusionSection({
      coreFindings: ['F1', 'F2'],
      recommendations: ['R1'],
      unresolvedIssues: ['U1'],
      followUpDirections: ['D1'],
    });

    expect(result).toContain('### 核心发现');
    expect(result).toContain('### 建议');
    expect(result).toContain('### 未解决问题');
    expect(result).toContain('### 后续方向');
    expect(result).toContain('- F1');
    expect(result).toContain('- R1');
    expect(result).toContain('- U1');
    expect(result).toContain('- D1');
  });

  it('should handle empty core findings', () => {
    const result = generateConclusionSection({
      coreFindings: [],
    });

    // Empty findings should produce minimal output
    expect(result).toBe('');
  });

  it('should skip optional sections when not provided', () => {
    const result = generateConclusionSection({
      coreFindings: ['Finding 1'],
    });

    expect(result).not.toContain('### 建议');
    expect(result).not.toContain('### 未解决问题');
    expect(result).not.toContain('### 后续方向');
  });
});

describe('updateResearchStatus', () => {
  const baseContent = `# Test Topic

> Description
> 创建时间: 2026-01-15
> 状态: 🟡 进行中

## 研究目标
- [ ] Goal 1`;

  it('should update status from in-progress to completed', () => {
    const result = updateResearchStatus(baseContent, 'completed');
    expect(result).toContain('🟢 已完成');
    expect(result).not.toContain('🟡 进行中');
  });

  it('should update status from in-progress to paused', () => {
    const result = updateResearchStatus(baseContent, 'paused');
    expect(result).toContain('🟠 已暂停');
    expect(result).not.toContain('🟡 进行中');
  });

  it('should preserve other content when updating status', () => {
    const result = updateResearchStatus(baseContent, 'completed');
    expect(result).toContain('# Test Topic');
    expect(result).toContain('创建时间: 2026-01-15');
    expect(result).toContain('## 研究目标');
    expect(result).toContain('- [ ] Goal 1');
  });

  it('should return original content when status pattern not found', () => {
    const contentWithoutStatus = '# No Status\n\nSome content';
    const result = updateResearchStatus(contentWithoutStatus, 'completed');
    expect(result).toBe(contentWithoutStatus);
  });
});

describe('integration: full lifecycle', () => {
  it('should support generate → parse → update → parse flow', () => {
    // Phase 1: Generate initial RESEARCH.md
    const initial = generateInitialResearchMd({
      topic: 'Full Lifecycle Test',
      description: 'Testing the complete research note lifecycle',
      goals: ['Complete all phases'],
      questions: ['Will it work?'],
    });

    // Parse initial status
    let status = parseResearchStatus(initial);
    expect(status).not.toBeNull();
    expect(status!.status).toBe('in-progress');
    expect(status!.topic).toBe('Full Lifecycle Test');

    // Phase 2: Update status to paused
    const paused = updateResearchStatus(initial, 'paused');
    status = parseResearchStatus(paused);
    expect(status!.status).toBe('paused');

    // Phase 3: Generate conclusion and mark as completed
    const conclusion = generateConclusionSection({
      coreFindings: ['The lifecycle works correctly'],
      recommendations: ['Use this pattern for all research notes'],
    });

    const completed = updateResearchStatus(initial, 'completed');
    status = parseResearchStatus(completed);
    expect(status!.status).toBe('completed');
    expect(conclusion).toContain('The lifecycle works correctly');
  });
});
