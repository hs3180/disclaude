/** A narrow stdio controller over DSH's native Agent and tool APIs. */
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent';
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment';
import { createUserMessage, ReasoningEffortId, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { JsonRpcLineTransport, type JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertToolOptions, type ToolDefinition } from '../../tools.js';
import { registerDshTools } from './tool-adapter.js';

export const name = 'disclaude-dsh-native-app';
export const inject = ['agents', 'tools', 'systemPrompt', 'sdkAppStartup', 'attachments'];

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function sessionIdentity(value: unknown): CreateAgentOptions['sessionId'] {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('Invalid native DSH session identity');
  }
  return value as CreateAgentOptions['sessionId'];
}

export class DshNativeApp {
  private initialized = false;
  private closing = false;
  private cwd = process.cwd();
  private options: AgentOptions = {};
  private descriptors: ToolDescriptor[] = [];
  private prompt?: string;
  private readonly sessions = new Map<string, AgentHandle>();
  private readonly openings = new Map<string, Promise<unknown>>();
  private readonly disposers: (() => void)[];

  constructor(
    private readonly ctx: Context,
    private readonly peer: JsonRpcTransportPeer
  ) {
    this.disposers = [
      ctx.on('session/event', (session, event) => {
        if (this.sessions.has(String(session.id))) {
          peer.notify('session.event', { sessionId: String(session.id), event });
        }
      }),
      ctx.on('agent/status', ({ agent, status }) => {
        if (this.sessions.has(String(agent.session.id))) {
          peer.notify('session.status', { sessionId: String(agent.session.id), status });
        }
      }),
    ];
  }

  async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'initialize') {
      return this.initialize(params);
    }
    if (method === 'shutdown') {
      return this.shutdown();
    }
    if (!this.initialized || this.closing) {
      throw new Error('Native DSH controller is not available');
    }
    const sessionId = sessionIdentity(params.sessionId);
    if (method === 'session/open') {
      if (params.resume !== undefined && typeof params.resume !== 'boolean') {
        throw new TypeError('resume must be boolean');
      }
      if (this.sessions.has(sessionId)) {
        throw new Error('Native DSH session is already open');
      }
      if (this.openings.has(sessionId)) {
        throw new Error('Native DSH session is already opening');
      }
      const opening = this.open(sessionId, params.resume === true);
      this.openings.set(sessionId, opening);
      try {
        return await opening;
      } finally {
        this.openings.delete(sessionId);
      }
    }
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      throw new Error('Native DSH session is not open');
    }
    if (method === 'session/prompt') {
      const content = await this.content(params.contentBlocks);
      if (this.closing || this.sessions.get(sessionId) !== handle) {
        throw new Error('Native DSH session closed before input delivery');
      }
      const message = createUserMessage({ content, source: { kind: 'user' } });
      handle.agent.followup(message);
      return { messageId: message.id };
    }
    if (method === 'session/cancel') {
      handle.agent.cancel({ kind: 'user' });
      await handle.agent.whenIdle();
      // Resource execution has its own submit/query/stop contract. Agent idle
      // is evidence about inference, never confirmation that a kernel stopped.
      return { state: 'idle', reasoningStopped: true, executionStop: 'not_confirmed' };
    }
    throw new Error(`Unsupported native DSH method: ${method}`);
  }

  private initialize(params: Record<string, unknown>): unknown {
    if (this.initialized) {
      throw new Error('Native DSH controller cannot be reinitialized');
    }
    if (typeof params.cwd !== 'string') {
      throw new TypeError('cwd must be a string');
    }
    const provider = optionalString(params.provider, 'provider');
    const model = optionalString(params.model, 'model');
    const effort = optionalString(params.reasoningEffort, 'reasoningEffort');
    const descriptors = params.tools ?? [];
    if (!Array.isArray(descriptors)) {
      throw new TypeError('tools must be an array');
    }
    this.descriptors = descriptors.map((item: unknown) => {
      if (!item || typeof item !== 'object') {
        throw new TypeError('Invalid host tool descriptor');
      }
      const tool = item as Record<string, unknown>;
      const name = optionalString(tool.name, 'tool name');
      if (
        !name ||
        typeof tool.description !== 'string' ||
        !tool.inputSchema ||
        !tool.outputSchema
      ) {
        throw new TypeError('Invalid host tool descriptor');
      }
      return {
        name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        outputSchema: tool.outputSchema as Record<string, unknown>,
      };
    });
    this.cwd = resolve(params.cwd);
    this.options = {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    };
    assertToolOptions(params);
    this.prompt = optionalString(params.systemPrompt, 'systemPrompt');
    this.initialized = true;
    return {
      serverInfo: { name, version: '1' },
      capabilities: { tools: true, resume: true, cancel: true },
    };
  }

  private async open(
    sessionId: CreateAgentOptions['sessionId'],
    resume: boolean
  ): Promise<unknown> {
    const setup = (agentCtx: Context) => {
      if (this.descriptors.length) {
        const inherited = new Set(agentCtx.tools.schemas(agentCtx.agent).map((tool) => tool.name));
        for (const tool of this.descriptors) {
          if (inherited.has(tool.name)) {
            throw new TypeError(`Host tool conflicts with DSH profile tool: ${tool.name}`);
          }
        }
      }
      const tools: ToolDefinition[] = this.descriptors.map((tool) => ({
        ...tool,
        execute: async (input, { signal }) => {
          const invocationId = randomUUID();
          const cancel = () => this.peer.notify('tool.cancel', { sessionId, invocationId });
          signal.addEventListener('abort', cancel, { once: true });
          try {
            signal.throwIfAborted();
            // Keep waiting for the host operation after cancellation, so the
            // DSH tool body only settles once its owned work is quiescent.
            return await this.peer.request('tool.call', {
              sessionId,
              name: tool.name,
              input,
              invocationId,
            });
          } finally {
            signal.removeEventListener('abort', cancel);
          }
        },
      }));
      registerDshTools(agentCtx.tools, tools, agentCtx.attachments);
      if (this.prompt) {
        agentCtx.systemPrompt.section({
          name: 'disclaude-context',
          order: 9000,
          text: this.prompt,
        });
      }
    };
    const handle = resume
      ? await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.options,
          setup,
        })
      : await this.ctx.agents.create({
          sessionId,
          meta: { cwd: this.cwd },
          agentOptions: this.options,
          setup,
        });
    if (this.closing) {
      await handle.dispose();
      throw new Error('Native DSH controller closed while opening session');
    }
    this.sessions.set(sessionId, handle);
    const { provider, model, reasoningEffort, maxTokens } = handle.agent.options;
    return { sessionId, resumed: resume, options: { provider, model, reasoningEffort, maxTokens } };
  }

  private async content(raw: unknown): Promise<ContentBlock[]> {
    if (!Array.isArray(raw)) {
      throw new TypeError('contentBlocks must be an array');
    }
    const images = raw.filter((block) => block?.type === 'image');
    const refs = images.length
      ? await admitEncodedImages(
          this.ctx.attachments,
          images.map((block) => {
            if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') {
              throw new TypeError('Invalid encoded image');
            }
            return { data: block.data, mediaType: block.mimeType };
          })
        )
      : [];
    let image = 0;
    return raw.map((block) => {
      if (block?.type === 'text' && typeof block.text === 'string') {
        return { type: 'text', text: block.text };
      }
      if (block?.type === 'image') {
        return { type: 'image', attachment: refs[image++] };
      }
      throw new TypeError('Unsupported native DSH input block');
    });
  }

  async shutdown(): Promise<Record<string, never>> {
    this.closing = true;
    await Promise.allSettled(this.openings.values());
    const handles = [...this.sessions.values()];
    this.sessions.clear();
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    const results = await Promise.allSettled(handles.map((handle) => handle.dispose()));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Native DSH teardown failed'
      );
    }
    return {};
  }
}

/** DSH Loader plugin replacing only the SDK stdio surface, preserving its profile. */
export function apply(ctx: Context): void {
  const peer = new JsonRpcLineTransport(process.stdin, process.stdout);
  const app = new DshNativeApp(ctx, peer);
  peer.onRequest(async (method, params) => {
    if (method === 'initialize') {
      await ctx.get('loader')?.await();
    }
    return app.handleRequest(method, params);
  });
  ctx.effect(() => {
    peer.start();
    return async () => {
      try {
        await app.shutdown();
      } finally {
        peer.close();
      }
    };
  });
}
