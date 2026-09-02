/**
 * Tests for Codex CLI Agent Provider — Issue #4629 (S1 skeleton) + #4630 (S2 exec bridge).
 *
 * Coverage focus:
 * - validateConfig() fail-fast environment checks: binary-on-PATH scan and
 *   OAuth auth.json presence (CODEX_HOME-aware). Both probes are exercised
 *   against REAL temp fixtures (fake `codex` executable + auth.json) via the
 *   injected env — no fs mocking, no real codex CLI needed.
 * - getInfo() surfaces actionable unavailableReason (install + login hints).
 * - queryStream (S2): the full subprocess bridge against a scripted fake
 *   `codex` — happy-path event flow, thread_id → handle.sessionId, exit-code
 *   error mapping, actionable throw when the binary is missing, cancel()
 *   teardown, dispose() guard. Real spawn/readline/timer machinery, no mocks.
 * - createInlineTool / createMcpServer throw not-supported (#4627 open q).
 * - Lifecycle: dispose() flips state, is idempotent, forces checks false.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CodexAgentProvider, type CodexQuotaStats } from './provider.js';
import type { AgentQueryOptions, UserInput } from '../../types.js';

/** Temp fixtures: a bin dir with a fake executable `codex`, and a CODEX_HOME. */
interface Fixtures {
  binDir: string;
  codexHome: string;
  cleanup: () => void;
}

/**
 * Real-fs fixtures: the fake `codex` is a chmod-ed shell script so the X_OK
 * probe genuinely succeeds — testing the actual accessSync mechanism. When
 * `body` is given, the script runs it (for S2 bridge tests); TERM handling
 * follows the background+`wait` pattern (see codex-runner.test.ts notes).
 */
function makeFixtures(
  opts: { withBinary: boolean; withAuth: boolean; body?: string },
): Fixtures {
  const root = mkdtempSync(join(tmpdir(), 'codex-provider-test-'));
  const binDir = join(root, 'bin');
  const codexHome = join(root, 'codex-home');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  if (opts.withBinary) {
    const bin = join(binDir, 'codex');
    writeFileSync(
      bin,
      `#!/bin/sh\n${opts.body ?? 'echo codex 0.0.0\n'}`,
      { mode: 0o755 },
    );
    chmodSync(bin, 0o755);
  }
  if (opts.withAuth) {
    writeFileSync(join(codexHome, 'auth.json'), '{"tokens":{"access_token":"x"}}');
  }

  return {
    binDir,
    codexHome,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const NOT_SUPPORTED_MSG =
  'CodexAgentProvider: tools/MCP mapping is not supported yet — tracked as an open question on #4627.';

/** A scripted codex run: thread → agent_message → turn.completed (exit 0). */
const HAPPY_BODY = `cat <<'JSONL'
{"type":"thread.started","thread_id":"t-abc"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello from codex"}}
{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}
JSONL
`;

/** Collect everything a queryStream iterator yields, then end the input. */
async function drainStream(
  provider: CodexAgentProvider,
  prompts: string[],
  extraOptions: Partial<AgentQueryOptions> = {},
): Promise<{ messages: unknown[]; sessionId?: string }> {
  const queue = [...prompts];
  async function* input(): AsyncGenerator<UserInput> {
    while (queue.length > 0) {
      yield { role: 'user', content: queue.shift() as string };
    }
  }
  const result = provider.queryStream(input(), {
    settingSources: [],
    ...extraOptions,
  } as AgentQueryOptions);
  const messages: unknown[] = [];
  for await (const message of result.iterator) {
    messages.push(message);
  }
  return { messages, sessionId: result.handle.sessionId };
}

describe('CodexAgentProvider (Issues #4629 + #4630)', () => {
  let fixtures: Fixtures;

  afterEach(() => {
    fixtures?.cleanup();
  });

  /**
   * `isolatePath: false` strips the system PATH — needed for "binary
   * missing" tests to be honest on dev machines that HAVE a real codex
   * CLI installed (it would be found via the inherited PATH).
   */
  const makeProvider = (
    fx: Fixtures,
    execTimeoutMs?: number,
    isolatePath = true,
  ) =>
    new CodexAgentProvider({
      // Keep the system PATH after the fixture dir: the fake `codex` wins the
      // PATH scan, while its shell body still finds cat/sleep in /bin etc.
      env: {
        PATH: isolatePath
          ? `${fx.binDir}:${process.env.PATH ?? ''}`
          : fx.binDir,
        CODEX_HOME: fx.codexHome,
      },
      ...(execTimeoutMs ? { execTimeoutMs } : {}),
    });

  // --------------------------------------------------------------------------
  // Properties
  // --------------------------------------------------------------------------

  it("exposes name 'codex' and the forget-session version", () => {
    fixtures = makeFixtures({ withBinary: false, withAuth: false });
    const provider = makeProvider(fixtures);
    expect(provider.name).toBe('codex');
    expect(provider.version).toBe('0.6.0-forget-session');
  });

  // --------------------------------------------------------------------------
  // validateConfig — S1 fail-fast environment checks
  // --------------------------------------------------------------------------

  describe('validateConfig (binary + auth probes)', () => {
    it('returns true when the binary is on PATH and auth.json exists', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true });
      expect(makeProvider(fixtures).validateConfig()).toBe(true);
    });

    it('returns false when the codex binary is missing from PATH', () => {
      // isolatePath: dev machines may have a real codex on the system PATH.
      fixtures = makeFixtures({ withBinary: false, withAuth: true });
      expect(makeProvider(fixtures, undefined, false).validateConfig()).toBe(false);
    });

    it('returns false when a same-named file exists but is NOT executable', () => {
      fixtures = makeFixtures({ withBinary: false, withAuth: true });
      // X_OK probe must reject non-executable files, not just absent ones.
      const bin = join(fixtures.binDir, 'codex');
      writeFileSync(bin, 'not executable', { mode: 0o644 });
      expect(makeProvider(fixtures, undefined, false).validateConfig()).toBe(false);
    });

    it('returns false when auth.json is absent (OAuth not completed)', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: false });
      expect(makeProvider(fixtures).validateConfig()).toBe(false);
    });

    it('returns false (never throws) with an empty PATH', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: false });
      expect(
        new CodexAgentProvider({
          env: { PATH: '', CODEX_HOME: fixtures.codexHome },
        }).validateConfig(),
      ).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getInfo — actionable unavailableReason
  // --------------------------------------------------------------------------

  describe('getInfo (actionable messages)', () => {
    it('is available with no reason when binary + auth are present', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true });
      const info = makeProvider(fixtures).getInfo();
      expect(info.available).toBe(true);
      expect(info.unavailableReason).toBeUndefined();
    });

    it('reports BOTH the install hint and the login hint when nothing is set up', () => {
      fixtures = makeFixtures({ withBinary: false, withAuth: false });
      const info = makeProvider(fixtures, undefined, false).getInfo();
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toMatch(/npm install -g @openai\/codex/);
      expect(info.unavailableReason).toMatch(/codex login/);
    });

    it('reports only the login hint when the binary exists but auth is missing', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: false });
      const info = makeProvider(fixtures).getInfo();
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toMatch(/codex login/);
      expect(info.unavailableReason).not.toMatch(/npm install/);
    });
  });

  // --------------------------------------------------------------------------
  // queryStream — S2 exec bridge (#4630), real fake-binary subprocesses
  // --------------------------------------------------------------------------

  describe('queryStream (exec bridge, Issue #4630)', () => {
    it('injects project-local builtin resource discovery into the Codex prompt', async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'codex-project-workspace-'));
      try {
        mkdirSync(join(workspace, 'skills', 'demo'), { recursive: true });
        mkdirSync(join(workspace, '.claude', 'skills', 'claude-local'), { recursive: true });
        writeFileSync(
          join(workspace, 'skills', 'demo', 'SKILL.md'),
          '---\ndescription: Demo project skill\n---\nUse the demo workflow.',
        );
        writeFileSync(
          join(workspace, '.claude', 'skills', 'claude-local', 'SKILL.md'),
          '---\ndescription: Claude local skill\n---\nUse the Claude local workflow.',
        );
        fixtures = makeFixtures({
          withBinary: true,
          withAuth: true,
          body: `printf '%s' "$*" > "$CODEX_HOME/prompt"\n${HAPPY_BODY}`,
        });
        await drainStream(makeProvider(fixtures), ['hi'], { cwd: workspace });
        const prompt = readFileSync(join(fixtures.codexHome, 'prompt'), 'utf8');
        expect(prompt).toContain('demo');
        expect(prompt).toContain('Demo project skill');
        expect(prompt).toContain(join(workspace, 'skills', 'demo', 'SKILL.md'));
        expect(prompt).toContain('Claude local skill');
        expect(prompt).toContain(join(workspace, '.claude', 'skills', 'claude-local', 'SKILL.md'));
        expect(prompt).toContain('User request:\nhi');
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }, 15_000);

    it('bridges a happy-path run: text + result, thread_id → sessionId', async () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true, body: HAPPY_BODY });
      const { messages, sessionId } = await drainStream(makeProvider(fixtures), ['hi']);
      const types = (messages as Array<{ type: string }>).map((m) => m.type);
      expect(types).toContain('text');
      expect(types[types.length - 1]).toBe('result');
      const text = (messages as Array<{ type: string; content: string }>).find(
        (m) => m.type === 'text',
      );
      expect(text?.content).toBe('hello from codex');
      expect(sessionId).toBe('t-abc');
    }, 15_000);

    it('maps a non-zero exit onto error + result terminator', async () => {
      fixtures = makeFixtures({
        withBinary: true,
        withAuth: true,
        body: 'echo "usage limit reached" >&2\nexit 2',
      });
      const { messages } = await drainStream(makeProvider(fixtures), ['hi']);
      const types = (messages as Array<{ type: string }>).map((m) => m.type);
      expect(types).toContain('error');
      expect(types[types.length - 1]).toBe('result'); // turn still completes
      const error = (messages as Array<{ type: string; content: string }>).find(
        (m) => m.type === 'error',
      );
      expect(error?.content).toMatch(/exited with code 2/);
      expect(error?.content).toMatch(/usage limit reached/);
    }, 15_000);

    it('runs one exec per user input (multi-turn within one stream)', async () => {
      // Same scripted run per invocation: each user input spawns its own
      // exec → one text + one turn terminator each.
      fixtures = makeFixtures({ withBinary: true, withAuth: true, body: HAPPY_BODY });
      const { messages } = await drainStream(makeProvider(fixtures), ['a', 'b']);
      const texts = (messages as Array<{ type: string; content: string }>)
        .filter((m) => m.type === 'text')
        .map((m) => m.content);
      const results = (messages as Array<{ type: string }>).filter(
        (m) => m.type === 'result',
      );
      expect(texts).toEqual(['hello from codex', 'hello from codex']);
      expect(results.length).toBe(2); // one turn terminator per run
    }, 20_000);

    it('throws an actionable error when the binary is missing', () => {
      // isolatePath: dev machines may have a real codex on the system PATH —
      // the throw must be tested against a genuinely binary-less PATH.
      fixtures = makeFixtures({ withBinary: false, withAuth: true });
      const provider = makeProvider(fixtures, undefined, false);
      expect(() => provider.queryStream(undefined as never, { settingSources: [] } as AgentQueryOptions))
        .toThrow(/codex CLI binary not found on PATH.*npm install -g @openai\/codex/s);
    });

    it('cancel() ends the stream and kills the in-flight run', async () => {
      fixtures = makeFixtures({
        withBinary: true,
        withAuth: true,
        body: 'sleep 30 >/dev/null 2>&1 &\nwait $!',
      });
      const provider = makeProvider(fixtures);
      async function* input(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'long task' };
      }
      const result = provider.queryStream(input(), { settingSources: [] } as AgentQueryOptions);
      // Consume in the background; cancel mid-run after the process is up.
      const collected = (async () => {
        const out: unknown[] = [];
        for await (const m of result.iterator) {
          out.push(m);
        }
        return out;
      })();
      await new Promise((r) => setTimeout(r, 400));
      result.handle.cancel();
      const messages = await collected;
      // Aborted stream ends without a turn terminator (pi parity).
      const types = (messages as Array<{ type: string }>).map((m) => m.type);
      expect(types).not.toContain('result');
    }, 15_000);

    it('dispose() makes queryStream throw', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true });
      const provider = makeProvider(fixtures);
      provider.dispose();
      expect(() => provider.queryStream(undefined as never, { settingSources: [] } as AgentQueryOptions))
        .toThrow(/disposed/i);
    });
  });

  // --------------------------------------------------------------------------
  // queryStream — S3 sessions & auth (#4628): resume per turn, latch rules,
  // 401 re-auth detection, resume-target-gone self-heal. The fake `codex`
  // counts invocations via $CODEX_HOME (injected through the provider env)
  // and records its argv per invocation so tests assert the EXACT argv the
  // bridge built — real subprocesses, no mocks.
  // --------------------------------------------------------------------------

  describe('queryStream resume & auth (Issue #4628)', () => {
    /** Script prefix: count invocations, record argv into CODEX_HOME. */
    const ARGV_RECORDER = `
n=$(cat "$CODEX_HOME/count" 2>/dev/null || echo 0)
n=$((n+1)); echo "$n" > "$CODEX_HOME/count"
echo "$*" > "$CODEX_HOME/argv-$n"
`;

    const argvOf = (fx: Fixtures, invocation: number): string => {
      const raw = readFileSync(join(fx.codexHome, `argv-${invocation}`), 'utf-8');
      return raw.trim();
    };

    it('resumes the latched thread on follow-up turns (exec resume <id>)', async () => {
      // Run 1 (fresh) → latches t-abc; run 2 must carry `resume … t-abc`.
      const body = `${ARGV_RECORDER}
if grep -q "exec resume " "$CODEX_HOME/argv-$n"; then
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-abc"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"resumed turn"}}
{"type":"turn.completed"}
JSONL
else
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-abc"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"first turn"}}
{"type":"turn.completed"}
JSONL
fi
`;
      fixtures = makeFixtures({ withBinary: true, withAuth: true, body });
      const { messages, sessionId } = await drainStream(makeProvider(fixtures), ['a', 'b']);
      expect(argvOf(fixtures, 1)).not.toContain('resume');
      // S4 (#4631): every run now carries the resolved sandbox level.
      expect(argvOf(fixtures, 2)).toContain(
        'exec resume --json --skip-git-repo-check -c sandbox_mode=workspace-write -c sandbox_workspace_write.network_access=true t-abc -- b',
      );
      const texts = (messages as Array<{ type: string; content: string }>)
        .filter((m) => m.type === 'text')
        .map((m) => m.content);
      expect(texts).toEqual(['first turn', 'resumed turn']);
      expect(sessionId).toBe('t-abc');
    }, 20_000);

    it('omits the legacy gpt-5.1-codex alias and lets ChatGPT choose the CLI default', async () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true, body: `${ARGV_RECORDER}${HAPPY_BODY}` });
      await drainStream(makeProvider(fixtures), ['hello'], { model: 'gpt-5.1-codex' });
      expect(argvOf(fixtures, 1)).not.toContain('-m');
    }, 20_000);

    it('starts a fresh session after a completed turn reaches the resume budget', async () => {
      fixtures = makeFixtures({
        withBinary: true,
        withAuth: true,
        body: `${ARGV_RECORDER}
if [ "$n" = 1 ]; then
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-old"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"first"}}
{"type":"turn.completed","usage":{"input_tokens":10}}
JSONL
elif [ "$n" = 2 ]; then
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-old"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"large"}}
{"type":"turn.completed","usage":{"input_tokens":100}}
JSONL
else
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-new"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"fresh"}}
{"type":"turn.completed","usage":{"input_tokens":10}}
JSONL
fi
`,
      });
      const provider = new CodexAgentProvider({
        env: { PATH: `${fixtures.binDir}:${process.env.PATH ?? ''}`, CODEX_HOME: fixtures.codexHome },
        maxResumeInputTokens: 100,
      });
      const { messages } = await drainStream(provider, ['a', 'b', 'c']);
      expect(argvOf(fixtures, 2)).toContain('exec resume');
      expect(argvOf(fixtures, 3)).not.toContain('exec resume');
      expect((messages as Array<{ type: string; content: string }>)
        .filter((m) => m.type === 'text').map((m) => m.content))
       .toEqual(['first', 'large', 'fresh']);
    }, 20_000);

    it('does NOT latch a thread from a failed turn (thread.started fires on failures)', async () => {
      // Verified live (0.132.0): even a 401-failed run emits thread.started —
      // the anchor must come from a COMPLETED turn only.
      fixtures = makeFixtures({
        withBinary: true,
        withAuth: true,
        body: `${ARGV_RECORDER}
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-x"}
{"type":"turn.started"}
JSONL
echo "boom" >&2
exit 3
`,
      });
      const { messages } = await drainStream(makeProvider(fixtures), ['a', 'b']);
      expect(argvOf(fixtures, 2)).not.toContain('resume');
      const error = (messages as Array<{ type: string; content: string }>).find(
        (m) => m.type === 'error',
      );
      expect(error?.content).toMatch(/exited with code 3/);
    }, 20_000);

    it('maps a 401 run onto the actionable re-login notice and keeps the chat resumable', async () => {
      // Real captured shape (auth removed, 0.132.0): reconnect error events
      // with "unexpected status 401 Unauthorized" + exit 1. The adapter
      // downgrades Reconnecting… to status, so detection must read raw text.
      fixtures = makeFixtures({
        withBinary: true,
        withAuth: true,
        body: `${ARGV_RECORDER}
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-401"}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}
JSONL
exit 1
`,
      });
      const { messages } = await drainStream(makeProvider(fixtures), ['a', 'b']);
      const error = (messages as Array<{ type: string; content: string }>).find(
        (m) => m.type === 'error',
      );
      expect(error?.content).toMatch(/codex login/);
      expect(error?.content).not.toMatch(/exited with code/); // 401 wins over exit noise
      expect(argvOf(fixtures, 2)).not.toContain('resume'); // no anchor latched
    }, 20_000);

    it('detects 401 from stderr alone (no stdout error events)', async () => {
      fixtures = makeFixtures({
        withBinary: true,
        withAuth: true,
        body: 'echo "HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses" >&2\nexit 1',
      });
      const { messages } = await drainStream(makeProvider(fixtures), ['hi']);
      const error = (messages as Array<{ type: string; content: string }>).find(
        (m) => m.type === 'error',
      );
      expect(error?.content).toMatch(/codex login/);
    }, 15_000);

    it('self-heals when the resume target is gone: clears the id, next turn starts fresh', async () => {
      // Run 1 latches t-abc; run 2 (resume) hits the real captured error
      // "no rollout found for thread id" (0.132.0); run 3 must be FRESH.
      const body = `${ARGV_RECORDER}
if grep -q "exec resume " "$CODEX_HOME/argv-$n"; then
echo "Error: thread/resume: thread/resume failed: no rollout found for thread id t-abc (code -32600)" >&2
exit 1
else
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-abc"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"turn ok"}}
{"type":"turn.completed"}
JSONL
fi
`;
      fixtures = makeFixtures({ withBinary: true, withAuth: true, body });
      const { messages } = await drainStream(makeProvider(fixtures), ['a', 'b', 'c']);
      expect(argvOf(fixtures, 2)).toContain('resume'); // latched from run 1
      expect(argvOf(fixtures, 3)).not.toContain('resume'); // self-healed
      const errors = (messages as Array<{ type: string; content: string }>)
        .filter((m) => m.type === 'error')
        .map((m) => m.content);
      expect(errors.join('\n')).toMatch(/新会话/); // user told about the reset
    }, 25_000);

    it('keeps the conversation anchor across a transient failed resume-able run (timeout)', async () => {
      // A mid-conversation timeout must NOT drop the anchor — the retry
      // resumes into the same thread instead of silently restarting context.
      const body = `${ARGV_RECORDER}
if [ "$n" -eq 1 ]; then
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-keep"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"first"}}
{"type":"turn.completed"}
JSONL
else
sleep 30 >/dev/null 2>&1 &
wait $!
fi
`;
      fixtures = makeFixtures({ withBinary: true, withAuth: true, body });
      const provider = makeProvider(fixtures, 1_500); // 1.5s per-run timeout
      const { messages } = await drainStream(provider, ['a', 'b', 'c']);
      expect(argvOf(fixtures, 2)).toContain('resume'); // after turn 1 success
      expect(argvOf(fixtures, 3)).toContain('resume'); // anchor survived the timeout
      const errors = (messages as Array<{ type: string; content: string }>)
        .filter((m) => m.type === 'error')
        .map((m) => m.content);
      expect(errors.join('\n')).toMatch(/timed out/);
    }, 30_000);
  });

  // --------------------------------------------------------------------------
  // queryStream — S4 permission mapping (#4631): disclaude policy → codex
  // exec sandbox. The fake `codex` records its argv per invocation into
  // CODEX_HOME so tests assert the exact -c sandbox_mode= the bridge built.
  // --------------------------------------------------------------------------

  describe('queryStream sandbox mapping (Issue #4631)', () => {
    const ARGV_BODY = `
echo "$*" > "$CODEX_HOME/argv-1"
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-sb"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed"}
JSONL
`;
    const argvOf = (fx: Fixtures): string =>
      readFileSync(join(fx.codexHome, 'argv-1'), 'utf-8').trim();

    const sandboxedFixtures = (): void => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true, body: ARGV_BODY });
    };

    it("derives workspace-write from permissionMode 'bypassPermissions'/unset (bot default)", async () => {
      sandboxedFixtures();
      await drainStream(makeProvider(fixtures), ['hi']);
      expect(argvOf(fixtures)).toContain('-s workspace-write');
    }, 15_000);

    it("derives read-only from permissionMode 'default' (ask) — no headless approver, fail closed", async () => {
      sandboxedFixtures();
      await drainStream(makeProvider(fixtures), ['hi'], { permissionMode: 'default' });
      expect(argvOf(fixtures)).toContain('-s read-only');
    }, 15_000);

    it('caps at read-only when the denylist blocks mutation tools', async () => {
      sandboxedFixtures();
      await drainStream(makeProvider(fixtures), ['hi'], {
        permissionMode: 'bypassPermissions',
        disallowedTools: ['Bash'],
      });
      expect(argvOf(fixtures)).toContain('-s read-only');
    }, 15_000);

    it('runs unrestricted with ChatAgent’s actual default denylist (claude-only names)', async () => {
      // buildDisallowedTools() output (#4181) — every entry names a
      // claude-only tool, so none of it may degrade the codex backend.
      sandboxedFixtures();
      await drainStream(makeProvider(fixtures), ['hi'], {
        permissionMode: 'bypassPermissions',
        disallowedTools: [
          'EnterPlanMode',
          'AskUserQuestion',
          'CronCreate',
          'CronList',
          'CronDelete',
          'ScheduleWakeup',
        ],
      });
      expect(argvOf(fixtures)).toContain('-s workspace-write');
    }, 15_000);

    it('throws (fail closed, actionable) for a WebSearch denylist entry', () => {
      // Verified live on 0.132.0: codex exec has NO working web-search off
      // switch — a policy demanding it must not run silently weakened.
      sandboxedFixtures();
      const provider = makeProvider(fixtures);
      expect(() =>
        provider.queryStream(undefined as never, {
          settingSources: [],
          disallowedTools: ['WebSearch'],
        } as AgentQueryOptions),
      ).toThrow(/cannot disable its built-in web search.*fail closed/s);
    });

    it('honors the explicit sandboxOverride constructor option over permissionMode', async () => {
      sandboxedFixtures();
      const provider = new CodexAgentProvider({
        env: {
          PATH: `${fixtures.binDir}:${process.env.PATH ?? ''}`,
          CODEX_HOME: fixtures.codexHome,
        },
        sandboxOverride: 'danger-full-access',
      });
      await drainStream(provider, ['hi'], { permissionMode: 'default' });
      expect(argvOf(fixtures)).toContain('-s danger-full-access');
    }, 15_000);

    it('the denylist mutation cap outranks an explicit danger-full-access override', async () => {
      // Security policy (denylist) > convenience preference (explicit config).
      sandboxedFixtures();
      const provider = new CodexAgentProvider({
        env: {
          PATH: `${fixtures.binDir}:${process.env.PATH ?? ''}`,
          CODEX_HOME: fixtures.codexHome,
        },
        sandboxOverride: 'danger-full-access',
      });
      await drainStream(provider, ['hi'], { disallowedTools: ['Write'] });
      expect(argvOf(fixtures)).toContain('-s read-only');
    }, 15_000);
  });

  // --------------------------------------------------------------------------
  // queryStream — S5 quota observability + limit degrade (#4632)
  // --------------------------------------------------------------------------

  describe('queryStream quota & limit (Issue #4632)', () => {
    it('accumulates per-turn usage into process-wide quota stats', async () => {
      // HAPPY_BODY's turn.completed carries {input:10, output:2} per turn.
      fixtures = makeFixtures({ withBinary: true, withAuth: true, body: HAPPY_BODY });
      const provider = makeProvider(fixtures);
      await drainStream(provider, ['a', 'b']);
      const stats = provider.getQuotaStats();
      expect(stats.turnsCompleted).toBe(2);
      expect(stats.inputTokens).toBe(20);
      expect(stats.outputTokens).toBe(4);
      // Copy semantics: mutating the returned object must not leak back.
      const copy = provider.getQuotaStats() as CodexQuotaStats;
      copy.turnsCompleted = 99;
      expect(provider.getQuotaStats().turnsCompleted).toBe(2);
    }, 20_000);

    it('degrades a usage-limit failure to the friendly window-reset notice', async () => {
      // Official wording (OpenAI issues): "You've hit your usage limit.
      // Try again at <ts>" — as a top-level error event, then exit 1.
      fixtures = makeFixtures({
        withBinary: true,
        withAuth: true,
        body: `cat <<'JSONL'
{"type":"thread.started","thread_id":"t-lim"}
{"type":"turn.started"}
{"type":"error","message":"You've hit your usage limit. Try again at Apr 30th, 2026 11:21 AM"}
JSONL
exit 1
`,
      });
      const { messages } = await drainStream(makeProvider(fixtures), ['hi']);
      const error = (messages as Array<{ type: string; content: string }>).find(
        (m) => m.type === 'error',
      );
      expect(error?.content).toMatch(/5 小时\/周滚动窗口/);
      expect(error?.content).toMatch(/Try again at Apr 30th, 2026 11:21 AM/); // codex's own reset hint quoted
      expect(error?.content).not.toMatch(/exited with code/); // limit wins over exit noise
    }, 15_000);

    it('keeps the conversation anchor across a limit failure — recovery needs no restart', async () => {
      // Turn 1 succeeds (latches t-keep); turn 2 hits the limit (latches
      // nothing); turn 3 must RESUME the same thread — the window reset
      // only requires resending, not a session restart (#4632 acceptance).
      const body = `
n=$(cat "$CODEX_HOME/count" 2>/dev/null || echo 0)
n=$((n+1)); echo "$n" > "$CODEX_HOME/count"
echo "$*" > "$CODEX_HOME/argv-$n"
if [ "$n" -eq 2 ]; then
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-keep"}
{"type":"error","message":"You've hit your usage limit. Try again at 5:00 PM"}
JSONL
exit 1
else
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-keep"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}
JSONL
fi
`;
      fixtures = makeFixtures({ withBinary: true, withAuth: true, body });
      const { messages } = await drainStream(makeProvider(fixtures), ['a', 'b', 'c']);
      const argv3 = readFileSync(join(fixtures.codexHome, 'argv-3'), 'utf-8').trim();
      expect(argv3).toContain('resume');
      expect(argv3).toContain('t-keep');
      const results = (messages as Array<{ type: string }>).filter((m) => m.type === 'result');
      expect(results.length).toBe(3); // every turn terminated, session alive
    }, 25_000);

    it('prefers the re-auth diagnosis when a failure carries both 401 and limit wording', async () => {
      fixtures = makeFixtures({
        withBinary: true,
        withAuth: true,
        body: 'echo "unexpected status 401 Unauthorized; You\'ve hit your usage limit. Try again at 5 PM" >&2\nexit 1',
      });
      const { messages } = await drainStream(makeProvider(fixtures), ['hi']);
      const error = (messages as Array<{ type: string; content: string }>).find(
        (m) => m.type === 'error',
      );
      expect(error?.content).toMatch(/codex login/); // auth is the actionable one
    }, 15_000);
  });

  // --------------------------------------------------------------------------
  // Tools / MCP — open question on #4627 (unchanged from S1)
  // --------------------------------------------------------------------------

  describe('stubs', () => {
    it('createInlineTool throws not-supported pointing at #4627', () => {
      fixtures = makeFixtures({ withBinary: false, withAuth: false });
      expect(() =>
        makeProvider(fixtures).createInlineTool({} as never),
      ).toThrow(NOT_SUPPORTED_MSG);
    });

    it('createMcpServer throws not-supported pointing at #4627', () => {
      fixtures = makeFixtures({ withBinary: false, withAuth: false });
      expect(() =>
        makeProvider(fixtures).createMcpServer({} as never),
      ).toThrow(NOT_SUPPORTED_MSG);
    });
  });

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('dispose() forces validateConfig() false and getInfo() unavailable', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true });
      const provider = makeProvider(fixtures);
      provider.dispose();
      expect(provider.validateConfig()).toBe(false);
      const info = provider.getInfo();
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toMatch(/disposed/i);
    });

    it('dispose() is idempotent', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true });
      const provider = makeProvider(fixtures);
      provider.dispose();
      expect(() => provider.dispose()).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// S2 review follow-ups: turn termination guarantees + stall watchdog.
// ---------------------------------------------------------------------------

describe('CodexAgentProvider turn termination (S2 review)', () => {
  let fixtures: Fixtures;

  afterEach(() => {
    fixtures?.cleanup();
    // Restore stall env knobs mutated by the watchdog test.
    delete process.env.DISCLAUDE_STALL_TIMEOUT_MS;
    delete process.env.DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS;
  });

  const makeProvider = (fx: Fixtures) =>
    new CodexAgentProvider({
      env: {
        PATH: `${fx.binDir}:${process.env.PATH ?? ''}`,
        CODEX_HOME: fx.codexHome,
      },
    });

  it('ends a turn.failed turn with error + result(terminatedReason: turn_failed)', async () => {
    // #4378 pitfall (S2 review high): turn.failed maps to an error-only
    // message; without a synthetic result the turn NEVER resolves and
    // ChatAgent stays "processing" forever.
    fixtures = makeFixtures({
      withBinary: true,
      withAuth: true,
      body: `cat <<'JSONL'
{"type":"thread.started","thread_id":"t-f"}
{"type":"turn.started"}
{"type":"turn.failed","error":{"message":"model stream ended"}}
JSONL
exit 1
`,
    });
    const { messages } = await drainStream(makeProvider(fixtures), ['hi']);
    const types = (messages as Array<{ type: string }>).map((m) => m.type);
    expect(types).toContain('error'); // the adapter's turn.failed message
    const last = (messages as Array<{ type: string; metadata?: { terminatedReason?: string } }>)
      .find((m) => m.type === 'result');
    expect(types[types.length - 1]).toBe('result'); // turn resolved
    expect(last?.metadata?.terminatedReason).toBe('turn_failed'); // recorded as FAILURE
  }, 15_000);

  it('tags synthetic results after failed runs with turn_failed (never masked success)', async () => {
    fixtures = makeFixtures({
      withBinary: true,
      withAuth: true,
      body: 'echo "boom" >&2\nexit 2',
    });
    const { messages } = await drainStream(makeProvider(fixtures), ['hi']);
    const result = (messages as Array<{ type: string; metadata?: { terminatedReason?: string } }>)
      .find((m) => m.type === 'result');
    expect(result?.metadata?.terminatedReason).toBe('turn_failed');
  }, 15_000);

  it('ends the stream when cancel() fires before the generator starts', async () => {
    // Early-cancel window (S2 review): requestAbort between queryStream()
    // and the first next() must still end the iterator (pi parity).
    fixtures = makeFixtures({ withBinary: true, withAuth: true, body: 'sleep 30 &\nwait $!' });
    const provider = makeProvider(fixtures);
    async function* input(): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'x' };
    }
    const result = provider.queryStream(input(), { settingSources: [] } as AgentQueryOptions);
    result.handle.cancel(); // BEFORE any next()
    const collected: unknown[] = [];
    for await (const m of result.iterator) {
      collected.push(m);
    }
    expect(collected).toEqual([]); // stream ends, nothing parks forever
  }, 15_000);

  it('fires the stall watchdog on a silent run and terminates with reason stall', async () => {
    // S2 review: the watchdog's control flow had zero direct coverage.
    process.env.DISCLAUDE_STALL_TIMEOUT_MS = '800';
    process.env.DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS = '400';
    fixtures = makeFixtures({
      withBinary: true,
      withAuth: true,
      // thread.started then silence forever.
      body: `cat <<'JSONL'
{"type":"thread.started","thread_id":"t-s"}
{"type":"turn.started"}
JSONL
sleep 30 &\nwait $!`,
    });
    const { messages } = await drainStream(makeProvider(fixtures), ['hi']);
    const last = (messages as Array<{ type: string; content: string; metadata?: { terminatedReason?: string } }>)
      .at(-1);
    expect(last?.type).toBe('result');
    expect(last?.metadata?.terminatedReason).toBe('stall');
    expect(last?.content).toMatch(/超时/);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// S3 review follow-ups: detection gating + anchor survival across a 401.
// ---------------------------------------------------------------------------

describe('CodexAgentProvider detection hardening (S3 review)', () => {
  let fixtures: Fixtures;
  afterEach(() => fixtures?.cleanup());
  const makeProvider = (fx: Fixtures) =>
    new CodexAgentProvider({
      env: { PATH: `${fx.binDir}:${process.env.PATH ?? ''}`, CODEX_HOME: fx.codexHome },
    });

  it('does NOT report 401 on a SUCCESSFUL turn whose stderr carries unrelated 401 noise', async () => {
    // The gate: signature detection runs only when the run actually failed.
    fixtures = makeFixtures({
      withBinary: true,
      withAuth: true,
      body: `echo "[mcp-server] HTTP error: 401 Unauthorized (ignored noise)" >&2
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-ok"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"answer delivered"}}
{"type":"turn.completed"}
JSONL
`,
    });
    const { messages } = await drainStream(makeProvider(fixtures), ['hi']);
    const errors = (messages as Array<{ type: string; content: string }>)
      .filter((m) => m.type === 'error');
    expect(errors).toEqual([]); // no spurious re-auth notice after success
    const text = (messages as Array<{ type: string; content: string }>).find((m) => m.type === 'text');
    expect(text?.content).toBe('answer delivered');
  }, 15_000);

  it('detects 401 carried by turn.failed error messages (raw-events arm)', async () => {
    // Coverage for the turn.failed collection arm of runFailureText.
    fixtures = makeFixtures({
      withBinary: true,
      withAuth: true,
      body: `cat <<'JSONL'
{"type":"thread.started","thread_id":"t-401b"}
{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: token expired"}}
JSONL
exit 1
`,
    });
    const { messages } = await drainStream(makeProvider(fixtures), ['hi']);
    // The adapter surfaces turn.failed's own text first; the provider's
    // re-auth notice follows — assert the NOTICE is present among errors.
    const errors = (messages as Array<{ type: string; content: string }>)
      .filter((m) => m.type === 'error')
      .map((m) => m.content)
      .join('\n');
    expect(errors).toMatch(/codex login/);
  }, 15_000);

  it('keeps the latched anchor across a mid-conversation 401 — relogin resumes the same thread', async () => {
    // The REAL "keeps the chat resumable" semantics (S3 review): turn 1
    // latches t-keep; turn 2 fails with 401 (anchor must SURVIVE so the
    // post-relogin resend resumes); turn 3 must carry `resume t-keep`.
    const body = `
n=$(cat "$CODEX_HOME/count" 2>/dev/null || echo 0)
n=$((n+1)); echo "$n" > "$CODEX_HOME/count"
echo "$*" > "$CODEX_HOME/argv-$n"
if [ "$n" -eq 2 ]; then
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-keep"}
{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}
JSONL
exit 1
else
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-keep"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed"}
JSONL
fi
`;
    fixtures = makeFixtures({ withBinary: true, withAuth: true, body });
    const { messages } = await drainStream(makeProvider(fixtures), ['a', 'b', 'c']);
    const argv3 = readFileSync(join(fixtures.codexHome, 'argv-3'), 'utf-8').trim();
    expect(argv3).toContain('resume');
    expect(argv3).toContain('t-keep');
    const errors = (messages as Array<{ type: string; content: string }>)
      .filter((m) => m.type === 'error')
      .map((m) => m.content)
      .join('\n');
    expect(errors).toMatch(/codex login/);
  }, 25_000);
});

// ---------------------------------------------------------------------------
// Session governance (Issue #4634, S7) — integration against real
// subprocesses: run mutual exclusion + backpressure notice, session cap
// eviction + thread-stash resume, and the /reset no-stash semantics.
// ---------------------------------------------------------------------------

describe('CodexAgentProvider governance (Issue #4634)', () => {
  let fixtures: Fixtures;

  afterEach(() => {
    fixtures?.cleanup();
  });

  const governedProvider = (
    fx: Fixtures,
    caps: { maxActiveSessions?: number; maxConcurrentRuns?: number },
  ) =>
    new CodexAgentProvider({
      env: {
        PATH: `${fx.binDir}:${process.env.PATH ?? ''}`,
        CODEX_HOME: fx.codexHome,
      },
      ...caps,
    });

  it('serializes concurrent runs across streams (maxConcurrentRuns=1) and notifies the queued one', async () => {
    // The fake codex logs S<n>/E<n> markers around a slow run — mutual
    // exclusion ⇔ the marker stream alternates (never S,S).
    const body = `
n=$(cat "$CODEX_HOME/count" 2>/dev/null || echo 0)
n=$((n+1)); echo "$n" > "$CODEX_HOME/count"
echo "$*" > "$CODEX_HOME/argv-$n"
echo "S$n" >> "$CODEX_HOME/runs.log"
sleep 0.5
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-$n"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok$n"}}
{"type":"turn.completed"}
JSONL
echo "E$n" >> "$CODEX_HOME/runs.log"
`;
    fixtures = makeFixtures({ withBinary: true, withAuth: true, body });
    const provider = governedProvider(fixtures, { maxConcurrentRuns: 1 });

    // Stream one: park after its message so the session stays alive while
    // stream two queues behind its (slow) run.
    let releaseOne: () => void = () => {};
    const oneParked = new Promise<void>((r) => {
      releaseOne = r;
    });
    async function* inputOne(): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'one' };
      await oneParked;
    }
    const resultOne = provider.queryStream(inputOne(), {
      settingSources: [],
      sessionKey: 'chat-one',
    } as AgentQueryOptions);
    const collectedOne = (async () => {
      const out: unknown[] = [];
      for await (const m of resultOne.iterator) {
        out.push(m);
      }
      return out;
    })();

    await waitFor(() => existsSync(join(fixtures.codexHome, 'runs.log')) &&
      readFileSync(join(fixtures.codexHome, 'runs.log'), 'utf-8').includes('S1'));

    const { messages: messagesTwo } = await drainStream(provider, ['two'], {
      sessionKey: 'chat-two',
    });
    releaseOne();
    await collectedOne;

    const markers = readFileSync(join(fixtures.codexHome, 'runs.log'), 'utf-8')
      .trim()
      .split('\n');
    expect(markers).toEqual(['S1', 'E1', 'S2', 'E2']); // strictly serialized
    const statuses = (messagesTwo as Array<{ type: string; content: string }>)
      .filter((m) => m.type === 'status')
      .map((m) => m.content);
    expect(statuses.join('\n')).toMatch(/排队/); // backpressure notice (#4634)
    const stats = provider.getGovernanceStats();
    expect(stats.runningRuns).toBe(0);
    expect(stats.queuedRuns).toBe(0);
  }, 25_000);

  it('evicts the idlest session at cap and the evicted chat RESUMES its thread next message', async () => {
    const body = `
n=$(cat "$CODEX_HOME/count" 2>/dev/null || echo 0)
n=$((n+1)); echo "$n" > "$CODEX_HOME/count"
echo "$*" > "$CODEX_HOME/argv-$n"
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-keep"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed"}
JSONL
echo done > "$CODEX_HOME/turn-$n.done"
`;
    fixtures = makeFixtures({ withBinary: true, withAuth: true, body });
    const provider = governedProvider(fixtures, { maxActiveSessions: 1 });

    // chat-a: one turn (latches t-keep), then parks — alive at eviction time.
    let releaseA: () => void = () => {};
    const aParked = new Promise<void>((r) => {
      releaseA = r;
    });
    async function* inputA(): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'a1' };
      await aParked;
    }
    const resultA = provider.queryStream(inputA(), {
      settingSources: [],
      sessionKey: 'chat-a',
    } as AgentQueryOptions);
    let sawFirstTurnText = false;
    const collectedA = (async () => {
      const out: unknown[] = [];
      for await (const m of resultA.iterator) {
        out.push(m);
        if ((m as { type?: string }).type === 'text') {
          sawFirstTurnText = true;
        }
      }
      return out;
    })();
    // Wait for turn COMPLETION, not argv-1: the argv file exists at process
    // start, before the run finishes — under load the old wait let chat-b
    // evict chat-a BEFORE the anchor latched (S7 review flaky).
    await waitFor(() => existsSync(join(fixtures.codexHome, 'turn-1.done')));
    // Also wait until the bridge has consumed thread.started and the text
    // event. The fixture's turn marker is written by the child and can race
    // the parent readline consumer; eviction must only happen after the
    // provider has latched the thread id.
    await waitFor(() => sawFirstTurnText);

    // chat-b registers → cap 1 → chat-a is evicted (LRU: the only session).
    await drainStream(provider, ['b1'], { sessionKey: 'chat-b' });
    const messagesA = await collectedA;
    // chat-a's FIRST turn completed normally; the eviction then ends the
    // stream with a CLEAN terminator — type result + terminatedReason
    // 'evicted' (S7 review: ChatAgent must not auto-restart the victim,
    // which cascaded evictions into the circuit breaker).
    const typesA = (messagesA as Array<{ type: string }>).map((m) => m.type);
    expect(typesA).toEqual(['text', 'result', 'result']);
    const evictedMsg = (messagesA as Array<{
      type: string;
      content: string;
      metadata?: { terminatedReason?: string };
    }>).at(-1);
    expect(evictedMsg?.metadata?.terminatedReason).toBe('evicted');
    expect(evictedMsg?.content).toMatch(/让位/);
    releaseA();

    // chat-a's NEXT stream must resume the stashed thread (eviction ≠ reset).
    await drainStream(provider, ['a2'], { sessionKey: 'chat-a' });
    const argv3 = readFileSync(join(fixtures.codexHome, 'argv-3'), 'utf-8').trim();
    expect(argv3).toContain('resume');
    expect(argv3).toContain('t-keep');
    expect(provider.getGovernanceStats().evictedSessions).toBe(1);
  }, 25_000);

  it('normal teardown does NOT stash — /reset keeps meaning reset', async () => {
    // Same scripted happy body; the stream ends normally after one turn.
    const body = `
n=$(cat "$CODEX_HOME/count" 2>/dev/null || echo 0)
n=$((n+1)); echo "$n" > "$CODEX_HOME/count"
echo "$*" > "$CODEX_HOME/argv-$n"
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-r"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed"}
JSONL
`;
    fixtures = makeFixtures({ withBinary: true, withAuth: true, body });
    const provider = governedProvider(fixtures, {});

    // First conversation completes and ends normally (input exhausted = the
    // same stream-death path a /reset takes).
    await drainStream(provider, ['r1'], { sessionKey: 'chat-r' });
    // Same chat comes back → must start FRESH (no stashed resume).
    await drainStream(provider, ['r2'], { sessionKey: 'chat-r' });
    const argv2 = readFileSync(join(fixtures.codexHome, 'argv-2'), 'utf-8').trim();
    expect(argv2).not.toContain('resume');
    expect(provider.getGovernanceStats().evictedSessions).toBe(0);
  }, 20_000);

  it('forgetSession() closes the eviction window: /reset after eviction starts fresh, not resurrected (Issue #4644)', async () => {
    const body = `
n=$(cat "$CODEX_HOME/count" 2>/dev/null || echo 0)
n=$((n+1)); echo "$n" > "$CODEX_HOME/count"
echo "$*" > "$CODEX_HOME/argv-$n"
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-old"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed"}
JSONL
echo done > "$CODEX_HOME/turn-$n.done"
`;
    fixtures = makeFixtures({ withBinary: true, withAuth: true, body });
    const provider = governedProvider(fixtures, { maxActiveSessions: 1 });

    // chat-a: one turn latches t-old, then parks — alive at eviction time.
    let releaseA: () => void = () => {};
    const aParked = new Promise<void>((r) => {
      releaseA = r;
    });
    async function* inputA(): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'a1' };
      await aParked;
    }
    const resultA = provider.queryStream(inputA(), {
      settingSources: [],
      sessionKey: 'chat-a',
    } as AgentQueryOptions);
    const collectedA = (async () => {
      const out: unknown[] = [];
      for await (const m of resultA.iterator) {
        out.push(m);
      }
      return out;
    })();
    await waitFor(() => existsSync(join(fixtures.codexHome, 'turn-1.done')));

    // chat-b registers → cap 1 → chat-a evicted → its thread anchor is
    // STASHED (the eviction-resume feature: without a reset, chat-a's next
    // message would resume t-old — see the test above).
    await drainStream(provider, ['b1'], { sessionKey: 'chat-b' });
    await collectedA;
    releaseA();

    // THE #4644 WINDOW: the user issues /reset AFTER the eviction (stream
    // already torn down with wasEvicted=true — the teardown stash-clear
    // deliberately does not fire) and BEFORE the next message. Without
    // forgetSession the stash survives and the next stream resurrects the
    // reset-away conversation.
    provider.forgetSession('chat-a');

    // chat-a's next message must start FRESH — no `resume t-old`.
    await drainStream(provider, ['a2'], { sessionKey: 'chat-a' });
    const argv3 = readFileSync(join(fixtures.codexHome, 'argv-3'), 'utf-8').trim();
    expect(argv3).not.toContain('resume');
    expect(argv3).not.toContain('t-old');
  }, 25_000);

  it('forgetSession() also drops a live governor registration — the chat cannot be evicted (re-stashed) after a reset', async () => {
    const body = `
n=$(cat "$CODEX_HOME/count" 2>/dev/null || echo 0)
n=$((n+1)); echo "$n" > "$CODEX_HOME/count"
echo "$*" > "$CODEX_HOME/argv-$n"
cat <<'JSONL'
{"type":"thread.started","thread_id":"t-live"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
{"type":"turn.completed"}
JSONL
echo done > "$CODEX_HOME/turn-$n.done"
`;
    fixtures = makeFixtures({ withBinary: true, withAuth: true, body });
    const provider = governedProvider(fixtures, { maxActiveSessions: 2 });

    // chat-a parks after its turn (still registered in the governor).
    let releaseA: () => void = () => {};
    const aParked = new Promise<void>((r) => {
      releaseA = r;
    });
    async function* inputA(): AsyncGenerator<UserInput> {
      yield { role: 'user', content: 'a1' };
      await aParked;
    }
    const resultA = provider.queryStream(inputA(), {
      settingSources: [],
      sessionKey: 'chat-a',
    } as AgentQueryOptions);
    const collectedA = (async () => {
      const out: unknown[] = [];
      for await (const m of resultA.iterator) {
        out.push(m);
      }
      return out;
    })();
    await waitFor(() => existsSync(join(fixtures.codexHome, 'turn-1.done')));

    // /reset while the stream is alive: the provider-level forget must
    // deregister chat-a so a LATER cap eviction cannot fire its hook and
    // re-stash the anchor after the reset (the exact resurrection shape the
    // #4644 fix guards against — governor clearing is required, not hygiene).
    provider.forgetSession('chat-a');
    releaseA();
    await collectedA;

    // chat-b and chat-c fill the cap (2) — chat-a must NOT be among the
    // victims: it was forgotten, so no eviction hook (no re-stash) fired.
    await drainStream(provider, ['b1'], { sessionKey: 'chat-b' });
    await drainStream(provider, ['c1'], { sessionKey: 'chat-c' });
    expect(provider.getGovernanceStats().evictedSessions).toBe(0);

    // And the reset-away conversation stays dead: chat-a's next message
    // starts fresh.
    await drainStream(provider, ['a2'], { sessionKey: 'chat-a' });
    const argv4 = readFileSync(join(fixtures.codexHome, 'argv-4'), 'utf-8').trim();
    expect(argv4).not.toContain('resume');
  }, 25_000);

  it('forgetSession() on an unknown key is a no-op (idempotent reset surface)', () => {
    fixtures = makeFixtures({ withBinary: true, withAuth: true });
    const provider = governedProvider(fixtures, {});
    expect(() => provider.forgetSession('never-registered')).not.toThrow();
    expect(provider.getGovernanceStats().activeSessions).toBe(0);
  });
});


async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor: condition not met within timeout');
}
