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

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
): Promise<{ messages: unknown[]; sessionId?: string }> {
  const queue = [...prompts];
  async function* input(): AsyncGenerator<UserInput> {
    while (queue.length > 0) {
      yield { role: 'user', content: queue.shift() as string };
    }
  }
  const result = provider.queryStream(input(), {
    settingSources: [],
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

  it("exposes name 'codex' and the exec-bridge version", () => {
    fixtures = makeFixtures({ withBinary: false, withAuth: false });
    const provider = makeProvider(fixtures);
    expect(provider.name).toBe('codex');
    expect(provider.version).toBe('0.1.0-exec-bridge');
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
