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

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CodexAgentProvider } from './provider.js';
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

  it("exposes name 'codex' and the sandbox-policy version", () => {
    fixtures = makeFixtures({ withBinary: false, withAuth: false });
    const provider = makeProvider(fixtures);
    expect(provider.name).toBe('codex');
    expect(provider.version).toBe('0.3.0-sandbox-policy');
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
        'exec resume --json --skip-git-repo-check -c sandbox_mode=workspace-write t-abc -- b',
      );
      const texts = (messages as Array<{ type: string; content: string }>)
        .filter((m) => m.type === 'text')
        .map((m) => m.content);
      expect(texts).toEqual(['first turn', 'resumed turn']);
      expect(sessionId).toBe('t-abc');
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
      expect(argvOf(fixtures)).toContain('-c sandbox_mode=workspace-write');
    }, 15_000);

    it("derives read-only from permissionMode 'default' (ask) — no headless approver, fail closed", async () => {
      sandboxedFixtures();
      await drainStream(makeProvider(fixtures), ['hi'], { permissionMode: 'default' });
      expect(argvOf(fixtures)).toContain('-c sandbox_mode=read-only');
    }, 15_000);

    it('caps at read-only when the denylist blocks mutation tools', async () => {
      sandboxedFixtures();
      await drainStream(makeProvider(fixtures), ['hi'], {
        permissionMode: 'bypassPermissions',
        disallowedTools: ['Bash'],
      });
      expect(argvOf(fixtures)).toContain('-c sandbox_mode=read-only');
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
      expect(argvOf(fixtures)).toContain('-c sandbox_mode=workspace-write');
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
      expect(argvOf(fixtures)).toContain('-c sandbox_mode=danger-full-access');
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
      expect(argvOf(fixtures)).toContain('-c sandbox_mode=read-only');
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
