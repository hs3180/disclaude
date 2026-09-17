import { describe, expect, it } from 'vitest';
import type { ProjectTask, ProjectStatus } from '../../harness/project-task.js';
import { projectCard, evidenceCard, indexCard, projectLinkPreviewCard } from './project-task-cards.js';

function task(status: ProjectStatus): ProjectTask {
  return { id: 'task-1', workingDir: '/projects/alpha', owner: 'alice', chat: 'chat-a', source: 'form', title: 'Check supplied evidence',
    scope: '', materials: '', status, revision: 3, createdAt: '', updatedAt: '', directions: [], summary: '', questions: [], history: [], feedback: [], stepCount: 0 };
}
function actions(card: unknown): Record<string, unknown>[] {
  if (!card || typeof card !== 'object') { return []; }
  const value = card as Record<string, unknown>;
  const own = value.type === 'callback' && value.value ? [value.value as Record<string, unknown>] : [];
  return [...own, ...Object.values(value).flatMap(actions)];
}
const names = (card: unknown) => actions(card).map(action => action.action);

describe('project task card controls', () => {
  it.each(['running', 'pausing', 'paused', 'waiting-user', 'cancelling', 'cancelled', 'failed', 'completed', 'interrupted'] as const)(
    'offers continuation only after terminal state: %s', status => {
      const card = projectCard(task(status));
      expect(names(card).includes('continue')).toBe(['completed', 'cancelled'].includes(status));
      expect(names(card).includes('resume')).toBe(['paused', 'waiting-user', 'failed', 'interrupted'].includes(status));
      expect(names(card).includes('pause')).toBe(status === 'running');
      expect(names(card).includes('cancel')).toBe(!['completed', 'cancelled', 'cancelling'].includes(status));
    },
  );
  it('shows cancelled evidence without retry guidance and preserves callback task/revision identity', () => {
    const p = task('cancelled'); p.history = [{ at: '', text: '任务已取消，在途结果未计入成果。' }];
    const card = projectCard(p);
    expect(JSON.stringify(card)).not.toContain('恢复重试');
    expect(JSON.stringify(card)).toContain('基于成果继续任务');
    expect(actions(card).find(action => action.action === 'continue')).toEqual({ research: true, project: p.id, revision: 3, action: 'continue' });
  });
  it.each(['fact', 'inference', 'uncertain'] as const)('keeps evidence, source and caveat visible for %s', kind => {
    const p = task('completed'); p.directions = [{ id: 'work-a', title: 'Evidence', status: 'done', findings: [{ claim: 'A costs 10', kind,
      sources: [{ title: 'Report A', location: 'page 3', excerpt: 'Cost: 10' }], caveat: 'Fictional test material' }] }];
    const text = JSON.stringify(evidenceCard(p, 'work-a', 0));
    for (const value of ['A costs 10', 'Report A', 'page 3', 'Cost: 10', 'Fictional test material']) { expect(text).toContain(value); }
    expect(names(evidenceCard(p, 'work-a', 0))).toContain('continue-finding');
    p.status = 'cancelling'; expect(names(evidenceCard(p, 'work-a', 0))).not.toContain('continue-finding');
  });
  it('shows fixed task directory independently of the current home directory', () => {
    const p = task('paused');
    expect(JSON.stringify(indexCard([p], 'nonce', 0, false, { workingDir: '/projects/beta' }))).toContain('/projects/alpha');
    expect(JSON.stringify(projectCard(p))).toContain('切换对话目录不会迁移已有任务');
    expect(JSON.stringify(indexCard([p], 'nonce', 0, false, { error: 'Directory unavailable' }))).not.toContain('research_create');
  });
  it('preserves the explicit legacy association preview token and revision', () => {
    const p = task('paused'); p.workingDir = undefined; p.linkPreview = { directory: '/projects/beta', token: 'preview-1' };
    const card = projectLinkPreviewCard(p);
    expect(actions(card).find(action => action.action === 'confirm-project-link')).toEqual({ research: true, project: p.id, revision: 3, token: 'preview-1', action: 'confirm-project-link' });
    expect(JSON.stringify(card)).toContain('不移动或复制文件');
  });
});
