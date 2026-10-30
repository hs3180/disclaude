import { GoalRevisionConflictError, type GoalRecord } from '../../goals/goal-store.js';
import type { CommandHandler } from '../types.js';

const usage = [
  '`/goal <目标> | <验收要求1> | <验收要求2>` 直接启动执行（需启用原生执行器；未写验收要求时以目标本身为验收）',
  '`/goal list [页码]` 查看本聊天当前项目的目标',
  '`/goal show <ID>` 查看目标、版本及验收要求',
  '`/goal create <目标> | <验收要求1> | <验收要求2>` 仅保存草稿',
  '`/goal edit <ID> <版本> <目标> | <验收要求1> | <验收要求2>` 修订目标和验收要求',
  '停止执行请直接使用 `/stop`',
].join('\n');
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const labels = { draft: '草稿（尚未启动）', active: '已激活', paused: '已暂停', blocked: '有阻塞', completed: '已完成', abandoned: '已停止' };
function format(goal: GoalRecord): string {
  return [`**Goal ${goal.id}** · 版本 ${goal.revision} · ${labels[goal.status]}`, goal.objective,
    '', '**验收要求**', ...goal.acceptance.map((item, i) => `${i + 1}. ${item}`),
    ...(goal.progress ? ['', '**进展**', goal.progress] : []),
    ...(goal.artifacts.length ? ['', '**产物**', ...goal.artifacts.map(item => `- ${item}`)] : []),
  ].join('\n');
}

/** Chat-wide records scoped to the currently selected Project, with no implicit activation. */
export const handleGoal: CommandHandler<'goal'> = async (command, context) => {
  const store = context.goalStore; const project = context.projectManager;
  if (!store || !project) { return { success: false, message: '当前入口未启用 Goal 记录。' }; }
  if (typeof command.actorId !== 'string' || !command.actorId.trim()) {
    return { success: false, message: '无法核对用户身份，请在聊天中直接发送 /goal 命令。' };
  }
  const { chatId, actorId } = command;
  const args = command.data?.args ?? [];
  if (!Array.isArray(args) || args.length > 2048 || !args.every(item => typeof item === 'string')) {
    return { success: false, message: usage };
  }
  const [action = 'list', id] = args;
  const resolution = project.resolveCwd(chatId);
  const projectRoot = resolution.boundWorkingDir ?? project.getWorkspaceDir();
  const belongs = (record: GoalRecord) => record.chatId === chatId && record.projectRoot === projectRoot;
  try {
    if (action === 'list') {
      const page = args[1] === undefined ? 1 : Number(args[1]);
      if (args.length > 2 || !Number.isSafeInteger(page) || page < 1) { return { success: false, message: usage }; }
      const records: GoalRecord[] = [];
      let unreadable = false;
      for (const identity of await store.listIds()) {
        try { const record = await store.get(identity); if (record && belongs(record)) { records.push(record); } }
        catch { unreadable = true; context.logger?.warn({ goalId: identity }, 'Unreadable Goal record omitted from listing'); }
      }
      records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      const selected = records.slice((page - 1) * 20, page * 20);
      const message = records.length === 0 ? `当前聊天和项目尚无可读取的 Goal。\n\n${usage}`
        : [`**Goal · 第 ${page} 页 · 共 ${records.length} 项**`,
          ...selected.map(record => `${record.id} · 版本 ${record.revision} · ${labels[record.status]}\n${record.objective.slice(0, 120)}`),
          ...(page * 20 < records.length ? [`下一页：/goal list ${page + 1}`] : []),
        ].join('\n\n');
      return { success: !unreadable, message: message + (unreadable ? '\n\n部分 Goal 记录暂不可读取，请联系维护者核查。' : '') };
    }
    if (action !== 'list' && action !== 'show' && action !== 'create' && action !== 'edit') {
      // Single-entry launch (review #5603 direction): `/goal <prompt>` saves the
      // record and activates it in one step; stopping reuses /stop.
      const parts = args.join(' ').split('|').map(part => part.trim());
      if (parts.length > 101 || parts.some(part => !part)) { return { success: false, message: usage }; }
      if (!context.goalExecution) {
        return { success: false, message: '当前入口尚未启用 Goal 原生执行器，未启动执行；可用 /goal create 保存草稿。' };
      }
      const { sourceMessageId, threadRootId } = command;
      if (typeof sourceMessageId !== 'string' || !sourceMessageId.trim()) {
        return { success: false, message: '缺少原始消息上下文，请在聊天中直接发送 Goal 命令。' };
      }
      if (resolution.reason === 'bound-missing') {
        return { success: false, message: '绑定的项目目录暂不可用，未启动执行。请先恢复目录；草稿查看与修订不受影响。' };
      }
      const [objective, ...rest] = parts;
      const draft = await store.create({ chatId, projectRoot, objective,
        acceptance: rest.length > 0 ? rest : [objective] });
      const request = { goalId: draft.id, expectedRevision: draft.revision, chatId, projectRoot,
        actorId, sourceMessageId, ...(threadRootId ? { threadRootId } : {}) };
      const { record } = await context.goalExecution.start(request, 'activate');
      if (record.id !== draft.id || !belongs(record)) { throw new Error('Unexpected Goal scope'); }
      return { success: true, message: `已启动 Goal；停止请使用 /stop。\n\n${format(record)}` };
    }
    if (action !== 'create' && (!id || !idPattern.test(id))) { return { success: false, message: usage }; }
    if (action === 'show') {
      if (args.length !== 2) { return { success: false, message: usage }; }
      const record = await store.get(id);
      return record && belongs(record) ? { success: true, message: format(record) }
        : { success: false, message: '当前聊天和项目中找不到此 Goal。' };
    }
    const revision = action === 'edit' ? Number(args[2]) : undefined;
    const parts = args.slice(action === 'create' ? 1 : 3).join(' ').split('|').map(part => part.trim());
    if (parts.length < 2 || parts.length > 101 || parts.some(part => !part)
      || (action === 'edit' && (!Number.isSafeInteger(revision) || (revision as number) < 1))) { return { success: false, message: usage }; }
    const [objective, ...acceptance] = parts;
    if (action === 'create') {
      const record = await store.create({ chatId, projectRoot, objective, acceptance });
      return { success: true, message: `已保存 Goal 草稿，尚未启动执行。\n\n${format(record)}` };
    }
    const previous = await store.get(id);
    if (!previous || !belongs(previous)) { return { success: false, message: '当前聊天和项目中找不到此 Goal。' }; }
    if (previous.status === 'completed' || previous.status === 'abandoned') {
      return { success: false, message: '此 Goal 已完成或停止，未修改；如有新目标请明确创建草稿。' };
    }
    const revised = await store.update(id, revision as number, { objective, acceptance });
    return { success: true, message: `已修订 Goal。\n\n${format(revised)}` };
  } catch (error) {
    if (error instanceof GoalRevisionConflictError) {
      return { success: false, message: `Goal 已有更新，未覆盖新内容。请先用 /goal show ${id} 查看最新版本，再提交操作。` };
    }
    context.logger?.warn({ action }, 'Goal record command could not be confirmed');
    return { success: false, message: 'Goal 操作未成功确认。请先用 /goal list 或 /goal show 核对状态，再联系维护者检查执行与存储。' };
  }
};
