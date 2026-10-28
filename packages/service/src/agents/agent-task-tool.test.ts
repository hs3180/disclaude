import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
// Exercise the Harness validator without adding a public API solely for tests.
import { prepareTools } from '../../../core/dist/sdk/tools.js';
import { createAgentTaskTool, type AgentTaskToolBinding } from './agent-task-tool.js';
import type { AgentTaskHandle, AgentTaskRequest, AgentTaskResult } from './agent-task-runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); } });
const result = (id = 'child-1'): AgentTaskResult => ({ id, outcome: 'succeeded', text: 'actual result', truncated: false });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-task-tool-')); roots.push(dir);
  const root = join(dir, 'project'), outside = join(dir, 'outside');
  mkdirSync(root); mkdirSync(join(root, 'sub')); mkdirSync(outside);
  symlinkSync(outside, join(root, 'outside-link'), 'dir');
  symlinkSync(join(root, 'sub'), join(root, 'sub-alias'), 'dir');
  const callbacks = { sendMessage: vi.fn().mockResolvedValue('real-channel-receipt'), sendFile: vi.fn(), sendCard: vi.fn() };
  const binding: AgentTaskToolBinding = { projectRoot: root, callbacks,
    source: { chatId: 'actual-chat', sourceMessageId: 'actual-source', senderOpenId: 'actual-actor', threadRootId: 'actual-topic' } };
  const start = vi.fn<(request: AgentTaskRequest) => AgentTaskHandle>().mockImplementation(() => ({
    id: 'child-1', completion: Promise.resolve(result()), stop: vi.fn(),
  }));
  return { root, outside, binding, callbacks, start };
}
const args = { operationId: 'execute_1', task: 'Implement the explicit subtask', workingDirectory: 'sub' };
const context = () => ({ signal: new AbortController().signal });

it('freezes real source, Project and callbacks outside the model schema', async () => {
  const f = fixture(); const originalSend = f.callbacks.sendMessage;
  const raw = createAgentTaskTool({ start: f.start }, f.binding);
  const tool = prepareTools([raw])[0]!;
  f.binding.source.senderOpenId = 'changed-actor'; f.binding.projectRoot = f.outside;
  f.callbacks.sendMessage = vi.fn();
  await expect(tool.execute(args, context())).resolves.toEqual(result());
  expect(f.start).toHaveBeenCalledWith(expect.objectContaining({
    chatId: 'actual-chat', sourceMessageId: 'actual-source', senderOpenId: 'actual-actor', threadRootId: 'actual-topic',
    workingDirectory: realpathSync(join(f.root, 'sub')), task: args.task,
  }), expect.objectContaining({ sendMessage: originalSend }));
  expect(JSON.stringify([raw.description, raw.inputSchema])).not.toContain('actual-actor');
});

it.each(['../outside', 'outside-link', '/'] )('rejects a directory outside its Project: %s', async directory => {
  const f = fixture(); const tool = prepareTools([createAgentTaskTool({ start: f.start }, f.binding)])[0]!;
  await expect(tool.execute({ ...args, workingDirectory: directory }, context())).rejects.toThrow();
  expect(f.start).not.toHaveBeenCalled();
});

it('rejects forged identity and invalid arguments even without a Harness validator', async () => {
  const f = fixture(); const raw = createAgentTaskTool({ start: f.start }, f.binding);
  for (const tool of [raw, prepareTools([raw])[0]!]) {
    await expect(tool.execute({ ...args, senderOpenId: 'forged' }, context())).rejects.toThrow();
    await expect(tool.execute({ ...args, task: ' ' }, context())).rejects.toThrow();
    await expect(tool.execute({ ...args, workingDirectory: 'missing' }, context())).rejects.toThrow();
  }
  expect(f.start).not.toHaveBeenCalled();
  expect(() => createAgentTaskTool({ start: f.start }, { ...f.binding, source: { ...f.binding.source, senderOpenId: '' } })).toThrow('trusted');
});

it('joins in-flight and completed retries, including directory aliases, without replay', async () => {
  const f = fixture(); let finish!: (value: AgentTaskResult) => void;
  f.start.mockReturnValue({ id: 'child-1', completion: new Promise(resolve => { finish = resolve; }), stop: vi.fn() });
  const tool = prepareTools([createAgentTaskTool({ start: f.start }, f.binding)])[0]!;
  const first = tool.execute(args, context());
  const second = tool.execute({ ...args, workingDirectory: 'sub-alias' }, context());
  expect(f.start).toHaveBeenCalledTimes(1); finish(result());
  expect(await Promise.all([first, second])).toEqual([result(), result()]);
  await expect(tool.execute(args, context())).resolves.toEqual(result());
  await expect(tool.execute({ ...args, task: 'different work' }, context())).rejects.toThrow('different work');
  await expect(tool.execute({ ...args, workingDirectory: '.' }, context())).rejects.toThrow('different work');
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('cancels only its operation and awaits that same handle', async () => {
  const f = fixture(); const a = new AbortController(), b = new AbortController();
  const pending: Array<{ stop: ReturnType<typeof vi.fn>; finish: (value: AgentTaskResult) => void }> = [];
  f.start.mockImplementation(() => {
    let finish!: (value: AgentTaskResult) => void;
    const completion = new Promise<AgentTaskResult>(resolve => { finish = resolve; });
    const stop = vi.fn(); pending.push({ stop, finish });
    return { id: `child-${  pending.length}`, completion, stop };
  });
  const tool = prepareTools([createAgentTaskTool({ start: f.start }, f.binding)])[0]!;
  const first = tool.execute(args, { signal: a.signal }).catch(error => error);
  const second = tool.execute({ ...args, operationId: 'execute_2' }, { signal: b.signal });
  let settled = false; void first.then(() => { settled = true; });
  a.abort(); expect(pending[0]!.stop).toHaveBeenCalledTimes(1); expect(pending[1]!.stop).not.toHaveBeenCalled();
  await Promise.resolve(); expect(settled).toBe(false);
  pending[0]!.finish({ ...result(), outcome: 'stopped' }); expect(await first).toBeInstanceOf(Error);
  pending[1]!.finish(result('child-2')); await expect(second).resolves.toEqual(result('child-2'));
});

it('does not admit a task for a pre-aborted invocation', async () => {
  const f = fixture(); const abort = new AbortController(); abort.abort();
  const tool = createAgentTaskTool({ start: f.start }, f.binding);
  await expect(tool.execute(args, { signal: abort.signal })).rejects.toThrow();
  expect(f.start).not.toHaveBeenCalled();
});

it('retains retry identities at the result limit and leaves existing work untouched', async () => {
  const f = fixture(); const tool = prepareTools([createAgentTaskTool({ start: f.start }, f.binding)])[0]!;
  for (let i = 0; i < 256; i++) { await tool.execute({ ...args, operationId: `operation_${  i}` }, context()); }
  await expect(tool.execute({ ...args, operationId: 'new_operation' }, context())).rejects.toThrow('registry is full');
  await expect(tool.execute({ ...args, operationId: 'operation_0' }, context())).resolves.toEqual(result());
  expect(f.start).toHaveBeenCalledTimes(256);
});
