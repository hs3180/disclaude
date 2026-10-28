import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolDefinition } from '@disclaude/core';
import type { AgentTaskRequest, AgentTaskRunner } from './agent-task-runner.js';
import type { ChatAgentCallbacks } from './types.js';

export interface AgentTaskToolBinding {
  source: Omit<AgentTaskRequest, 'task' | 'workingDirectory'>;
  projectRoot: string;
  callbacks: ChatAgentCallbacks;
}

/** One trusted originating request, with retry identity retained for this tool's
 * lifetime. The host must authorize/freeze the source before constructing it;
 * neither identity nor runtime permissions are accepted from model arguments.
 */
export function createAgentTaskTool(
  runner: Pick<AgentTaskRunner, 'start'>,
  binding: AgentTaskToolBinding,
): ToolDefinition {
  const source = structuredClone(binding.source);
  if (![source.chatId, source.sourceMessageId, source.senderOpenId]
    .every(value => typeof value === 'string' && !!value.trim() && value.length <= 512)
    || !isAbsolute(binding.projectRoot)) { throw new Error('Agent task tool requires a trusted source and Project'); }
  const root = realpathSync(binding.projectRoot);
  if (!statSync(root).isDirectory()) { throw new Error('Agent task Project must exist'); }
  const callbacks = { ...binding.callbacks };
  const operations = new Map<string, { task: string; directory: string; handle: ReturnType<AgentTaskRunner['start']> }>();
  return {
    name: 'run_agent_task',
    description: 'Run an explicit independent subtask in an existing subdirectory of this Project; use workingDirectory="." for its root. Await its real result. Reuse operationId for an uncertain retry, and inspect failed/stopped partial results before requesting new work. Execution success is not Goal acceptance.',
    inputSchema: { type: 'object', properties: {
      operationId: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' },
      task: { type: 'string', minLength: 1, maxLength: 64_000 },
      workingDirectory: { type: 'string', minLength: 1, maxLength: 4096 },
    }, required: ['operationId', 'task', 'workingDirectory'], additionalProperties: false },
    outputSchema: { type: 'object', properties: {
      id: { type: 'string' }, outcome: { type: 'string', enum: ['succeeded', 'failed', 'stopped'] },
      text: { type: 'string', maxLength: 65_536 }, truncated: { type: 'boolean' }, error: { type: 'string' },
    }, required: ['id', 'outcome', 'text', 'truncated'], additionalProperties: false },
    execute: async (input, context) => {
      context.signal.throwIfAborted();
      if (Object.keys(input).some(key => !['operationId', 'task', 'workingDirectory'].includes(key))
        || typeof input.operationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.operationId)
        || typeof input.task !== 'string' || !input.task.trim() || input.task.length > 64_000
        || typeof input.workingDirectory !== 'string' || !input.workingDirectory.trim()
        || input.workingDirectory.length > 4096 || isAbsolute(input.workingDirectory)) {
        throw new Error('Invalid agent task tool arguments');
      }
      // Canonicalize before containment checks, including symlinks. A later
      // Project switch cannot redirect this already-bound originating request.
      const directory = realpathSync(resolve(root, input.workingDirectory));
      const path = relative(root, directory);
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
        || !statSync(directory).isDirectory()) { throw new Error('Agent task directory must be inside its bound Project'); }
      let operation = operations.get(input.operationId);
      if (operation && (operation.task !== input.task || operation.directory !== directory)) {
        throw new Error('Agent task operationId already belongs to different work');
      }
      if (!operation) {
        // Bound retained results rather than forgetting retry identities and
        // accidentally replaying them. This does not stop any existing work.
        if (operations.size >= 256) { throw new Error('Agent task result registry is full; reconcile its existing operations'); }
        const handle = runner.start({ ...source, task: input.task, workingDirectory: directory }, callbacks);
        operation = { task: input.task, directory, handle };
        operations.set(input.operationId, operation);
      }
      const { handle } = operation;
      const stop = (): void => handle.stop();
      context.signal.addEventListener('abort', stop, { once: true });
      if (context.signal.aborted) { stop(); }
      try { return await handle.completion; }
      finally { context.signal.removeEventListener('abort', stop); }
    },
  };
}
