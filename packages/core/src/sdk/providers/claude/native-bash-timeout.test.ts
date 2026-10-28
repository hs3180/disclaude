/** Real SDK/native Bash, with a synthetic localhost model transport and private settings. */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { adaptOptions } from './options-adapter.js';
import { ClaudeAttemptProcess } from './attempt-process.js';

// SDK parent-side logging reads process.env separately from the child env.
const parentLogging = vi.hoisted(() => {
  const previous = process.env.DEBUG_CLAUDE_AGENT_SDK;
  delete process.env.DEBUG_CLAUDE_AGENT_SDK;
  return { previous };
});
afterAll(() => {
  if (parentLogging.previous === undefined) { delete process.env.DEBUG_CLAUDE_AGENT_SDK; }
  else { process.env.DEBUG_CLAUDE_AGENT_SDK = parentLogging.previous; }
});

vi.mock('../../../config/loader.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../config/loader.js')>(),
  loadConfigFile: () => ({ _fromFile: false }),
}));
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform === 'win32')('native per-command Bash timeout (#5515)', () => {
  it.each([
    { name: 'default command timeout returns a tool error and the query continues', command: 'sleep 3; printf fixture-finished', timeout: undefined, maximum: '1200', failed: true, background: false },
    { name: 'an explicit longer timeout succeeds within the configured maximum', command: 'sleep 1.2; printf fixture-finished', timeout: 2200, maximum: '2500', failed: false, background: false },
    { name: 'an over-maximum timeout cannot bypass the native upper bound', command: 'sleep 3; printf fixture-finished', timeout: 10000, maximum: '1200', failed: true, background: false },
    { name: 'an explicit background job can finish after the foreground deadline', command: '', timeout: undefined, maximum: '1200', failed: false, background: true },
  ])('$name', async ({ command, timeout, maximum, failed, background }) => {
    const root = await mkdtemp(join(tmpdir(), 'disclaude-bash-native-'));
    await mkdir(join(root, '.claude'));
    vi.stubEnv('DISCLAUDE_BROWSER_RUNTIME', join(root, 'browser.sock'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, '.claude'));
    const marker = join(root, 'completed');
    if (background) { command = `sleep 1.8; printf fixture-finished > '${marker.replaceAll("'", "'\\''")}'`; }
    let releaseInput!: () => void; const pendingInput = new Promise<void>(resolve => { releaseInput = resolve; });
    const input = (async function* () {
      yield { type: 'user' as const, message: { role: 'user' as const, content: 'Run the controlled local fixture once.' }, parent_tool_use_id: null, session_id: '' };
      await pendingInput;
    })();
    const results: Array<{ is_error?: boolean; content: string }> = [];
    let calls = 0;
    const server = createServer(async (req, res) => {
      if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":10}'); return; }
      if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) { chunks.push(Buffer.from(chunk)); }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Array<{ content: string | Array<{ type: string; is_error?: boolean; content: string }> }> };
      calls++;
      for (const message of body.messages) {
        if (Array.isArray(message.content)) { results.push(...message.content.filter(part => part.type === 'tool_result')); }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type: string, value: unknown) => { res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`); };
      event('message_start', { type: 'message_start', message: { id: `msg-${calls}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (calls === 1) {
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'bash-fixture', name: 'Bash', input: {} } });
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command, ...(background ? { run_in_background: true } : {}), ...(timeout !== undefined ? { timeout } : {}), description: 'Controlled local Bash fixture' }) } });
      } else {
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Tool result observed.' } });
      }
      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('message_delta', { type: 'message_delta', delta: { stop_reason: calls === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
      event('message_stop', { type: 'message_stop' }); res.end();
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') { throw new Error('Missing fixture address'); }
    const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), 25_000);
    let stream: ReturnType<typeof query> | undefined;
    const native = new ClaudeAttemptProcess();
    try {
      const adapted = adaptOptions({ settingSources: [], cwd: root, env: {
        PATH: process.env.PATH, DEBUG_CLAUDE_AGENT_SDK: '', CLAUDE_CONFIG_DIR: join(root, '.claude'),
        ANTHROPIC_API_KEY: 'offline-fixture', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        BASH_DEFAULT_TIMEOUT_MS: '800', BASH_MAX_TIMEOUT_MS: maximum,
      } });
      stream = query({ prompt: background ? input : 'Run the controlled local fixture once.', options: {
        cwd: root, model: 'claude-sonnet-4-20250514', tools: ['Bash'], allowedTools: ['Bash'],
        systemPrompt: 'Use only the controlled local fixture supplied by the test server.',
        permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
        settingSources: [], persistSession: false, abortController: controller,
        env: adapted.env as NodeJS.ProcessEnv, stderr: () => {},
        // SDK merges parent env again; the final OS boundary stays fixture-only.
        spawnClaudeCodeProcess: options => native.spawn({ ...options, env: {
          ...(adapted.env as NodeJS.ProcessEnv), CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        } }),
      } });
      const ownedStream = stream;
      let completed = false;
      const collecting = (async () => {
        for await (const message of ownedStream) {
          if (message.type === 'result') { completed = !message.is_error && message.subtype === 'success'; }
        }
      })();
      void collecting.catch(() => {});
      if (background) {
        const until = Date.now() + 15_000;
        for (;;) {
          const content = await readFile(marker, 'utf8').catch(error => { if (error.code === 'ENOENT') { return undefined; } throw error; });
          if (content !== undefined) { expect(content).toBe('fixture-finished'); break; }
          if (Date.now() >= until) { throw new Error('Owned background fixture did not complete'); }
          await delay(50);
        }
        releaseInput();
      }
      await collecting;
      expect(completed).toBe(true);
      if (background) { expect(calls).toBeGreaterThanOrEqual(2); }
      else { expect(calls).toBe(2); expect(results).toHaveLength(1); }
      expect(Boolean(results[0].is_error)).toBe(failed);
      if (!background) { expect(results[0].content.includes('fixture-finished')).toBe(!failed); }
    } finally {
      clearTimeout(deadline); releaseInput();
      const exit = await native.stop(() => stream?.close()); controller.abort();
      await new Promise<void>((resolve, reject) => { server.close(error => { if (error) { reject(error); } else { resolve(); } }); });
      await rm(root, { recursive: true, force: true });
      expect(exit.confirmed).toBe(true);
    }
  }, 30_000);
});
