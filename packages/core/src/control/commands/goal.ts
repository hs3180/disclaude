import type { GoalRecord } from '../../goals/goal-store.js';
import type { CommandHandler } from '../types.js';

const usage = '`/goal <目标> | <验收要求1> | <验收要求2>` 直接启动执行（需启用原生执行器；未写验收要求时以目标本身为验收）。停止执行请直接使用 `/stop`。';
const labels = { draft: '草稿（尚未启动）', active: '已激活', paused: '已暂停', blocked: '有阻塞', completed: '已完成', abandoned: '已停止' };
function format(goal: GoalRecord): string {
  return [`**Goal ${goal.id}** · 版本 ${goal.revision} · ${labels[goal.status]}`, goal.objective,
    '', '**验收要求**', ...goal.acceptance.map((item, i) => `${i + 1}. ${item}`),
    ...(goal.progress ? ['', '**进展**', goal.progress] : []),
    ...(goal.artifacts.length ? ['', '**产物**', ...goal.artifacts.map(item => `- ${item}`)] : []),
  ].join('\n');
}

/** Single-entry launch: `/goal <prompt>` saves the record and activates it in one step. */
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
  const parts = args.join(' ').split('|').map(part => part.trim());
  if (parts.length > 101 || parts.some(part => !part)) { return { success: false, message: usage }; }
  if (!context.goalExecution) {
    return { success: false, message: '当前入口尚未启用 Goal 原生执行器，未启动执行。' };
  }
  const { sourceMessageId, threadRootId } = command;
  if (typeof sourceMessageId !== 'string' || !sourceMessageId.trim()) {
    return { success: false, message: '缺少原始消息上下文，请在聊天中直接发送 Goal 命令。' };
  }
  const resolution = project.resolveCwd(chatId);
  if (resolution.reason === 'bound-missing') {
    return { success: false, message: '绑定的项目目录暂不可用，未启动执行。请先恢复目录后重试。' };
  }
  const projectRoot = resolution.boundWorkingDir ?? project.getWorkspaceDir();
  try {
    const [objective, ...rest] = parts;
    const draft = await store.create({ chatId, projectRoot, objective,
      acceptance: rest.length > 0 ? rest : [objective] });
    const request = { goalId: draft.id, expectedRevision: draft.revision, chatId, projectRoot,
      actorId, sourceMessageId, ...(threadRootId ? { threadRootId } : {}) };
    const { record } = await context.goalExecution.start(request, 'activate');
    if (record.id !== draft.id || record.chatId !== chatId || record.projectRoot !== projectRoot) {
      throw new Error('Unexpected Goal scope');
    }
    return { success: true, message: `已启动 Goal；停止请使用 /stop。\n\n${format(record)}` };
  } catch {
    context.logger?.warn({ chatId }, 'Goal launch could not be confirmed');
    return { success: false, message: 'Goal 启动未成功确认；可重试或联系维护者核查执行与存储。' };
  }
};
