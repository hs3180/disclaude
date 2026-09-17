const labels = { running: '执行中', 'waiting-user': '等待你补充信息', pausing: '正在暂停 · 等待当前回合收尾', paused: '已暂停', cancelling: '正在取消 · 等待当前回合结束', cancelled: '已取消', failed: '需要恢复', completed: '任务完成', interrupted: '执行曾中断 · 可恢复' };
const plain = (content) => ({ tag: 'plain_text', content });
const text = (content) => ({ tag: 'div', text: plain(content) });
const group = (elements) => ({ tag: 'column_set', flex_mode: 'none', columns: [{ tag: 'column', width: 'weighted', weight: 1, padding: '12px', background_style: 'grey-50', elements }] });
export const researchButton = (label, value, primary = false) => ({
    tag: 'button', text: plain(label), type: primary ? 'primary' : 'default', behaviors: [{ type: 'callback', value: { research: true, ...value } }],
});
const submitButton = (label, value) => ({
    tag: 'button', text: plain(label), type: 'primary_filled', form_action_type: 'submit',
    name: `research:${JSON.stringify(value)}`,
});
export function researchCard(title, elements) {
    return { schema: '2.0', config: { enable_forward: false, update_multi: true, width_mode: 'default' }, header: { title: plain(title), template: 'blue' }, body: { vertical_spacing: '12px', elements } };
}
export function projectCard(p) {
    const value = { project: p.id, revision: p.revision };
    const actions = [researchButton('刷新任务', { ...value, action: 'refresh' }), researchButton('返回项目首页', { action: 'index' })];
    if (p.status === 'running') {
        actions.push(researchButton('暂停任务', { ...value, action: 'pause' }));
    }
    if (['paused', 'failed', 'interrupted', 'waiting-user'].includes(p.status)) {
        actions.push(researchButton(p.directions.length ? '恢复任务' : '开始任务', { ...value, action: 'resume' }, true));
    }
    if (!['completed', 'cancelled', 'cancelling'].includes(p.status)) {
        actions.push(researchButton('取消任务', { ...value, action: 'cancel' }));
    }
    if (!p.workingDir && !['running', 'pausing', 'cancelling'].includes(p.status)) {
        actions.push(researchButton(p.projectLink ? '撤销项目关联' : '关联到当前项目…', { ...value, action: p.projectLink ? 'unlink-project' : 'preview-project-link' }));
    }
    const visible = p.directions.slice(-8);
    if (p.status === 'completed' && p.document && p.summary && p.document.export?.status !== 'saved'
        && !(p.document.export && p.document.publishedFragments?.includes(p.document.export.fragment))) {
        actions.push(researchButton(['writing', 'unknown'].includes(p.document.export?.status ?? '') ? '核对文档写入' : '将成果追加到关联文档', { ...value, action: 'export' }));
    }
    const elements = [
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
    }
    else {
        elements.push(researchButton('基于成果继续任务', { ...value, action: 'continue' }, true));
        if (['completed', 'cancelled'].includes(p.status)) {
            elements.push(researchButton(p.archivedAt ? '移回任务列表' : '归档任务', { ...value, action: p.archivedAt ? 'unarchive' : 'archive' }));
        }
    }
    return researchCard(p.title, elements);
}
export function evidenceCard(p, directionId, index) {
    const d = p.directions.find(d => d.id === directionId);
    const f = d?.findings[index];
    if (!d || !f) {
        throw new Error('该发现不存在，请刷新项目。');
    }
    return researchCard(d.title, [
        text(`发现 ${index + 1}/${d.findings.length} · ${f.kind === 'fact' ? '来源事实' : f.kind === 'inference' ? '推断' : '尚不确定'}\n${f.claim}`),
        ...f.sources.map(s => text(`${s.title}\n${s.location}\n${s.excerpt}`)),
        text(`分歧与限制\n${f.caveat || '未记录额外说明；仍需结合来源判断。'}`),
        ...(index + 1 < d.findings.length ? [researchButton('下一项发现', { project: p.id, action: 'evidence', direction: d.id, index: index + 1 })] : []),
        ...(['completed', 'cancelled'].includes(p.status) ? [researchButton('基于这项发现继续任务', { project: p.id, action: 'continue-finding', direction: d.id, index }, true)] : []),
        researchButton('返回任务', { project: p.id, action: 'open' }),
    ]);
}
export function historyCard(p, offset) {
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
export function indexCard(projects, nonce, offset = 0, archived = false, context = {}) {
    return researchCard(archived ? '项目 · 归档任务' : '项目 · 工作空间与任务', [
        group([text(context.workingDir ? `当前项目工作目录\n${context.workingDir}` : context.error ?? '尚未关联项目工作目录'),
            text('使用 /project use <目录> 切换，/project reset 返回默认目录，/project info 查看详情。切换不影响已建立的任务。')]),
        group([text('下面是你在本会话的任务，包含其他目录及未关联的历史任务。每项任务可独立查看证据、调整方向或暂停，控制由创建者操作。'),
            { tag: 'div', text: { ...plain('可关联一份新版飞书文档，在执行检查点同步文字正文与评论。任务完成后可选择追加成果；未关联的链接不会自动同步。'), text_size: 'notation', text_color: 'grey' } }]),
        group([
            researchButton(archived ? '返回任务列表' : '查看归档任务', { action: 'index', archived: !archived }),
            ...projects.slice(offset, offset + 6).flatMap(p => [text(`${p.title} · ${labels[p.status]}\n${p.projectLink ? `关联项目：${p.projectLink.directory}（保留独立执行目录）` : p.workingDir ? `工作目录：${p.workingDir}${p.workingDir === context.workingDir ? '（当前项目）' : ''}` : '历史任务 · 未关联项目目录'}`), researchButton('打开任务', { project: p.id, action: 'open' })]),
            ...(projects.length > offset + 6 ? [researchButton('更多任务', { action: 'index', offset: offset + 6, archived })] : []),
        ]),
        ...(!context.error ? [text('新任务使用提交表单时的当前项目目录。建立后先展示目录与范围，点击开始才会执行。'), { tag: 'form', name: 'research_create', elements: [
                    { tag: 'input', name: 'question', required: true, placeholder: plain('希望完成什么任务？（180 字以内）') },
                    { tag: 'input', name: 'scope', placeholder: plain('任务范围、约束与希望得到的成果') },
                    { tag: 'input', name: 'materials', placeholder: plain('已有材料、来源链接或摘录') },
                    { tag: 'input', name: 'document_url', placeholder: plain('可选：关联的飞书 /docx/ 文档链接（需应用有读取权限）') },
                    submitButton('建立任务', { action: 'create', nonce }),
                ] }] : []),
    ]);
}
export function projectLinkPreviewCard(p) {
    if (!p.linkPreview) {
        throw new Error('项目关联预览已失效。');
    }
    return researchCard('确认历史任务的项目关联', [
        text(p.title), text(`目标项目目录\n${p.linkPreview.directory}`),
        text('此次只将历史任务显示为该项目的关联任务。任务身份、已有发现、文档和独立执行目录保留，不移动或复制文件，不重跑已完成工作。可从任务卡片撤销关联。从该成果继续的任务继承项目归属，仍使用各自的独立执行目录。'),
        researchButton('确认关联', { project: p.id, revision: p.revision, token: p.linkPreview.token, action: 'confirm-project-link' }, true),
        researchButton('暂不关联，返回任务', { project: p.id, action: 'open' }),
    ]);
}
