/**
 * Tests for the mini-swe-agent provider (Issue #5006).
 *
 * All bridge behavior is exercised against REAL subprocesses: a fake `mini`
 * shell script (chmod 755) on an injected PATH drives the actual
 * spawn/readline/timer/kill machinery — no mocking of the mechanism under
 * test, no real mini-swe-agent runtime required.
 *
 * Coverage focus:
 * - binary detection: PATH scan, explicit path, `mini-swe-agent` alias probe,
 *   non-executable file rejection, actionable BINARY_MISSING throw
 * - getInfo()/validateConfig(): unavailable reasons (binary + credential hint)
 * - happy path: stdout progress (transientStatus) → trajectory final answer →
 *   turn terminator; MSWEA_CONFIGURED / OPENAI_API_BASE projection into the
 *   child env; `-m` model argv; cwd propagation
 * - error mapping: auth-failure hint, plain exit-code failure +
 *   terminatedReason turn_failed, spawn failure
 * - timeout policy error + turn_failed terminator
 * - cancel(): in-flight kill ends the stream without a turn terminator;
 *   early cancel before the first next()
 * - sanitization: a credential echoed by the child is [REDACTED] in every
 *   chat-bound message and never appears in argv
 * - multi-turn replay: prior final answers are re-sent as prompt context
 *   (the CLI has no native session resume)
 * - stdout-tail fallback when the trajectory yields no assistant message
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { registerModelSecretNames } from '../../../config/channel-credentials.js';
import { MiniSweAgentProvider } from './provider.js';
import type { AgentMessage, AgentQueryOptions, UserInput } from '../../types.js';

interface Fixtures {
  root: string;
  binDir: string;
  argvLog: string;
  promptsLog: string;
  envLog: string;
  cleanup: () => void;
}

/** Octal record separator (\036) between logged prompts (prompts are multi-line). */
const PROMPT_SEP = '\x1e';

/**
 * Recorder prefix shared by every fake `mini`: records argv, the `-t` prompt
 * (last argv element) and child-visible environment facts (presence only —
 * secret values are never written here) before running the per-test body.
 */
function recorderScript(fx: Fixtures): string {
  return `
traj=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then traj="$arg"; fi
  prev="$arg"
done
printf '%s\\n' "$*" >> "${fx.argvLog}"
for last; do :; done
printf '%s\\036' "$last" >> "${fx.promptsLog}"
{
  echo "pwd=$(pwd)"
  echo "configured=\${MSWEA_CONFIGURED-}"
  echo "oab=\${OPENAI_API_BASE-}"
  echo "obu=\${OPENAI_BASE_URL-}"
  echo "model=\${MSWEA_MODEL_NAME-}"
  echo "key=\${OPENAI_API_KEY:+set}"
} >> "${fx.envLog}"
`;
}

/** Fake `mini` bodies for the scripted scenarios (no secrets embedded). */
const BODIES = {
  happy: `echo 'mini progress line'
printf '%s' '{"trajectory":[{"role":"user","content":"q"},{"role":"assistant","content":"final answer from trajectory"}]}' > "$traj"
`,
  authFail: `echo 'litellm.AuthenticationError: 401 Unauthorized - invalid api key' >&2
exit 2
`,
  plainFail: `echo 'boom: dependency exploded' >&2
exit 3
`,
  /** No trajectory file → the final answer falls back to the stdout tail. */
  stdoutOnly: `echo 'fallback stdout line one'
echo 'fallback stdout line two'
`,
  /** sleep with stdout/stderr off the pipes so the child's death closes them. */
  sleep: 'sleep 30 >/dev/null 2>&1 &\nwait $!\n',
} as const;

/** Echoes the credential back on stdout AND inside the trajectory (sanitizer fixture). */
function echoSecretBody(secret: string): string {
  return `echo "running with ${secret}"
printf '%s' '{"trajectory":[{"role":"assistant","content":"done using ${secret}"}]}' > "$traj"
`;
}

/** Different final answer per invocation (multi-turn replay fixture). */
function countingBody(countFile: string): string {
  return `n=$(($(cat "${countFile}" 2>/dev/null || echo 0) + 1))
echo "$n" > "${countFile}"
if [ "$n" -eq 1 ]; then
  printf '%s' '{"trajectory":[{"role":"assistant","content":"first answer"}]}' > "$traj"
else
  printf '%s' '{"trajectory":[{"role":"assistant","content":"second answer"}]}' > "$traj"
fi
`;
}

function writeFakeMini(fx: Fixtures, body: string, name = 'mini'): void {
  const bin = join(fx.binDir, name);
  writeFileSync(bin, `#!/bin/sh${recorderScript(fx)}${body}`, { mode: 0o755 });
  chmodSync(bin, 0o755);
}

function makeFixtures(opts: { withBinary?: boolean; body?: string } = {}): Fixtures {
  const root = mkdtempSync(join(tmpdir(), 'mini-provider-test-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fx: Fixtures = {
    root,
    binDir,
    argvLog: join(root, 'argv.log'),
    promptsLog: join(root, 'prompts.log'),
    envLog: join(root, 'env.log'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  if (opts.withBinary !== false) {
    writeFakeMini(fx, opts.body ?? BODIES.happy);
  }
  return fx;
}

function readLog(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readPrompts(fx: Fixtures): string[] {
  return readLog(fx.promptsLog).split(PROMPT_SEP).map(entry => entry.trim()).filter(Boolean);
}

/** Collect everything a queryStream iterator yields for the given prompts. */
async function drainStream(
  provider: MiniSweAgentProvider,
  prompts: Array<string | UserInput>,
  extraOptions: Partial<AgentQueryOptions> = {},
): Promise<AgentMessage[]> {
  const queue = [...prompts];
  async function* input(): AsyncGenerator<UserInput> {
    while (queue.length > 0) {
      const next = queue.shift() as string | UserInput;
      yield typeof next === 'string' ? { role: 'user', content: next } : next;
    }
  }
  const result = provider.queryStream(input(), {
    settingSources: [],
    permissionMode: 'bypassPermissions',
    ...extraOptions,
  } as AgentQueryOptions);
  const messages: AgentMessage[] = [];
  for await (const message of result.iterator) {
    messages.push(message);
  }
  return messages;
}

describe('MiniSweAgentProvider (Issue #5006)', () => {
  let fixtures: Fixtures;

  afterEach(() => {
    fixtures?.cleanup();
  });

  /**
   * The fixture bin dir leads the (otherwise intact) system PATH: the fake
   * `mini` wins the X_OK PATH scan while its shell body still finds sleep/cat.
   * `isolatePath: true` strips the system PATH for "binary missing" honesty on
   * machines that really have mini-swe-agent installed.
   */
  const makeProvider = (fx: Fixtures, isolatePath = false) =>
    new MiniSweAgentProvider({
      env: {
        PATH: isolatePath ? fx.binDir : `${fx.binDir}:${process.env.PATH ?? ''}`,
        DISCLAUDE_STALL_TIMEOUT_MS: '5000',
      },
    });

  // --------------------------------------------------------------------------
  // Detection: PATH scan, alias, explicit path, unavailable reasons
  // --------------------------------------------------------------------------

  it("exposes name 'miniswe'", () => {
    fixtures = makeFixtures({ withBinary: false });
    expect(makeProvider(fixtures).name).toBe('miniswe');
  });

  it('validateConfig(): true when an executable mini is on PATH', () => {
    fixtures = makeFixtures({});
    expect(makeProvider(fixtures).validateConfig()).toBe(true);
  });

  it('validateConfig(): false when the binary is missing from PATH', () => {
    fixtures = makeFixtures({ withBinary: false });
    expect(makeProvider(fixtures, true).validateConfig()).toBe(false);
  });

  it('validateConfig(): false when a same-named file exists but is NOT executable', () => {
    fixtures = makeFixtures({ withBinary: false });
    writeFileSync(join(fixtures.binDir, 'mini'), 'not executable', { mode: 0o644 });
    expect(makeProvider(fixtures, true).validateConfig()).toBe(false);
  });

  it('validateConfig(): false (never throws) with an empty PATH', () => {
    fixtures = makeFixtures({});
    expect(new MiniSweAgentProvider({ env: { PATH: '' } }).validateConfig()).toBe(false);
  });

  it('probes the packaged mini-swe-agent alias when `mini` is absent', () => {
    fixtures = makeFixtures({ withBinary: false });
    writeFakeMini(fixtures, 'exit 0\n', 'mini-swe-agent');
    expect(makeProvider(fixtures, true).validateConfig()).toBe(true);
  });

  it('accepts an explicit absolute binary path', () => {
    fixtures = makeFixtures({ withBinary: false });
    const bin = join(fixtures.root, 'custom-mini');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    chmodSync(bin, 0o755);
    expect(new MiniSweAgentProvider({ binary: bin, env: { PATH: '' } }).validateConfig()).toBe(true);
  });

  it('getInfo(): unavailable with install hint when the binary is missing', () => {
    fixtures = makeFixtures({ withBinary: false });
    const info = makeProvider(fixtures, true).getInfo();
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toMatch(/mini-swe-agent executable not found/);
    expect(info.unavailableReason).toMatch(/pipx install mini-swe-agent/);
  });

  it('getInfo(): adds a credential hint when the bound LLM api reference resolves empty', () => {
    fixtures = makeFixtures({});
    const info = makeProvider(fixtures).getInfo({ apiKey: '' } as never);
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toMatch(/llms\.<name>\.api\.apiKey/);
  });

  it('getInfo(): available when the binary exists and a credential is bound', () => {
    fixtures = makeFixtures({});
    expect(makeProvider(fixtures).getInfo({ apiKey: 'sk-x' } as never).available).toBe(true);
  });

  it('queryStream(): throws the actionable BINARY_MISSING error without a binary', () => {
    fixtures = makeFixtures({ withBinary: false });
    const provider = makeProvider(fixtures, true);
    expect(() => provider.queryStream(undefined as never, { settingSources: [] } as AgentQueryOptions))
      .toThrow(/mini-swe-agent executable not found[\s\S]*pipx install mini-swe-agent[\s\S]*miniswe\.binary/);
  });

  it('dispose() forces checks false and makes queryStream throw', () => {
    fixtures = makeFixtures({});
    const provider = makeProvider(fixtures);
    provider.dispose();
    expect(provider.validateConfig()).toBe(false);
    expect(provider.getInfo().unavailableReason).toMatch(/disposed/i);
    expect(() => provider.queryStream(undefined as never, { settingSources: [] } as AgentQueryOptions))
      .toThrow(/disposed/i);
    expect(() => provider.dispose()).not.toThrow();
  });

  // --------------------------------------------------------------------------
  // Fail-fast policy gates
  // --------------------------------------------------------------------------

  it('rejects permissionMode "default" (ask) — fail closed, no approval axis', () => {
    fixtures = makeFixtures({});
    const provider = makeProvider(fixtures);
    expect(() => provider.queryStream(undefined as never, {
      settingSources: [], permissionMode: 'default',
    } as AgentQueryOptions)).toThrow(/permissionMode "default" \(ask\) cannot be honored headlessly/);
  });

  it('rejects an unknown permissionMode', () => {
    fixtures = makeFixtures({});
    const provider = makeProvider(fixtures);
    expect(() => provider.queryStream(undefined as never, {
      settingSources: [], permissionMode: 'plan' as never,
    } as AgentQueryOptions)).toThrow(/unknown permissionMode "plan"/);
  });

  it('rejects host tool definitions (the CLI cannot dispatch them)', () => {
    fixtures = makeFixtures({});
    const provider = makeProvider(fixtures);
    expect(() => provider.queryStream(undefined as never, {
      settingSources: [], tools: [{} as never],
    } as AgentQueryOptions)).toThrow(/host tools are unsupported/);
  });

  // --------------------------------------------------------------------------
  // Bridge: happy path, env projection, argv, cwd
  // --------------------------------------------------------------------------

  it('maps a run onto progress status → trajectory final answer → turn terminator', async () => {
    fixtures = makeFixtures({ body: BODIES.happy });
    const messages = await drainStream(makeProvider(fixtures), ['fix the bug'], {
      model: 'openai/gpt-test',
      env: { OPENAI_BASE_URL: 'http://litellm.local:4000/v1', OPENAI_API_KEY: 'sk-mini-test' },
      cwd: fixtures.root,
    });
    const types = messages.map(m => m.type);
    expect(types).toContain('status');
    expect(types[types.length - 1]).toBe('result');

    const status = messages.find(m => m.type === 'status') as AgentMessage;
    expect(status.role).toBe('system');
    expect(status.content).toBe('mini progress line');
    expect((status.metadata as Record<string, unknown>).transientStatus).toBe(true);

    const final = messages.find(m => m.type === 'text') as AgentMessage;
    expect(final.role).toBe('assistant');
    expect(final.content).toBe('final answer from trajectory');

    const result = messages[messages.length - 1];
    expect((result.metadata as Record<string, unknown> | undefined)?.terminatedReason).toBeUndefined();

    // Child env: headless-safe additions + the managed credential projection.
    const envLog = readLog(fixtures.envLog);
    expect(envLog).toContain('configured=true');
    expect(envLog).toContain('oab=http://litellm.local:4000/v1');
    expect(envLog).toContain('obu=http://litellm.local:4000/v1');
    expect(envLog).toContain('key=set');
    expect(envLog).toContain(`pwd=${fixtures.root}`);

    // The credential travels via env, never argv.
    const argvLog = readLog(fixtures.argvLog);
    expect(argvLog).toContain('-m openai/gpt-test');
    expect(argvLog).not.toContain('sk-mini-test');
  }, 15_000);

  it('keeps prompt context bounded: replays prior final answers on the next turn', async () => {
    fixtures = makeFixtures({ withBinary: false });
    writeFakeMini(fixtures, countingBody(join(fixtures.root, 'count')));

    const messages = await drainStream(makeProvider(fixtures), ['first question', 'second question']);
    const finals = messages.filter(m => m.type === 'text').map(m => m.content);
    expect(finals).toEqual(['first answer', 'second answer']);

    const prompts = readPrompts(fixtures);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('first question');
    expect(prompts[0]).not.toContain('no native session resume');
    // No native session resume → turn 2 replays turn 1's final answer.
    expect(prompts[1]).toContain('second question');
    expect(prompts[1]).toContain('first answer');
    expect(prompts[1]).toContain('no native session resume');
  }, 15_000);

  it('falls back to the bounded stdout tail when the trajectory has no assistant message', async () => {
    fixtures = makeFixtures({ body: BODIES.stdoutOnly });
    const messages = await drainStream(makeProvider(fixtures), ['task']);
    const final = messages.find(m => m.type === 'text') as AgentMessage;
    expect(final?.content).toContain('fallback stdout line one');
    expect(final?.content).toContain('fallback stdout line two');
  }, 15_000);

  // --------------------------------------------------------------------------
  // Error mapping
  // --------------------------------------------------------------------------

  it('non-zero exit with an auth failure adds the credential hint and turn_failed', async () => {
    fixtures = makeFixtures({ body: BODIES.authFail });
    const messages = await drainStream(makeProvider(fixtures), ['task']);
    const error = messages.find(m => m.type === 'error') as AgentMessage;
    expect(error?.content).toContain('mini exited with code 2');
    expect(error?.content).toContain('401');
    expect(error?.content).toMatch(/llms\.<name>\.api\.apiKey/);
    const result = messages[messages.length - 1];
    expect(result.type).toBe('result');
    expect((result.metadata as Record<string, unknown>).terminatedReason).toBe('turn_failed');
    expect(String((result.metadata as Record<string, unknown>).terminationDetail)).toContain('exit=2');
  }, 15_000);

  it('non-zero exit without an auth signature maps the stderr detail', async () => {
    fixtures = makeFixtures({ body: BODIES.plainFail });
    const messages = await drainStream(makeProvider(fixtures), ['task']);
    const error = messages.find(m => m.type === 'error') as AgentMessage;
    expect(error?.content).toContain('mini exited with code 3');
    expect(error?.content).toContain('boom: dependency exploded');
    expect(error?.content).not.toMatch(/api\.apiKey/);
    expect((messages[messages.length - 1].metadata as Record<string, unknown>).terminatedReason).toBe('turn_failed');
  }, 15_000);

  it('maps a spawn failure with the install hint', async () => {
    fixtures = makeFixtures({});
    // The binary exists for the X_OK probe at queryStream time but is deleted
    // before the first next() spawns the child (real ENOENT at spawn).
    const provider = new MiniSweAgentProvider({
      binary: join(fixtures.binDir, 'mini'),
      env: { PATH: fixtures.binDir, DISCLAUDE_STALL_TIMEOUT_MS: '5000' },
    });
    async function* input(): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'task' };
    }
    const result = provider.queryStream(input(), {
      settingSources: [], permissionMode: 'bypassPermissions',
    } as AgentQueryOptions);
    rmSync(join(fixtures.binDir, 'mini'));
    const messages: AgentMessage[] = [];
    for await (const message of result.iterator) {
      messages.push(message);
    }
    const error = messages.find(m => m.type === 'error') as AgentMessage;
    expect(error?.content).toMatch(/failed to spawn/);
    expect(error?.content).toMatch(/installed and on PATH/);
    expect((messages[messages.length - 1].metadata as Record<string, unknown>).terminatedReason).toBe('turn_failed');
  }, 15_000);

  // --------------------------------------------------------------------------
  // Timeout + cancel
  // --------------------------------------------------------------------------

  it('terminates a stalled run at the configured timeout with turn_failed', async () => {
    fixtures = makeFixtures({ body: BODIES.sleep });
    const provider = new MiniSweAgentProvider({
      env: { PATH: `${fixtures.binDir}:${process.env.PATH ?? ''}`, DISCLAUDE_STALL_TIMEOUT_MS: '5000' },
      timeoutMs: 400,
    });
    const messages = await drainStream(provider, ['long task']);
    const error = messages.find(m => m.type === 'error') as AgentMessage;
    expect(error?.content).toContain('terminated by the runner timeout policy (400ms');
    expect(error?.content).toContain('agents.<name>.miniswe.timeoutMs');
    const result = messages[messages.length - 1];
    expect((result.metadata as Record<string, unknown>).terminatedReason).toBe('turn_failed');
    expect(String((result.metadata as Record<string, unknown>).terminationDetail)).toContain('timedOut=true');
  }, 15_000);

  it('cancel() ends the stream and kills the in-flight run without a terminator', async () => {
    fixtures = makeFixtures({ body: BODIES.sleep });
    const provider = makeProvider(fixtures);
    async function* input(): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'long task' };
    }
    const result = provider.queryStream(input(), {
      settingSources: [], permissionMode: 'bypassPermissions',
    } as AgentQueryOptions);
    const collected = (async () => {
      const out: AgentMessage[] = [];
      for await (const m of result.iterator) {
        out.push(m);
      }
      return out;
    })();
    // Wait until the child is actually up (it records env facts first).
    await new Promise(resolve => setTimeout(resolve, 400));
    result.handle.cancel();
    const messages = await collected;
    expect(messages.map(m => m.type)).not.toContain('result');
    // The run really started before the cancel landed.
    expect(readLog(fixtures.envLog)).toContain('pwd=');
  }, 15_000);

  it('ends the stream when cancel() fires before the generator starts', async () => {
    fixtures = makeFixtures({ body: BODIES.sleep });
    const provider = makeProvider(fixtures);
    async function* input(): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'never runs' };
    }
    const result = provider.queryStream(input(), {
      settingSources: [], permissionMode: 'bypassPermissions',
    } as AgentQueryOptions);
    result.handle.cancel(); // BEFORE any next()
    const messages: AgentMessage[] = [];
    for await (const message of result.iterator) {
      messages.push(message);
    }
    expect(messages).toEqual([]);
    expect(readLog(fixtures.envLog)).toBe(''); // the child never spawned
  }, 15_000);

  // --------------------------------------------------------------------------
  // Sanitization: credentials never leave the bridge in clear text
  // --------------------------------------------------------------------------

  it('redacts an echoed credential from progress lines and the final answer, and keeps it out of argv', async () => {
    const SECRET = 'sk-mini-supersecret-42';
    fixtures = makeFixtures({ withBinary: false });
    writeFakeMini(fixtures, echoSecretBody(SECRET));

    registerModelSecretNames(['MINISWE_TEST_KEY']);
    process.env.MINISWE_TEST_KEY = SECRET;
    try {
      const messages = await drainStream(makeProvider(fixtures), ['task'], {
        env: { OPENAI_API_KEY: SECRET, OPENAI_BASE_URL: 'http://litellm.local:4000/v1' },
      });
      const status = messages.find(m => m.type === 'status') as AgentMessage;
      expect(status?.content).toContain('[REDACTED]');
      expect(status?.content).not.toContain(SECRET);
      const final = messages.find(m => m.type === 'text') as AgentMessage;
      expect(final?.content).toBe('done using [REDACTED]');
      // The credential reached the child via env (managed projection)…
      expect(readLog(fixtures.envLog)).toContain('key=set');
      // …never via argv or the prompt.
      expect(readLog(fixtures.argvLog)).not.toContain(SECRET);
      expect(readLog(fixtures.promptsLog)).not.toContain(SECRET);
    } finally {
      delete process.env.MINISWE_TEST_KEY;
    }
  }, 15_000);
});
