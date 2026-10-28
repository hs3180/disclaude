import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AgentInputContext, AgentQueryOptions, ProjectManager, ToolDefinition } from '@disclaude/core';
import { AgentTaskRunner } from './agent-task-runner.js';
import { AGENT_TASK_TOOL_SPEC, createAgentTaskTool } from './agent-task-tool.js';
import type { AgentCreateOptions } from './factory.js';
import { readVerifiedInputSource, type VerifiedFeishuInput } from './input-provenance.js';
import type { ChatAgentCallbacks } from './types.js';

export interface AgentTaskServiceOptions {
  projectManager: Pick<ProjectManager, 'resolveCwd' | 'getWorkspaceDir'>;
  isAllowed(source: Readonly<VerifiedFeishuInput>, input: Readonly<AgentInputContext>, projectRoot: string): boolean;
  runtimeOptions(input: Readonly<AgentInputContext>): AgentCreateOptions;
  callbacks(input: Readonly<AgentInputContext>): ChatAgentCallbacks;
}
type Binding = { root: string; route: string; tool: ToolDefinition };
const routeKey = (input: Readonly<AgentInputContext>): string => JSON.stringify([
  input.threadRootId ?? null, input.replyRootId === undefined ? 'unspecified' : input.replyRootId,
]);

/** Service-owned admission, separate from provider transport and task execution.
 * Provenance is process-local; model/REST identity strings cannot enable it.
 */
export class AgentTaskService {
  private readonly bindings = new WeakMap<Readonly<VerifiedFeishuInput>, Binding>();
  private readonly active = new Map<AgentTaskRunner, string>();
  private closing = false;
  private closeFlight?: Promise<void>;
  constructor(private readonly options: AgentTaskServiceOptions) {}

  configureQueryOptions(options: AgentQueryOptions): AgentQueryOptions {
    if (options.codexRuntime?.transport !== 'app-server' || !options.cwd) { return options; }
    return { ...options, tools: [...(options.tools ?? []), this.createTool(options.cwd)] };
  }

  private authorize(input: Readonly<AgentInputContext>, directory: string): {
    facts: Readonly<VerifiedFeishuInput>; root: string;
  } {
    if (this.closing) { throw new Error('Agent task service is closing'); }
    const facts = readVerifiedInputSource(input);
    if (!facts) { throw new Error('Agent tasks require a verified originating user input'); }
    const current = this.options.projectManager.resolveCwd(facts.chatId);
    if (current.reason === 'bound-missing' || !isAbsolute(directory)) { throw new Error('Agent task Project is unavailable'); }
    const root = realpathSync(current.boundWorkingDir ?? this.options.projectManager.getWorkspaceDir());
    if (root !== realpathSync(directory)) { throw new Error('Agent task input no longer belongs to the current Project'); }
    if (!this.options.isAllowed(facts, input, root)) { throw new Error('Agent task is not authorized'); }
    return { facts, root };
  }

  /** Register only on a transport that supplies originating ToolContext.
   * directory is the owning query's cwd, never a model-supplied Project.
   */
  createTool(directory: string): ToolDefinition {
    return { ...AGENT_TASK_TOOL_SPEC, execute: async (args, context) => {
      context.signal.throwIfAborted();
      if (!context.inputContext) { throw new Error('Agent task input context is unavailable'); }
      const input = Object.freeze({ ...context.inputContext });
      const { facts, root } = this.authorize(input, directory);
      let binding = this.bindings.get(facts);
      if (binding && (binding.root !== root || binding.route !== routeKey(input))) {
        throw new Error('Agent task source already belongs to another Project or reply route');
      }
      if (!binding) {
        const selected = this.options.runtimeOptions(input);
        const runtime = { ...selected, ...(selected.settings ? { settings: structuredClone(selected.settings) } : {}),
          ...(selected.env ? { env: { ...selected.env } } : {}),
          configureQueryOptions: (options: AgentQueryOptions) => ({
            ...(selected.configureQueryOptions?.(options) ?? options), onAsyncUserInputAnswer: undefined,
            capacityAdmission: 'reject' as const,
          }) };
        const runner = new AgentTaskRunner(runtime);
        const tool = createAgentTaskTool({ start: (request, callbacks) => {
          this.authorize(input, root);
          const handle = runner.start(request, callbacks);
          this.active.set(runner, facts.chatId);
          const release = (): void => { if (runner.activeCount === 0) { this.active.delete(runner); } };
          void handle.completion.then(release, release);
          return handle;
        } }, { projectRoot: root, source: { chatId: facts.chatId, senderOpenId: facts.actorId,
          sourceMessageId: facts.sourceMessageId,
          ...(facts.chatType ? { chatType: facts.chatType } : {}),
          ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
          ...(input.replyRootId !== undefined ? { replyRootId: input.replyRootId } : {}) },
        callbacks: this.options.callbacks(input) });
        binding = { root, route: routeKey(input), tool };
        this.bindings.set(facts, binding);
      }
      const result = await binding.tool.execute(args, context);
      this.authorize(input, root);
      return result;
    } };
  }
  isBusy(chatId: string): boolean { return [...this.active.values()].includes(chatId); }
  close(): Promise<void> {
    this.closing = true;
    this.closeFlight ??= Promise.all([...this.active.keys()].map(runner => runner.close())).then(() => {});
    return this.closeFlight;
  }
}
