import type { ResearchProject, ProjectStatus } from './project.js';

const labels: Record<ProjectStatus, string> = { running: '执行中', 'waiting-user': '等待你补充信息', pausing: '正在暂停 · 等待当前回合收尾', paused: '已暂停', cancelling: '正在取消 · 等待当前回合结束', cancelled: '已取消', failed: '需要恢复', completed: '任务完成', interrupted: '执行曾中断 · 可恢复' };
const plain = (content: string) => ({ tag: 'plain_text', content });
const text = (content: string) => ({ tag: 'div', text: plain(content) });
const statusText: Record<ProjectStatus, string> = { running: '执行中', 'waiting-user': '等待补充信息', pausing: '正在收尾并暂停', paused: '已暂停', cancelling: '正在收尾并取消', cancelled: '已取消', failed: '需要恢复', completed: '已完成', interrupted: '曾中断，可恢复' };
export const researchButton = (label: string, value: Record<string, unknown>, primary = false) => ({
  tag: 'button', text: plain(label), type: primary ? 'primary' : 'default', behaviors: [{ type: 'callback', value: { research: true, ...value } }],
});
const submitButton = (label: string, value: Record<string, unknown>) => ({
  tag: 'button', text: plain(label), type: 'primary_filled', form_action_type: 'submit',
  name: `research:${JSON.stringify(value)}`,
});
export function researchCard(title: string, elements: unknown[]): Record<string, unknown> {
  return { schema: '2.0', config: { enable_forward: false, update_multi: true, width_mode: 'default' }, header: { title: plain(title), template: 'blue' }, body: { vertical_spacing: '12px', elements } };
}
/** Plain-text status is the default Research surface; cards are reserved for explicit feedback/details. */
export function researchStatusText(p: ResearchProject): string {
  const lines = [`研究：${p.title}`, `研究 ID：${p.id}`, `状态：${statusText[p.status]} · revision ${p.revision}`,
    `重返：使用 research_workspace get researchId=${p.id}；控制操作需先读取当前 revision。`];
  if (p.scope) { lines.push(`范围：${p.scope}`); }
  if (p.workingDir) { lines.push(`项目目录：${p.workingDir}`); }
  if (p.document) { lines.push(`关联文档：${p.document.url}${p.document.error ? `（${p.document.error}）` : ''}`); }
  if (p.clarification) { lines.push(`需要补充：${p.clarification}`); }
  if (p.summary) { lines.push(`成果：${p.summary}`); }
  if (p.directions.length) { lines.push(`工作方向：${p.directions.map(d => `${d.title}（${d.status === 'done' ? '完成' : d.status === 'stopped' ? '已停止' : '进行中'}，${d.findings.length} 项证据）`).join('；')}`); }
  const latest = p.history.at(-1);
  if (latest?.text) { lines.push(`最近更新：${latest.text}`); }
  if (p.error) { lines.push(`错误：${p.error}`); }
  if (!['completed', 'cancelled'].includes(p.status)) { lines.push('可继续用自然语言补充范围/材料，或使用 research_workspace 控制暂停、恢复和取消。'); }
  return lines.join('\n');
}
export function researchDetailCard(p: ResearchProject): Record<string, unknown> {
  const value = { project: p.id, revision: p.revision };
  const actions: unknown[] = [researchButton('刷新研究', { ...value, action: 'refresh' }), researchButton('返回研究摘要', { action: 'index' })];
  if (p.status === 'running') { actions.push(researchButton('暂停任务', { ...value, action: 'pause' })); }
  if (['paused', 'failed', 'interrupted', 'waiting-user'].includes(p.status)) { actions.push(researchButton(p.directions.length ? '恢复任务' : '开始任务', { ...value, action: 'resume' }, true)); }
  if (!['completed', 'cancelled', 'cancelling'].includes(p.status)) { actions.push(researchButton('取消任务', { ...value, action: 'cancel' })); }
  if (!p.workingDir && !['running', 'pausing', 'cancelling'].includes(p.status)) {
    actions.push(researchButton(p.projectLink ? '撤销项目关联' : '关联到当前项目…', { ...value, action: p.projectLink ? 'unlink-project' : 'preview-project-link' }));
  }
  const visible = p.directions.slice(-8);
  if (p.status === 'completed' && p.document && p.summary && p.document.export?.status !== 'saved'
    && !(p.document.export && p.document.publishedFragments?.includes(p.document.export.fragment))) {
    actions.push(researchButton(['writing', 'unknown'].includes(p.document.export?.status ?? '') ? '核对文档写入' : '将成果追加到关联文档', { ...value, action: 'export' }));
  }
  const elements: unknown[] = [
    ...(p.archivedAt ? [text('已归档 · 成果和任务记录保留')] : []),
    text(`${labels[p.status]}\n${p.scope || '范围：围绕任务目标展开'}\n最近更新：${p.updatedAt}`),
    text(p.workingDir ? `项目工作目录\n${p.workingDir}\n任务创建后固定使用此目录；切换对话目录不会迁移已有任务。` : p.projectLink ? '历史任务：保留原独立任务目录。' : '历史任务：未关联项目工作目录，继续使用原独立任务目录。'),
    ...(p.projectLink ? [text(`关联项目目录\n${p.projectLink.directory}\n仅建立导航关联；仍使用原独立任务目录，不移动或复制文件。`)] : []),
    ...(p.parent ? [text('从已有成果继续的任务'), researchButton('查看原任务', { project: p.parent, action: 'open' })] : []),
    ...(p.parentFinding && p.priorResults?.findings[0] ? [text(`本次跟进的发现\n${p.priorResults.findings[0].claim}`), researchButton('查看原发现与来源', { project: p.parent, action: 'evidence', direction: p.parentFinding.directionId, index: p.parentFinding.index })] : []),
    text(p.history.at(-1)?.text ?? ''),
    ...(p.clarification ? [text(`需要你补充\n${p.clarification}`)] : []),
    ...(p.error ? [text(p.error)] : []),
    ...(p.deliveryError ? [text(p.deliveryError)] : []),
    ...(p.document?.export ? [text(p.document.export.error ?? (p.document.export.status === 'saved' ? '成果已追加到关联文档，原文保留。' : '正在核对文档成果。'))] : []),
    ...(p.document ? [text(`关联文档\n${p.document.url}\n${p.document.error ?? (p.document.snapshot ? `最近同步：${p.document.snapshot.syncedAt}（执行检查点读取，非实时）` : '尚未同步，开始任务前将读取正文与评论。')}`)] : []),
    ...actions,
    { tag: 'hr' }, text('工作与证据'),
    ...visible.flatMap(d => [
      text(`${d.status === 'done' ? '已完成' : d.status === 'stopped' ? '已停止' : '待处理'} · ${d.title}\n${d.findings.length} 项发现`),
      ...(d.findings.length ? [researchButton('查看发现与来源', { ...value, action: 'evidence', direction: d.id })] : []),
      ...(d.status === 'pending' && !['completed', 'cancelled'].includes(p.status) ? [researchButton('停止这个方向', { ...value, action: 'stop-direction', direction: d.id })] : []),
    ]),
    ...(p.summary ? [{ tag: 'hr' }, text(`当前成果\n${p.summary}`)] : []),
    ...(p.questions.length ? [text(`尚未解决\n${p.questions.join('\n')}`)] : []),
    researchButton('查看任务记录', { ...value, action: 'history', offset: 0 }),
  ];
  if (!['completed', 'cancelled', 'cancelling'].includes(p.status)) {
    elements.push({ tag: 'form', name: 'research_adjustment', elements: [
      { tag: 'input', name: 'feedback', required: true, placeholder: plain('修改范围、补充材料或指出证据不足（3000 字以内）') },
      submitButton('提交任务调整', { ...value, action: 'feedback' }),
    ] });
  } else if (['completed', 'cancelled'].includes(p.status)) {
    elements.push(researchButton('基于成果继续任务', { ...value, action: 'continue' }, true));
    elements.push(researchButton(p.archivedAt ? '移回任务列表' : '归档任务', { ...value, action: p.archivedAt ? 'unarchive' : 'archive' }));
  }
  return researchCard(p.title, elements);
}
export function evidenceCard(p: ResearchProject, directionId: string, index: number): Record<string, unknown> {
  const d = p.directions.find(d => d.id === directionId);
  const f = d?.findings[index];
  if (!d || !f) { throw new Error('该发现不存在，请刷新项目。'); }
  return researchCard(d.title, [
    text(`发现 ${index + 1}/${d.findings.length} · ${f.kind === 'fact' ? '来源事实' : f.kind === 'inference' ? '推断' : '尚不确定'}\n${f.claim}`),
    ...f.sources.map(s => text(`${s.title}\n${s.location}\n${s.excerpt}`)),
    text(`分歧与限制\n${f.caveat || '未记录额外说明；仍需结合来源判断。'}`),
    ...(index + 1 < d.findings.length ? [researchButton('下一项发现', { project: p.id, action: 'evidence', direction: d.id, index: index + 1 })] : []),
    ...(['completed', 'cancelled'].includes(p.status) ? [researchButton('基于这项发现继续任务', { project: p.id, action: 'continue-finding', direction: d.id, index }, true)] : []),
    researchButton('返回任务', { project: p.id, action: 'open' }),
  ]);
}
export function historyCard(p: ResearchProject, offset: number): Record<string, unknown> {
  const entries = [
    ...p.history.map(h => `${h.at}\n${h.text}`),
    ...p.feedback.map(f => {
      const status = { pending: '待处理意见', applied: '已采纳（查看关联工作与证据）', rejected: '未采纳', 'needs-clarification': '待澄清' }[f.status];
      const directions = f.directionIds?.map(id => p.directions.find(d => d.id === id)?.title ?? '历史方向').join('、');
      return `${f.at} · ${status}\n${f.text}\n${f.reason ?? '未记录处理理由'}${directions ? `\n关联方向：${directions}` : ''}`;
    }),
  ].sort().reverse();
  return researchCard('任务记录', [
    ...entries.slice(offset, offset + 6).map(text),
    ...(offset + 6 < entries.length ? [researchButton('更早记录', { project: p.id, action: 'history', offset: offset + 6 })] : []),
    ...p.directions.filter(d => d.findings.length).slice(offset, offset + 6).map(d => researchButton(`证据：${d.title}`, { project: p.id, action: 'evidence', direction: d.id })),
    researchButton('返回任务', { project: p.id, action: 'open' }),
  ]);
}
export function projectLinkPreviewCard(p: ResearchProject): Record<string, unknown> {
  if (!p.linkPreview) { throw new Error('项目关联预览已失效。'); }
  return researchCard('确认历史任务的项目关联', [
    text(p.title), text(`目标项目目录\n${p.linkPreview.directory}`),
    text('此次只将历史任务显示为该项目的关联任务。任务身份、已有发现、文档和独立执行目录保留，不移动或复制文件，不重跑已完成工作。可从任务卡片撤销关联。从该成果继续的任务继承项目归属，仍使用各自的独立执行目录。'),
    researchButton('确认关联', { project: p.id, revision: p.revision, token: p.linkPreview.token, action: 'confirm-project-link' }, true),
    researchButton('暂不关联，返回任务', { project: p.id, action: 'open' }),
  ]);
}
