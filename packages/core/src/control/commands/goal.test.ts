import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalStore } from '../../goals/goal-store.js';
import { ProjectManager } from '../../project/project-manager.js';
import { createControlHandler } from '../handler.js';
import { createControlCommand } from '../normalize.js';
import type { ControlHandlerContext } from '../types.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'disclaude-goal-command-')); roots.push(root);
  const store = new GoalStore(join(root, 'goals'));
  const project = new ProjectManager({ workspaceDir: root });
  const context: ControlHandlerContext = { goalStore: store, projectManager: project,
    agentPool: { reset: vi.fn(), stop: vi.fn() },
    debugGroups: { getDebugGroup: () => null, setDebugGroup: vi.fn(), clearDebugGroup: () => null },
  };
  const dispatch = createControlHandler(context);
  const invoke = (args: string[], chatId = 'chat') => dispatch(createControlCommand('goal', chatId, { args }, { actorId: 'actual-user', chatType: 'group', sourceMessageId: 'actual-source' }));
  return { root, store, project, context, dispatch, invoke };
}
const description = ['Write the revised report', '|', 'Cite original evidence', '|', 'Record remaining acceptance'];

describe('explicit chat Goal record commands (#5212)', () => {
  it('creates only a draft, displays its ID/version/criteria and persists edits without starting an agent', async () => {
    const { store, context, invoke } = await fixture();
    const created = await invoke(['create', ...description]);
    expect(created.success).toBe(true); expect(created.message).toContain('尚未启动');
    const [id] = await store.listIds();
    const draft = await new GoalStore(store.directory).get(id);
    expect(draft).toMatchObject({ status: 'draft', revision: 1, chatId: 'chat', objective: description[0], acceptance: [description[2], description[4]] });
    expect(created.message).toContain(id);
    const edited = await invoke(['edit', id, '1', 'Changed direction', '|', 'Use latest user feedback']);
    expect(edited.success).toBe(true);
    const shown = await invoke(['show', id]);
    expect(shown.message).toContain('版本 2'); expect(shown.message).toContain('Use latest user feedback');
    expect((await new GoalStore(store.directory).get(id))?.status).toBe('draft');
    expect(context.agentPool.reset).not.toHaveBeenCalled(); expect(context.agentPool.stop).not.toHaveBeenCalled();
  });
  it('cannot read, list or edit another chat or another selected Project', async () => {
    const { root, store, project, invoke } = await fixture(); await invoke(['create', ...description]);
    const [id] = await store.listIds(); const original = await store.get(id);
    expect((await invoke(['show', id], 'other-chat')).message).toContain('找不到');
    expect((await invoke(['list'], 'other-chat')).message).not.toContain(description[0]);
    expect((await invoke(['edit', id, '1', 'overwrite', '|', 'bad'], 'other-chat')).success).toBe(false);
    const other = join(root, 'other-project'); await mkdir(other); expect(project.use('chat', other).ok).toBe(true);
    expect((await invoke(['show', id])).message).toContain('找不到');
    expect((await invoke(['list'])).message).not.toContain(id);
    expect((await invoke(['edit', id, '1', 'overwrite', '|', 'bad'])).success).toBe(false);
    expect(await store.get(id)).toEqual(original);
  });
  it('requires actual channel actor context and honors host command policy before touching storage', async () => {
    const { context, dispatch, store } = await fixture();
    const missingActor = createControlCommand('goal', 'chat', { args: ['create', ...description], actorId: 'forged-in-arguments' });
    expect((await dispatch(missingActor)).message).toContain('用户身份');
    context.isCommandAllowed = () => false;
    expect((await dispatch({ ...missingActor, actorId: 'actual-user' })).message).toContain('权限');
    expect(await store.listIds()).toEqual([]);
  });
  it('does not expose Goal commands when the host does not explicitly wire a user-channel store', async () => {
    const { context, invoke, store } = await fixture(); delete context.goalStore;
    expect((await invoke(['create', ...description])).message).toContain('当前不可用');
    const help = await createControlHandler(context)({ type: 'help', chatId: 'chat' });
    expect(help.message).not.toContain('`/goal'); expect(await store.listIds()).toEqual([]);
  });
  it('refuses stale feedback instead of replacing newer user requirements', async () => {
    const { store, invoke } = await fixture(); await invoke(['create', ...description]);
    const [id] = await store.listIds();
    expect((await invoke(['edit', id, '1', 'New goal', '|', 'New requirement'])).success).toBe(true);
    const stale = await invoke(['edit', id, '1', 'Old goal', '|', 'Old requirement']);
    expect(stale.success).toBe(false); expect(stale.message).toContain('未覆盖');
    expect((await store.get(id))?.acceptance).toEqual(['New requirement']);
  });
  it('never activates, completes or creates a Goal from malformed/unknown commands', async () => {
    const { store, invoke } = await fixture();
    for (const args of [['activate'], ['complete'], ['create', 'no acceptance'], ['create', 'goal', '|', ''], ['show', '../private'], ['list', 'NaN']]) {
      expect((await invoke(args)).success).toBe(false);
    }
    expect(await store.listIds()).toEqual([]);
  });
  it('keeps records readable after their bound Project disappears and never switches to a fallback Project', async () => {
    const { root, store, project, invoke } = await fixture(); const selected = join(root, 'selected'); await mkdir(selected);
    project.use('chat', selected); await invoke(['create', ...description]); const [id] = await store.listIds();
    await rm(selected, { recursive: true });
    expect((await invoke(['show', id])).success).toBe(true);
    expect((await store.get(id))?.projectRoot).toBe(selected);
  });
  it('reports unreadable records without leaking their contents or overwriting them', async () => {
    const { store, invoke } = await fixture(); await invoke(['create', ...description]);
    const [id] = await store.listIds(); const file = join(store.directory, `${id}.json`);
    await writeFile(file, 'private-corrupt-body');
    const listing = await invoke(['list']); const shown = await invoke(['show', id]);
    expect(listing.success).toBe(false); expect(listing.message).toContain('不可读取');
    expect(shown.success).toBe(false); expect(shown.message).not.toMatch(/private-corrupt-body|disclaude-goal-command/);
    expect(await readFile(file, 'utf8')).toBe('private-corrupt-body');
  });
  it('paginates only in-scope records and leaves terminal goals unchanged', async () => {
    const { root, store, invoke } = await fixture();
    for (let i = 0; i < 21; i++) { await store.create({ chatId: 'chat', projectRoot: root, objective: `Report ${i}`, acceptance: ['Evidence'] }); }
    await store.create({ chatId: 'another', projectRoot: root, objective: 'Never list another chat', acceptance: ['Private'] });
    expect((await invoke(['list'])).message).toContain('共 21 项');
    expect((await invoke(['list', '2'])).message).toContain('第 2 页');
    expect((await invoke(['list'])).message).not.toContain('Never list another chat');
    const [id] = await store.listIds(); const record = (await store.get(id))!;
    // A persisted terminal assessment is supplied by the later runtime adapter.
    await writeFile(join(store.directory, `${id}.json`), JSON.stringify({ ...record, chatId: 'chat', status: 'completed' }));
    expect((await invoke(['edit', id, '1', 'reopen', '|', 'new work'])).message).toContain('已完成或停止');
    expect((await store.get(id))?.status).toBe('completed');
  });
});


describe('single-entry Goal launch via /goal <prompt> (#5212)', () => {
  async function executableFixture() {
    const result = await fixture();
    const execution: NonNullable<ControlHandlerContext['goalExecution']> = {
      start: vi.fn(async (request, action) => ({ record: await result.store.control(request.goalId, request.expectedRevision, action) })),
      control: vi.fn(async (request, action) => ({ record: await result.store.control(request.goalId, request.expectedRevision, action) })),
    };
    result.context.goalExecution = execution;
    return { ...result, execution };
  }
  it('saves and activates a new Goal from the prompt in one step with captured source', async () => {
    const { invoke, store, execution, root } = await executableFixture();
    const response = await invoke([...description]);
    expect(response.success).toBe(true); expect(response.message).toContain('已启动 Goal'); expect(response.message).toContain('/stop');
    const [id] = await store.listIds();
    expect(await store.get(id)).toMatchObject({ status: 'active', revision: 2, chatId: 'chat',
      objective: description[0], acceptance: [description[2], description[4]] });
    expect(execution.start).toHaveBeenCalledWith({ goalId: id, expectedRevision: 1, actorId: 'actual-user',
      chatId: 'chat', projectRoot: root, sourceMessageId: 'actual-source' }, 'activate');
    expect(response.message).toContain(id);
  });
  it('treats a single-segment prompt as its own acceptance criterion', async () => {
    const { invoke, store } = await executableFixture();
    expect((await invoke(['Summarize the weekly report'])).success).toBe(true);
    const [id] = await store.listIds();
    expect(await store.get(id)).toMatchObject({ objective: 'Summarize the weekly report', acceptance: ['Summarize the weekly report'], status: 'active' });
  });
  it('refuses to launch when no native executor is configured and saves nothing', async () => {
    const { invoke, store } = await fixture();
    const response = await invoke([...description]);
    expect(response.message).toContain('尚未启用');
    expect(await store.listIds()).toEqual([]);
  });
  it('requires channel source context, ignores source/actor claims in arguments and keeps topic metadata', async () => {
    const { dispatch, execution } = await executableFixture();
    const data = { args: [...description], sourceMessageId: 'forged', actorId: 'forged' };
    expect((await dispatch(createControlCommand('goal', 'chat', data, { actorId: 'actual-user' }))).message).toContain('原始消息上下文');
    expect(execution.start).not.toHaveBeenCalled();
    expect((await dispatch(createControlCommand('goal', 'chat', data, { actorId: 'actual-user', sourceMessageId: 'om-real', threadRootId: 'om-topic' }))).success).toBe(true);
    expect(execution.start).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'actual-user', sourceMessageId: 'om-real', threadRootId: 'om-topic' }), 'activate');
  });
  it('blocks launch for a missing Project directory', async () => {
    const { root, project, invoke, store, execution } = await executableFixture();
    const selected = join(root, 'selected'); await mkdir(selected);
    project.use('chat', selected);
    await rm(selected, { recursive: true });
    const response = await invoke(['Relaunch after restore', '|', 'Directory exists']);
    expect(response.success).toBe(false); expect(response.message).toContain('目录暂不可用');
    expect(execution.start).not.toHaveBeenCalled(); expect(await store.listIds()).toEqual([]);
  });
  it('reports execution failures without revealing private errors and leaves the record a draft', async () => {
    const { invoke, store, context } = await executableFixture();
    context.goalExecution!.start = vi.fn().mockRejectedValue(new Error('private-path and credentials'));
    const response = await invoke([...description]);
    expect(response.success).toBe(false); expect(response.message).toContain('未成功确认');
    expect(response.message).not.toContain('private-path');
    const [id] = await store.listIds(); expect((await store.get(id))?.status).toBe('draft');
  });
  it('honors host policy before launching and rejects empty prompt segments without saving', async () => {
    const { context, invoke, store, execution } = await executableFixture(); context.isCommandAllowed = () => false;
    expect((await invoke([...description])).message).toContain('权限'); expect(execution.start).not.toHaveBeenCalled();
    context.isCommandAllowed = undefined;
    for (const args of [[''], ['objective', '|', ''], ['|', 'only acceptance']]) {
      expect((await invoke(args)).success).toBe(false);
    }
    expect(await store.listIds()).toEqual([]);
  });
});
