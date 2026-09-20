import { describe, expect, it } from 'vitest';
import { researchStatusText } from './cards.js';
import type { ResearchProject } from './project.js';

describe('research status surface', () => {
  it('exposes the durable identity and re-entry operation in plain text', () => {
    const project = {
      id: 'research-123',
      title: '验证研究入口',
      status: 'paused',
      revision: 4,
      scope: '仅验证入口和状态',
      workingDir: '/tmp/project',
      history: [{ at: '2026-09-20T00:00:00.000Z', text: '已暂停。' }],
      directions: [],
      feedback: [],
      questions: [],
      summary: '',
    } as unknown as ResearchProject;

    const text = researchStatusText(project);
    expect(text).toContain('研究 ID：research-123');
    expect(text).toContain('状态：已暂停 · revision 4');
    expect(text).toContain('research_workspace get researchId=research-123');
  });
});
