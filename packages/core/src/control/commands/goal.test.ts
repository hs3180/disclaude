import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
  it('treats former subcommand words as plain goal text — only start and /stop remain', async () => {
    const { invoke, store } = await executableFixture();
    for (const args of [['list'], ['show', 'some-id'], ['create', 'Write', '|', 'Evidence'], ['edit', 'some-id', '1', 'Write', '|', 'Evidence']]) {
      expect((await invoke(args)).success).toBe(true);
    }
    const objectives = (await Promise.all((await store.listIds()).map(id => store.get(id)))).map(record => record!.objective);
    expect(objectives.sort()).toEqual(['create Write', 'edit some-id 1 Write', 'list', 'show some-id']);
  });
  it('refuses to launch when no native executor is configured and saves nothing', async () => {
    const { invoke, store } = await fixture();
    const response = await invoke([...description]);
    expect(response.message).toContain('尚未启用');
    expect(await store.listIds()).toEqual([]);
  });
  it('does not expose the Goal command when the host does not explicitly wire a user-channel store', async () => {
    const { context, invoke, store } = await fixture(); delete context.goalStore;
    expect((await invoke([...description])).message).toContain('当前不可用');
    const help = await createControlHandler(context)({ type: 'help', chatId: 'chat' });
    expect(help.message).not.toContain('`/goal'); expect(await store.listIds()).toEqual([]);
  });
  it('requires channel source context, ignores source/actor claims in arguments and keeps topic metadata', async () => {
    const { dispatch, execution } = await executableFixture();
    const data = { args: [...description], sourceMessageId: 'forged', actorId: 'forged' };
    expect((await dispatch(createControlCommand('goal', 'chat', data, { actorId: 'actual-user' }))).message).toContain('原始消息上下文');
    expect(execution.start).not.toHaveBeenCalled();
    expect((await dispatch(createControlCommand('goal', 'chat', data, { actorId: 'actual-user', sourceMessageId: 'om-real', threadRootId: 'om-topic' }))).success).toBe(true);
    expect(execution.start).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'actual-user', sourceMessageId: 'om-real', threadRootId: 'om-topic' }), 'activate');
  });
  it('requires actual channel actor context and honors host command policy before touching storage', async () => {
    const { context, dispatch, store, execution } = await executableFixture();
    const missingActor = createControlCommand('goal', 'chat', { args: [...description] }, { chatType: 'group', sourceMessageId: 'actual-source', actorId: undefined as unknown as string });
    expect((await dispatch(missingActor)).message).toContain('用户身份');
    expect(await store.listIds()).toEqual([]);
    context.isCommandAllowed = () => false;
    expect((await dispatch(createControlCommand('goal', 'chat', { args: [...description] }, { actorId: 'actual-user', chatType: 'group', sourceMessageId: 'actual-source' }))).message).toContain('权限');
    expect(execution.start).not.toHaveBeenCalled();
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
  it('rejects empty prompt segments without saving', async () => {
    const { invoke, store, execution } = await executableFixture();
    for (const args of [[''], ['objective', '|', ''], ['|', 'only acceptance']]) {
      expect((await invoke(args)).success).toBe(false);
    }
    expect(await store.listIds()).toEqual([]); expect(execution.start).not.toHaveBeenCalled();
  });
});
