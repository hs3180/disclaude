import type { ResearchProject, ProjectStatus } from './project.js';

const labels: Record<ProjectStatus, string> = { running: '研究中', 'waiting-user': '等待你补充信息', pausing: '正在暂停 · 等待当前阶段收尾', paused: '已暂停', cancelling: '正在取消 · 等待当前阶段结束', cancelled: '已取消', failed: '需要恢复', completed: '研究完成', interrupted: '执行曾中断 · 可恢复' };
const plain = (content: string) => ({ tag: 'plain_text', content });
const text = (content: string) => ({ tag: 'div', text: plain(content) });
export const researchButton = (label: string, value: Record<string, unknown>, primary = false) => ({
  tag: 'button', text: plain(label), type: primary ? 'primary' : 'default', behaviors: [{ type: 'callback', value: { research: true, ...value } }],
});
export function researchCard(title: string, elements: unknown[]): Record<string, unknown> {
  return { schema: '2.0', config: { enable_forward: false, update_multi: true }, header: { title: plain(title), template: 'blue' }, body: { elements } };
}
export function projectCard(p: ResearchProject): Record<string, unknown> {
  const value = { project: p.id, revision: p.revision };
  const actions: unknown[] = [researchButton('刷新项目', { ...value, action: 'refresh' })];
  if (p.status === 'running') { actions.push(researchButton('暂停研究', { ...value, action: 'pause' })); }
  if (['paused', 'failed', 'interrupted', 'waiting-user'].includes(p.status)) { actions.push(researchButton(p.directions.length ? '恢复研究' : '开始研究', { ...value, action: 'resume' }, true)); }
  if (!['completed', 'cancelled', 'cancelling'].includes(p.status)) { actions.push(researchButton('取消研究', { ...value, action: 'cancel' })); }
  const visible = p.directions.slice(-8);
  const elements: unknown[] = [
    text(`${labels[p.status]}\n${p.scope || '范围：围绕研究问题展开'}\n最近更新：${p.updatedAt}`),
    ...(p.parent ? [text('从已有成果继续的研究'), researchButton('查看原项目', { project: p.parent, action: 'open' })] : []),
    text(p.history.at(-1)?.text ?? ''),
    ...(p.clarification ? [text(`需要你补充\n${p.clarification}`)] : []),
    ...(p.error ? [text(p.error)] : []),
    ...(p.deliveryError ? [text(p.deliveryError)] : []),
    ...actions,
    { tag: 'hr' }, text('研究方向与证据'),
    ...visible.flatMap(d => [
      text(`${d.status === 'done' ? '已完成' : d.status === 'stopped' ? '已停止' : '待研究'} · ${d.title}\n${d.findings.length} 项发现`),
      ...(d.findings.length ? [researchButton('查看发现与来源', { ...value, action: 'evidence', direction: d.id })] : []),
      ...(d.status === 'pending' && !['completed', 'cancelled'].includes(p.status) ? [researchButton('停止这个方向', { ...value, action: 'stop-direction', direction: d.id })] : []),
    ]),
    ...(p.summary ? [{ tag: 'hr' }, text(`阶段结论\n${p.summary}`)] : []),
    ...(p.questions.length ? [text(`尚未解决\n${p.questions.join('\n')}`)] : []),
    researchButton('查看研究记录', { ...value, action: 'history', offset: 0 }),
  ];
  if (!['completed', 'cancelled', 'cancelling'].includes(p.status)) {
    elements.push({ tag: 'form', name: 'research_adjustment', elements: [
      { tag: 'input', name: 'feedback', required: true, placeholder: plain('修改范围、补充材料或指出证据不足（3000 字以内）') },
      { ...researchButton('提交研究调整', { ...value, action: 'feedback' }, true), name: 'submit_feedback', action_type: 'form_submit' },
    ] });
  } else {
    elements.push(researchButton('基于成果继续研究', { ...value, action: 'continue' }, true));
  }
  return researchCard(p.title, elements);
}
export function evidenceCard(p: ResearchProject, directionId: string, index: number): Record<string, unknown> {
  const d = p.directions.find(d => d.id === directionId);
  const f = d?.findings[index];
  if (!d || !f) { throw new Error('该发现不存在，请刷新项目。'); }
  return researchCard(d.title, [
    text(`发现 ${index + 1}/${d.findings.length} · ${f.kind === 'fact' ? '来源事实' : f.kind === 'inference' ? '研究推断' : '尚不确定'}\n${f.claim}`),
    ...f.sources.map(s => text(`${s.title}\n${s.location}\n${s.excerpt}`)),
    text(`分歧与限制\n${f.caveat || '未记录额外说明；仍需结合来源判断。'}`),
    ...(index + 1 < d.findings.length ? [researchButton('下一项发现', { project: p.id, action: 'evidence', direction: d.id, index: index + 1 })] : []),
    researchButton('返回项目', { project: p.id, action: 'open' }),
  ]);
}
export function historyCard(p: ResearchProject, offset: number): Record<string, unknown> {
  const entries = [
    ...p.history.map(h => `${h.at}\n${h.text}`),
    ...p.feedback.map(f => `${f.at} · ${f.status === 'pending' ? '待处理意见' : '已用于调整计划'}\n${f.text}`),
  ].sort().reverse();
  return researchCard('研究记录', [
    ...entries.slice(offset, offset + 6).map(text),
    ...(offset + 6 < entries.length ? [researchButton('更早记录', { project: p.id, action: 'history', offset: offset + 6 })] : []),
    ...p.directions.filter(d => d.findings.length).slice(offset, offset + 6).map(d => researchButton(`证据：${d.title}`, { project: p.id, action: 'evidence', direction: d.id })),
    researchButton('返回项目', { project: p.id, action: 'open' }),
  ]);
}
export function indexCard(projects: ResearchProject[], nonce: string, offset = 0): Record<string, unknown> {
  return researchCard('我的研究项目', [
    text('研究围绕项目持续推进。可以随时重返、查看证据、调整方向或暂停。项目控制由创建者操作。'),
    text('材料与意见请在项目内提交；外部文档中的改动不会自动同步。'),
    ...projects.slice(offset, offset + 6).flatMap(p => [text(`${p.title} · ${labels[p.status]}`), researchButton('打开项目', { project: p.id, action: 'open' })]),
    ...(projects.length > offset + 6 ? [researchButton('更多项目', { action: 'index', offset: offset + 6 })] : []),
    { tag: 'form', name: 'research_create', elements: [
      { tag: 'input', name: 'question', required: true, placeholder: plain('想研究什么？（180 字以内）') },
      { tag: 'input', name: 'scope', placeholder: plain('研究范围、约束与希望得到的成果') },
      { tag: 'input', name: 'materials', placeholder: plain('已有材料、来源链接或摘录') },
      { ...researchButton('建立研究项目', { action: 'create', nonce }, true), name: 'create_research', action_type: 'form_submit' },
    ] },
  ]);
}
