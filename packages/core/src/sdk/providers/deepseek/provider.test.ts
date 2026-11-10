import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { manageDiagnosticsPlugin } from '../../../skills/diagnostics-plugin.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekHarnessProvider } from './provider.js';
import type { ToolDefinition } from '../../tools.js';

// These transport fixtures own no model directory or external endpoint.
beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('{"data":[]}')))));
afterEach(() => vi.unstubAllGlobals());

function nativeTool(execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name: 'notebook_read_cell',
    description: 'Read current source',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object' },
    execute,
  };
}

async function collect(iterator: ReturnType<DeepSeekHarnessProvider['queryStream']>['iterator']) {
  const events = [];
  for await (const event of iterator) {
    events.push(event);
  }
  return events;
}

async function sdkFixture(
  options: { foreignSession?: boolean; captureConnection?: boolean; publicStages?: boolean; skillsCapability?: boolean } = {}
): Promise<{ dir: string; binary: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-provider-'));
  const binary = join(dir, 'dsh');
  await writeFile(
    binary,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(dir)}, 'argv.json'), JSON.stringify(process.argv.slice(2)));
require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(dir)}, 'overlay.json'), require('node:fs').readFileSync(process.argv.at(-1)));
require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(dir)}, 'environment.json'), JSON.stringify({ sentinel: process.env.DSH_QUERY_VISIBLE, hasAuthority: Object.hasOwn(process.env, 'DSH_QUERY_AUTHORITY') }));
${options.captureConnection ? `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(dir)}, 'connection.json'), JSON.stringify({ apiKey: process.env.DEEPSEEK_API_KEY, home: process.env.DSH_HOME }));` : ''}
const rl = require('node:readline').createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n');
const seen = new Set();
let initialization;
let pendingHost;
let pendingCancel;
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(dir)};
const end = sid => {
  notify('session.event', { sessionId: sid, event: { type: 'assistant/message', data: { message: { id: 'assistant-1', content: [{ type: 'text', text: 'done' }] } } } });
  notify('session.event', { sessionId: sid, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } });
  notify('session.status', { sessionId: sid, status: 'idle' });
};
rl.on('line', line => {
  const req = JSON.parse(line);
  if (!req.method && req.id === 'host-1') {
    fs.writeFileSync(path.join(root, 'host-response.json'), JSON.stringify(req));
    const sid = pendingHost;
    notify('session.event', { sessionId: sid, event: { type: 'tool/result', data: { meta: req.result, message: { content: [{ type: 'tool-result', toolCallId: 'call-1', isError: !!req.error, content: [{ type: 'text', text: JSON.stringify(req.result || req.error) }] }] } } } });
    if (pendingCancel !== undefined) {
      notify('session.event', { sessionId: sid, event: { type: 'turn/end', data: { reason: { kind: 'aborted' } } } });
      notify('session.status', { sessionId: sid, status: 'idle' });
      reply(pendingCancel, { reasoningStopped: true });
    } else end(sid);
    pendingHost = undefined;
    return;
  }
  fs.appendFileSync(path.join(root, 'requests.jsonl'), JSON.stringify(req) + '\\n');
  if (req.method === 'initialize') {
    initialization = req.params;
    reply(req.id, { capabilities: { tools: true, resume: true, cancel: true,${options.skillsCapability === false ? '' : ' skills: true,'} } }); return;
  }
  if (req.method === 'shutdown') { reply(req.id, {}); process.exit(0); return; }
  const sid = req.params.sessionId;
  if (req.method === 'session/open') {
    try {
      if (req.params.resume) fs.readFileSync(path.join(root, sid));
      else fs.writeFileSync(path.join(root, sid), '', { flag: 'wx' });
    }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'native session missing or already exists' } }) + '\\n'); return; }
    seen.add(sid);
    reply(req.id, { sessionId: sid, resumed: req.params.resume }); return;
  }
  if (req.method === 'session/cancel') {
    if (pendingHost) {
      pendingCancel = req.id;
      notify('tool.cancel', { sessionId: sid, invocationId: 'call-1' });
    } else reply(req.id, { reasoningStopped: true });
    return;
  }
  if (req.method !== 'session/prompt' || !seen.has(sid)) throw new Error('unknown or unopened session');
  reply(req.id, { messageId: 'user-1' });
  if (initialization.tools.length) {
    pendingHost = sid;
    const tool = initialization.tools[0];
    notify('session.event', { sessionId: sid, event: { type: 'tool/call', data: { callId: 'call-1', name: tool.name, arguments: '{}' } } });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'host-1', method: 'tool.call', params: { sessionId: ${options.foreignSession ? "'foreign-session'" : 'sid'}, name: tool.name, input: {}, invocationId: 'call-1' } }) + '\\n');
    return;
  }
  const finish = () => {
  fs.writeFileSync(path.join(root, 'tool-started'), 'yes');
  notify('session.event', { sessionId: sid, event: { type: 'tool/call', data: { callId: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' } } });
  notify('session.event', { sessionId: sid, event: { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file data' }] }] } } } });
  notify('session.event', { sessionId: sid, event: { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'private reasoning' } } } });
  notify('session.event', { sessionId: sid, event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'do' } } } });
  notify('session.event', { sessionId: sid, event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'ne' } } } });
  notify('session.event', { sessionId: sid, event: { type: 'assistant/message', data: { message: { id: 'assistant-1', content: [{ type: 'text', text: 'done' }] } } } });
  notify('session.event', { sessionId: sid, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } });
  notify('session.status', { sessionId: sid, status: 'idle' });
  };
  ${options.publicStages ? `
  notify('session.event', { sessionId: sid, event: { type: 'assistant/message', data: { message: {
    id: 'placeholder', content: [{ type: 'text', text: '🤔 Thinking...' }, { type: 'tool-call', name: 'read_file' }]
  } } } });
  for (let stage = 1; stage <= 5; stage++) {
    const event = { type: 'assistant/message', data: { message: { id: 'stage-' + stage, content: [
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'text', text: '阶段 ' + stage + '：已核验结果。\\n继续下一项检查。' },
      { type: 'tool-call', name: 'read_file', arguments: 'private tool payload' }
    ] } } };
    notify('session.event', { sessionId: sid, event });
    notify('session.event', { sessionId: sid, event });
    notify('session.event', { sessionId: sid, event: { ...event, data: { message: { ...event.data.message, id: 'repeat-' + stage } } } });
  }
  const gate = setInterval(() => {
    if (fs.existsSync(path.join(root, 'release-stages'))) { clearInterval(gate); finish(); }
  }, 10);
  ` : 'finish();'}
});
`,
    { mode: 0o755 }
  );
  return { dir, binary };
}

async function* oneInput() {
  yield { role: 'user' as const, content: 'read it' };
}

describe('DeepSeekHarnessProvider (Issue #4741)', () => {
  it('sends no skills manifest and fails fast on a skill-less minimal profile (#5717)', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({ binary: fixture.binary, dshHome: fixture.dir, mode: 'minimal' });
    const readRequests = () =>
      readFile(join(fixture.dir, 'requests.jsonl'), 'utf8')
        .then((body) => body.trim().split('\n').map((line) => JSON.parse(line)));
    try {
      const options = { settingSources: [], cwd: fixture.dir, systemPrompt: 'Original context' };
      await collect(provider.queryStream(oneInput(), options).iterator);
      let requests = await readRequests();
      // The captured harness input is the bare operator prompt plus the native
      // registration plan: no fabricated manifest reaches initialize/open/
      // prompt frames in any form.
      const initialized = requests.find((request) => request.method === 'initialize');
      expect(initialized.params.systemPrompt).toBe('Original context');
      expect(initialized.params.skills).toEqual({ builtinRoot: expect.any(String), projectRoot: fixture.dir });
      for (const request of requests) {
        expect(JSON.stringify(request)).not.toContain('Disclaude skills');
        expect(JSON.stringify(request)).not.toContain('SKILL.md');
      }
      manageDiagnosticsPlugin('install', fixture.dir, resolve('.'));
      // The minimal profile verifiably mounts no skills service: an explicit
      // installation fails fast with the remedy, before any process or model
      // turn — the wire log must not grow.
      expect(() => provider.queryStream(oneInput(), options)).toThrow(
        /DSH \(DeepSeek Harness\) cannot natively load Disclaude-managed skills:.*no native skills service.*agent.dsh mode standard.*plugins remove diagnostics.*No prompt manifest was injected and no model turn was submitted\./s
      );
      requests = await readRequests();
      expect(requests.filter((request) => request.method === 'initialize')).toHaveLength(1);
      manageDiagnosticsPlugin('remove', fixture.dir, resolve('.'));
      await collect(provider.queryStream(oneInput(), options).iterator);
      requests = await readRequests();
      const prompt = requests.filter((request) => request.method === 'initialize').at(-1).params.systemPrompt;
      expect(prompt).toBe('Original context');
      expect(prompt).not.toContain('diagnose-logs');
    } finally {
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  it('registers skills natively on a standard profile and keeps every prompt layer bare (#5717)', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({ binary: fixture.binary, dshHome: fixture.dir, mode: 'standard' });
    const project = join(fixture.dir, 'standard-project');
    await mkdir(project, { recursive: true });
    try {
      manageDiagnosticsPlugin('install', project, resolve('.'));
      // The sdk profile reports its native skills capability: the explicit
      // installation is deliverable through ctx.skills registration, so the
      // query runs and the diagnostics skill reaches the harness only via the
      // registration plan — never as a manifest in the prompt.
      await collect(provider.queryStream(oneInput(), {
        settingSources: [], cwd: project, projectRoot: project, systemPrompt: 'Original context',
      }).iterator);
      const requests = (await readFile(join(fixture.dir, 'requests.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const initialized = requests.find((request) => request.method === 'initialize');
      expect(initialized.params.systemPrompt).toBe('Original context');
      expect(initialized.params.skills).toEqual({ builtinRoot: expect.any(String), projectRoot: project });
      for (const request of requests) {
        expect(JSON.stringify(request)).not.toContain('Disclaude skills');
        expect(JSON.stringify(request)).not.toContain('diagnose-logs');
      }
      manageDiagnosticsPlugin('remove', project, resolve('.'));
    } finally {
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  it('fails an explicit installation when the booted profile reports no skills capability (#5717)', async () => {
    const fixture = await sdkFixture({ skillsCapability: false });
    const provider = new DeepSeekHarnessProvider({ binary: fixture.binary, dshHome: fixture.dir, mode: 'standard' });
    const project = join(fixture.dir, 'no-skill-profile');
    await mkdir(project, { recursive: true });
    try {
      manageDiagnosticsPlugin('install', project, resolve('.'));
      await expect(collect(provider.queryStream(oneInput(), {
        settingSources: [], cwd: project, projectRoot: project, systemPrompt: 'Original context',
      }).iterator)).rejects.toThrow(
        /no skills capability at initialize.*No prompt manifest was injected and no model turn was submitted/s
      );
      const requests = (await readFile(join(fixture.dir, 'requests.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      // The failure lands between initialize and session/open: no session was
      // opened and no model turn was submitted for the undeliverable skill.
      expect(requests.filter((request) => request.method === 'initialize')).toHaveLength(1);
      expect(requests.filter((request) => request.method === 'session/open')).toHaveLength(0);
      expect(requests.filter((request) => request.method === 'session/prompt')).toHaveLength(0);
      expect(JSON.stringify(requests)).not.toContain('Disclaude skills');
      manageDiagnosticsPlugin('remove', project, resolve('.'));
    } finally {
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  it('judges custom process args by the capability probe, not the host-side profile guess', async () => {
    const fixture = await sdkFixture({ skillsCapability: false });
    const provider = new DeepSeekHarnessProvider({
      binary: fixture.binary, dshHome: fixture.dir, args: ['--profile', 'sdk-minimal-custom'],
    });
    const project = join(fixture.dir, 'custom-args-project');
    await mkdir(project, { recursive: true });
    try {
      manageDiagnosticsPlugin('install', project, resolve('.'));
      // Custom args may boot anything, so no pre-spawn verdict is possible:
      // the probe decides, and a skill-less profile fails the same way.
      await expect(collect(provider.queryStream(oneInput(), {
        settingSources: [], cwd: project, projectRoot: project, systemPrompt: 'Original context',
      }).iterator)).rejects.toThrow(/no skills capability at initialize/);
      manageDiagnosticsPlugin('remove', project, resolve('.'));
    } finally {
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  it('resolves the undeliverable-skill gate from projectRoot, not the execution cwd', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({ binary: fixture.binary, dshHome: fixture.dir, mode: 'minimal' });
    const project = join(fixture.dir, 'project-with-plugin');
    const elsewhere = join(fixture.dir, 'elsewhere');
    await mkdir(project, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    try {
      manageDiagnosticsPlugin('install', project, resolve('.'));
      // Installed under projectRoot while the query executes elsewhere: the
      // explicit installation is undeliverable and fails fast.
      expect(() =>
        provider.queryStream(oneInput(), { settingSources: [], cwd: elsewhere, projectRoot: project, systemPrompt: 'Original context' })
      ).toThrow('cannot natively load Disclaude-managed skills');
      // The plugin sits under the cwd's tree, but projectRoot is clean: the
      // gate follows projectRoot (the previous manifest resolution root) and
      // the query proceeds with the bare operator prompt.
      await collect(
        provider.queryStream(oneInput(), { settingSources: [], cwd: project, projectRoot: elsewhere, systemPrompt: 'Original context' }).iterator
      );
      const requests = (await readFile(join(fixture.dir, 'requests.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(requests.filter((request) => request.method === 'initialize').at(-1).params.systemPrompt).toBe('Original context');
      expect(JSON.stringify(requests)).not.toContain('Disclaude skills');
    } finally {
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  it('isolates project switches and concurrent queries per Project root', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({ binary: fixture.binary, dshHome: fixture.dir, mode: 'minimal' });
    const dirty = join(fixture.dir, 'dirty-project');
    const clean = join(fixture.dir, 'clean-project');
    await mkdir(dirty, { recursive: true });
    await mkdir(clean, { recursive: true });
    try {
      manageDiagnosticsPlugin('install', dirty, resolve('.'));
      // A clean query is in flight when the dirty project's query arrives:
      // only the dirty query fails; the in-flight clean prompt stays bare.
      const cleanOptions = { settingSources: [], cwd: clean, projectRoot: clean, systemPrompt: 'Original context', sessionKey: 'clean-chat' };
      const flight = collect(provider.queryStream(oneInput(), cleanOptions).iterator);
      expect(() =>
        provider.queryStream(oneInput(), { settingSources: [], cwd: dirty, projectRoot: dirty, systemPrompt: 'Original context', sessionKey: 'dirty-chat' })
      ).toThrow('cannot natively load Disclaude-managed skills');
      await flight;
      // Project switch on the same provider: clean still runs after dirty
      // failed, and dirty still fails after clean ran — no sticky state.
      await collect(provider.queryStream(oneInput(), { ...cleanOptions, sessionKey: 'clean-chat-2' }).iterator);
      expect(() =>
        provider.queryStream(oneInput(), { settingSources: [], cwd: dirty, projectRoot: dirty, systemPrompt: 'Original context', sessionKey: 'dirty-chat-2' })
      ).toThrow('cannot natively load Disclaude-managed skills');
      const requests = (await readFile(join(fixture.dir, 'requests.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const prompts = requests.filter((request) => request.method === 'initialize').map((request) => request.params.systemPrompt);
      expect(prompts).toEqual(['Original context', 'Original context']);
      expect(JSON.stringify(requests)).not.toContain('Disclaude skills');
      expect(JSON.stringify(requests)).not.toContain('SKILL.md');
    } finally {
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  it.each([undefined, 'auto', 0, 48_000] as const)(
    'keeps minimal free of host compaction plugins and metadata discovery (%s)', async autoCompactWindow => {
      const fixture = await sdkFixture();
      const provider = new DeepSeekHarnessProvider({
        binary: fixture.binary, dshHome: fixture.dir, mode: 'minimal', apiKey: 'fixture-key',
        api: { protocol: 'openai', baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model' },
      });
      try {
        await collect(provider.queryStream(oneInput(), { settingSources: [], autoCompactWindow }).iterator);
        const overlay = JSON.parse(await readFile(join(fixture.dir, 'overlay.json'), 'utf8'));
        expect(fetch).not.toHaveBeenCalled();
        expect(overlay.filter((entry: { id?: string }) => entry.id)).toEqual([
          { id: 'sdk-jsonrpc-server', disabled: true },
        ]);
        const inserted = overlay.find((entry: { insert?: unknown }) => entry.insert).insert;
        expect(inserted.map((entry: { id: string }) => entry.id)).toEqual([
          'disclaude-dsh-api', 'disclaude-dsh-native-app',
        ]);
        const route = Object.values(inserted[0].config.providers)[0] as { models: object[] };
        expect(route.models).toEqual([{ id: 'fixture-model', name: 'fixture-model', input: ['text'] }]);
      } finally {
        await provider.shutdown();
        await rm(fixture.dir, { recursive: true, force: true });
      }
    }
  );

  it('keeps the selected native credential and home when query env contains stale values', async () => {
    const fixture = await sdkFixture({ captureConnection: true });
    const provider = new DeepSeekHarnessProvider({
      binary: fixture.binary, dshHome: fixture.dir, apiKey: 'selected-test-key', mode: 'minimal',
    });
    try {
      await collect(provider.queryStream(oneInput(), {
        settingSources: [], cwd: fixture.dir,
        env: { DEEPSEEK_API_KEY: 'stale-test-key', DSH_HOME: '/wrong-home' },
      }).iterator);
      expect(JSON.parse(await readFile(join(fixture.dir, 'connection.json'), 'utf8'))).toEqual({
        apiKey: 'selected-test-key', home: fixture.dir,
      });
    } finally {
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  it('uses query environment overrides and omits explicitly removed host authority', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({
      binary: fixture.binary,
      dshHome: fixture.dir,
      env: { DSH_QUERY_AUTHORITY: 'private-fixture', DSH_QUERY_VISIBLE: 'provider-default' },
    });
    try {
      await collect(
        provider.queryStream(oneInput(), {
          settingSources: [],
          cwd: fixture.dir,
          env: { DSH_QUERY_AUTHORITY: undefined, DSH_QUERY_VISIBLE: 'query-override' },
        }).iterator
      );
      expect(JSON.parse(await readFile(join(fixture.dir, 'environment.json'), 'utf8'))).toEqual({
        sentinel: 'query-override',
        hasAuthority: false,
      });
    } finally {
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  it.each([undefined, 'standard', 'minimal'] as const)(
    'selects the SDK profile for mode %s without changing the RPC flow',
    async (mode) => {
      const fixture = await sdkFixture();
      const provider = new DeepSeekHarnessProvider({
        binary: fixture.binary,
        dshHome: fixture.dir,
        mode,
      });
      try {
        const events = [];
        for await (const event of provider.queryStream(oneInput(), { settingSources: [] })
          .iterator) {
          events.push(event);
        }
        const argv = JSON.parse(await readFile(join(fixture.dir, 'argv.json'), 'utf8'));
        expect(argv.slice(0, 3)).toEqual([
          '--profile',
          mode === 'minimal' ? 'sdk-minimal' : 'sdk',
          '--patch',
        ]);
        expect(await readFile(join(fixture.dir, 'overlay.json'), 'utf8')).toContain('disclaude-dsh-native-app');
        expect(events.at(-1)?.type).toBe('result');
      } finally {
        provider.dispose();
        await rm(fixture.dir, { recursive: true, force: true });
      }
    }
  );
  it('reports an unavailable minimal profile without retrying the standard profile', async () => {
    const fixture = await sdkFixture();
    await writeFile(
      fixture.binary,
      `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(join(fixture.dir, 'attempts'))}, JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.exit(2);\n`,
      { mode: 0o755 }
    );
    const provider = new DeepSeekHarnessProvider({
      binary: fixture.binary,
      dshHome: fixture.dir,
      mode: 'minimal',
    });
    try {
      await expect(
        provider.queryStream(oneInput(), { settingSources: [] }).iterator.next()
      ).rejects.toThrow(/exited|sdk-minimal/);
      const attempts = (await readFile(join(fixture.dir, 'attempts'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(attempts).toHaveLength(1);
      expect(attempts[0].slice(0, 2)).toEqual(['--profile', 'sdk-minimal']);
    } finally {
      provider.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('sends a shared binding wire model verbatim to the DSH harness (Issue #5679)', async () => {
    vi.stubEnv('SHARED_GATEWAY_KEY', 'shared-test-key');
    const { resolveConfiguredAgents } = await import('../../../config/resolved-agents.js');
    const { dshOptions } = await import('../../factory.js');
    const resolved = resolveConfiguredAgents({
      agents: {
        assistant: {
          backend: 'claude', llm: 'shared', default: true,
          claude: { behavesAs: 'claude-sonnet-4-5' },
        },
        research: { backend: 'dsh', llm: 'shared', mode: 'minimal' },
      },
      llms: {
        shared: {
          defaultModel: 'group/hq-degrade',
          api: {
            protocol: 'anthropic',
            baseUrl: 'https://gateway.example',
            apiKey: '$SHARED_GATEWAY_KEY',
          },
        },
      },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    // The production factory mapping: the bound LLM's model becomes the DSH
    // API connection model without alias resolution or Claude mappings.
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({
      ...dshOptions(resolved.presets.research),
      binary: fixture.binary,
      dshHome: fixture.dir,
    });
    try {
      // BaseAgent passes the preset's model as the per-query selection, the
      // same value the API route registers as its catalog entry.
      await collect(
        provider.queryStream(oneInput(), {
          settingSources: [],
          model: resolved.presets.research.model,
        }).iterator
      );
      const requests = (await readFile(join(fixture.dir, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      // What the harness is told to select:
      expect(requests.find((request) => request.method === 'initialize').params.model).toBe(
        'group/hq-degrade'
      );
      // What the API route actually serves:
      const overlay = JSON.parse(await readFile(join(fixture.dir, 'overlay.json'), 'utf8'));
      const inserted = overlay.find((entry: { insert?: unknown }) => entry.insert).insert;
      const route = Object.values(inserted[0].config.providers)[0] as { models: { id: string }[] };
      expect(route.models).toEqual([
        { id: 'group/hq-degrade', name: 'group/hq-degrade', input: ['text'] },
      ]);
    } finally {
      provider.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
  it('rejects invalid modes and custom arguments that could override the selected mode', () => {
    expect(() => new DeepSeekHarnessProvider({ mode: 'typo' as never })).toThrow('DSH mode');
    expect(
      () => new DeepSeekHarnessProvider({ mode: 'minimal', args: ['--profile', 'sdk'] })
    ).toThrow('custom process args');
  });
  it('allows dsh to resolve credentials from its own credential service', () => {
    const provider = new DeepSeekHarnessProvider({ env: {} });

    expect(provider.validateConfig()).toBe(true);
    expect(provider.getInfo()).toMatchObject({
      name: 'dsh',
      available: true,
    });
  });

  it('accepts an API key and an existing isolated DSH_HOME', () => {
    const provider = new DeepSeekHarnessProvider({
      env: { DEEPSEEK_API_KEY: 'test-key' },
      dshHome: process.cwd(),
    });

    expect(provider.validateConfig()).toBe(true);
    expect(provider.getInfo()).toMatchObject({
      name: 'dsh',
      version: '0.1.2-native',
      available: true,
    });
  });

  it('streams an official-protocol prompt through native tool events to one completion', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({
      apiKey: 'test-key',
      binary: fixture.binary,
      dshHome: fixture.dir,
    });
    try {
      const { iterator } = provider.queryStream(oneInput(), {
        cwd: fixture.dir,
        model: 'deepseek-chat',
        sessionKey: 'chat-1',
        settingSources: [],
      });
      const events = [];
      for await (const event of iterator) {
        events.push(event);
      }
      expect(events.map((event) => event.type)).toEqual([
        'tool_use',
        'tool_result',
        'text',
        'result',
      ]);
      expect(events[0]?.metadata).toMatchObject({
        toolName: 'read_file',
        toolInput: { path: 'a.txt' },
      });
      expect(events[1]).toMatchObject({ content: 'file data' });
      expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'text').map((event) => event.content)).toEqual(
        ['done']
      );
    } finally {
      provider.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('streams five distinct public messages before tools or completion, suppressing duplicates and empty placeholders', async () => {
    const fixture = await sdkFixture({ publicStages: true });
    const provider = new DeepSeekHarnessProvider({ apiKey: 'test-key', binary: fixture.binary, dshHome: fixture.dir });
    try {
      const { iterator } = provider.queryStream(oneInput(), { cwd: fixture.dir, settingSources: [] });
      for (let stage = 1; stage <= 5; stage++) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const next = await Promise.race([iterator.next(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Public message was buffered until completion')), 2000);
          })]);
          expect(next.value).toMatchObject({ type: 'text', content: `阶段 ${stage}：已核验结果。\n继续下一项检查。`,
            metadata: { messageId: `stage-${stage}`, phase: 'commentary' } });
        } finally { clearTimeout(timer); }
      }
      await expect(readFile(join(fixture.dir, 'tool-started'))).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(join(fixture.dir, 'release-stages'), 'continue');
      const tail = await collect(iterator);
      expect(tail.map(event => event.type)).toEqual(['tool_use', 'tool_result', 'text', 'result']);
      expect(tail[2]).toMatchObject({ content: 'done', metadata: { phase: 'final_answer' } });
    } finally {
      await writeFile(join(fixture.dir, 'release-stages'), 'continue');
      provider.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it.each(['completion', 'cancellation'])(
    'resumes the durable ID for the same logical chat after %s',
    async (ending) => {
      const fixture = await sdkFixture();
      const provider = new DeepSeekHarnessProvider({
        binary: fixture.binary,
        dshHome: fixture.dir,
      });
      try {
        const first = provider.queryStream(oneInput(), {
          sessionKey: 'same-chat',
          settingSources: [],
        });
        for await (const event of first.iterator) {
          if (ending === 'cancellation' && event.type === 'tool_use') {
            first.handle.cancel();
            break;
          }
        }
        const second = provider.queryStream(oneInput(), {
          sessionKey: 'same-chat',
          settingSources: [],
        });
        // A late close of the old stream must not kill the replacement process.
        first.handle.close();
        const events = [];
        for await (const event of second.iterator) {
          events.push(event);
        }
        expect(second.handle.sessionId).toBe(first.handle.sessionId);
        expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
        expect(events.some((event) => event.type === 'error')).toBe(false);
      } finally {
        provider.dispose();
        await rm(fixture.dir, { recursive: true, force: true });
      }
    }
  );

  it('fails fast when unsupported client tool controls are requested', () => {
    const provider = new DeepSeekHarnessProvider({ apiKey: 'test-key' });
    expect(() => provider.queryStream(oneInput(), { settingSources: [], ...({ builtinTools: { type: 'preset', preset: 'claude_code' } } as Record<string, unknown>) })).toThrow(
      'no longer a query option'
    );
    expect(() => provider.queryStream(oneInput(), { settingSources: [], ...({ mcpServers: {} } as Record<string, unknown>) })).toThrow('no longer a query option');
    provider.dispose();
  });

  it('cancels before startup and releases the child without hanging the iterator', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({
      apiKey: 'test-key',
      binary: fixture.binary,
      dshHome: fixture.dir,
    });
    try {
      const query = provider.queryStream(oneInput(), {
        settingSources: [],
        sessionKey: 'cancel-me',
      });
      query.handle.cancel();
      await expect(query.iterator.next()).resolves.toMatchObject({ done: true });
    } finally {
      provider.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('becomes unavailable after disposal', () => {
    const provider = new DeepSeekHarnessProvider({ apiKey: 'test-key' });

    provider.dispose();

    expect(provider.validateConfig()).toBe(false);
  });

  it('dispatches canonical native host tools and preserves structured results', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({
      binary: fixture.binary,
      dshHome: fixture.dir,
      provider: 'route-one',
    });
    const execute = vi.fn().mockResolvedValue({ runId: 'run-one', state: 'accepted' });
    try {
      const events = await collect(
        provider.queryStream(oneInput(), {
          settingSources: [],
          cwd: fixture.dir,
          model: 'native-model',
          reasoningEffort: 'native-effort',
          systemPrompt: 'Native instructions',
          tools: [nativeTool(execute)],
        }).iterator
      );
      expect(execute).toHaveBeenCalledWith(
        {},
        { signal: expect.any(AbortSignal) }
      );
      expect(events.find((event) => event.type === 'tool_result')?.metadata?.toolOutput).toEqual({
        runId: 'run-one',
        state: 'accepted',
      });
      const frames = (await readFile(join(fixture.dir, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(frames[0].params).toMatchObject({
        provider: 'route-one',
        model: 'native-model',
        reasoningEffort: 'native-effort',
        systemPrompt: 'Native instructions',
      });
      expect(frames[0].params.tools[0]).not.toHaveProperty('execute');
    } finally {
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects a host request claiming a different session', async () => {
    const fixture = await sdkFixture({ foreignSession: true });
    const provider = new DeepSeekHarnessProvider({ binary: fixture.binary, dshHome: fixture.dir });
    const execute = vi.fn();
    try {
      await collect(
        provider.queryStream(oneInput(), { settingSources: [], tools: [nativeTool(execute)] })
          .iterator
      );
      expect(execute).not.toHaveBeenCalled();
      expect(
        JSON.parse(await readFile(join(fixture.dir, 'host-response.json'), 'utf8')).error
      ).toMatchObject({ code: -32603 });
    } finally {
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('keeps the native reference across provider restart and drops it on explicit reset', async () => {
    const fixture = await sdkFixture();
    const options = { binary: fixture.binary, dshHome: fixture.dir };
    const queryOptions = { settingSources: [], cwd: fixture.dir, sessionKey: 'durable-chat' };
    const first = new DeepSeekHarnessProvider(options);
    const second = new DeepSeekHarnessProvider(options);
    try {
      const original = first.queryStream(oneInput(), queryOptions);
      await collect(original.iterator);
      await first.shutdown();
      const resumed = second.queryStream(oneInput(), queryOptions);
      await collect(resumed.iterator);
      expect(resumed.handle.sessionId).toBe(original.handle.sessionId);
      second.forgetSession('durable-chat');
      const reset = second.queryStream(oneInput(), queryOptions);
      await collect(reset.iterator);
      expect(reset.handle.sessionId).not.toBe(original.handle.sessionId);
      expect(await readFile(join(fixture.dir, original.handle.sessionId!), 'utf8')).toBe('');
    } finally {
      await first.shutdown();
      await second.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('waits for owned tool cleanup before confirming interruption', async () => {
    const fixture = await sdkFixture();
    const provider = new DeepSeekHarnessProvider({ binary: fixture.binary, dshHome: fixture.dir });
    let entered!: () => void;
    let aborted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const signalled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const quiescent = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cleaned = false;
    const tool = nativeTool(async (_input, { signal }) => {
      entered();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted();
            resolve();
          },
          { once: true }
        );
      });
      await quiescent;
      cleaned = true;
      return { executionStop: 'not_confirmed' };
    });
    try {
      const query = provider.queryStream(oneInput(), { settingSources: [], tools: [tool] });
      const events = collect(query.iterator);
      await started;
      let acknowledged = false;
      const interrupted = query.handle.interrupt!().then(() => {
        acknowledged = true;
      });
      await signalled;
      expect(acknowledged).toBe(false);
      expect(cleaned).toBe(false);
      release();
      await interrupted;
      expect(cleaned).toBe(true);
      expect((await events).find((event) => event.type === 'result')?.metadata?.stopReason).toBe(
        'interrupted'
      );
    } finally {
      release();
      await provider.shutdown();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
});
