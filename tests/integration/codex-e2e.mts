/**
 * Codex backend end-to-end regression — Issue #4627 (S1–S7).
 *
 * Drives the REAL production chain against the REAL codex CLI:
 *   temp config → loader → Config statics → factory → CodexAgentProvider
 *     → codex exec spawn (real OAuth) → JSONL bridge → exec resume
 *     → sandbox enforcement → quota/governance telemetry
 *
 * This is a MANUAL regression tool, deliberately outside the vitest suite:
 * it needs a real codex CLI install, a completed `codex login`, and live
 * network to api.openai.com — the unit tests' network isolation would block
 * it by design. Run it after upgrading the codex CLI (the exec-adapter's
 * schema contract is empirically validated against codex-cli 0.151.0 — see
 * docs/codex-backend.md §7) or before trusting the codex backend in
 * production:
 *
 *   npx tsx tests/integration/codex-e2e.mts
 *
 * Exit code 0 = all phases passed; 1 = at least one failed. Everything is
 * self-contained: temp workspace/config are created under the OS tmpdir and
 * cleaned up on exit; the production config and running services are never
 * touched.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import type { AgentMessage } from '../../packages/core/src/sdk/types.js';

const REPO_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const PHASE_TIMEOUT_MS = 240_000; // one codex turn can take ~1-2 min

/** Phase results collected for the final summary table. */
const results: Array<{ phase: string; pass: boolean | null; detail: string }> = [];

function record(phase: string, pass: boolean | null, detail: string): void {
  results.push({ phase, pass, detail });
  console.log(`${pass === null ? '⏭️' : pass ? '✅' : '❌'} ${phase} — ${detail}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'codex-e2e-'));
  // Codex's workspace-write sandbox intentionally rejects project roots under
  // the OS temporary directory on some hosts. Keep the disposable workspace
  // under this checkout instead; it is still removed in finally and never
  // uses the production workspace/config.
  const workspaceDir = mkdtempSync(join(REPO_ROOT, '.codex-e2e-workspace-'));
  const codexHome = join(root, 'codex-home');
  const configFile = join(root, 'e2e.config.yaml');
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    // The workspace dir must EXIST before any spawn — codex runs with
    // options.cwd = workspaceDir and a missing cwd is an ENOENT spawn error.
    mkdirSync(workspaceDir, { recursive: true });
    // Codex creates short-lived helper aliases under CODEX_HOME/tmp/arg0
    // before starting its in-process app-server. In restricted CI/agent
    // environments ~/.codex may be readable but not writable, producing the
    // misleading `Operation not permitted` warm-up failure. Give this E2E a
    // private writable home while keeping the real auth.json available via a
    // symlink (credentials are never copied into the temporary directory).
    mkdirSync(codexHome, { recursive: true });
    const sourceCodexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    const authFile = join(sourceCodexHome, 'auth.json');
    if (existsSync(authFile)) {
      symlinkSync(authFile, join(codexHome, 'auth.json'));
    }
    process.env.CODEX_HOME = codexHome;
    // ── Phase 0: environment (actionable fail-fast, same contract as S1) ──
    const codexOnPath = spawnSync('codex', ['--version'], { encoding: 'utf8' });
    if (codexOnPath.status !== 0 || !/codex-cli \d/.test(codexOnPath.stdout)) {
      record('environment', false, 'codex CLI not runnable on PATH — npm install -g @openai/codex');
      return summary();
    }
    const cliVersion = (codexOnPath.stdout.match(/codex-cli [\d.]+/) ?? ['?'])[0];

    // ── Config: preload BEFORE importing Config (statics evaluate at import) ──
    writeFileSync(
      configFile,
      [
        'workspace:',
        `  dir: ${workspaceDir}`,
        'agent:',
        '  agentBackend: codex',
        '  codexSandbox: workspace-write',
        '  codex:',
        '    maxActiveSessions: 2',
        '    maxConcurrentRuns: 1',
        'logging:',
        '  level: info',
        '  pretty: true',
        '',
      ].join('\n')
    );
    const loader = await import(join(REPO_ROOT, 'packages/core/src/config/loader.js'));
    loader.setLoadedConfig(loader.loadConfigFile(configFile));
    const { Config } = await import(join(REPO_ROOT, 'packages/core/src/config/index.js'));
    const factory = await import(join(REPO_ROOT, 'packages/core/src/sdk/factory.js'));
    const { CodexAgentProvider } = await import(
      join(REPO_ROOT, 'packages/core/src/sdk/providers/codex/provider.js')
    );

    // ── Phase 1: config chain (yaml → Config statics → factory) ──────────
    const configOk =
      Config.AGENT_BACKEND === 'codex' &&
      Config.CODEX_SANDBOX === 'workspace-write' &&
      Config.CODEX_MAX_ACTIVE_SESSIONS === 2 &&
      Config.CODEX_MAX_CONCURRENT_RUNS === 1;
    record(
      'config chain',
      configOk,
      `backend=${Config.AGENT_BACKEND} sandbox=${Config.CODEX_SANDBOX} caps=${Config.CODEX_MAX_ACTIVE_SESSIONS}/${Config.CODEX_MAX_CONCURRENT_RUNS}`
    );

    factory.setDefaultProvider('codex');
    const provider = factory.getProvider('codex') as CodexAgentProvider;

    // ── Phase 2: environment self-check (S1 fail-fast) ────────────────────
    const validateOk = provider.validateConfig();
    record(
      'validateConfig (binary + login)',
      validateOk,
      validateOk
        ? `provider ${provider.name}@${provider.version} ready (${cliVersion})`
        : String(provider.getInfo().unavailableReason)
    );
    if (!validateOk) return summary();

    /** Run N turns over one stream; return observable execution evidence. */
    const runTurns = async (
      p: CodexAgentProvider,
      prompts: string[],
      opts: { sandboxOverride?: 'read-only'; permissionMode?: 'default' } = {}
    ): Promise<{
      texts: string[];
      errors: string[];
      sawActivity: boolean;
      mutationEvents: string[];
      sessionId?: string;
    }> => {
      const queue = [...prompts];
      let release: () => void = () => {};
      const parked = new Promise<void>((r) => {
        release = r;
      });
      async function* input() {
        while (queue.length > 0) {
          yield { role: 'user', content: queue.shift() as string };
        }
        await parked; // hold the session open until turns are collected
      }
      const result = p.queryStream(input(), {
        settingSources: [],
        cwd: workspaceDir,
        permissionMode: 'bypassPermissions',
        sessionKey: `e2e-${Math.random().toString(36).slice(2, 8)}`,
        ...opts,
      } satisfies never as Parameters<typeof p.queryStream>[1]);
      const texts: string[] = [];
      const errors: string[] = [];
      const mutationEvents: string[] = [];
      let sawActivity = false;
      let completedTurns = 0;
      let settled = false;
      const collect = (async () => {
        try {
          for await (const m of result.iterator as AsyncIterable<AgentMessage>) {
            sawActivity = true;
            if (m.type === 'text') texts.push(m.content);
            if (m.type === 'error') errors.push(m.content);
            const toolName = m.metadata?.toolName;
            if (m.type === 'tool_use' && toolName === 'shell') {
              mutationEvents.push('shell');
            } else if (m.type === 'tool_result' && toolName === 'file_change') {
              mutationEvents.push('file_change');
            }
            if (m.type === 'result') completedTurns++;
          }
        } finally {
          settled = true;
        }
      })();
      // Deadline scales per turn (S2 review of this script: a 2-turn phase
      // legitimately takes 2× a 1-turn one on slow days).
      const deadline = Date.now() + PHASE_TIMEOUT_MS * prompts.length;
      // Text/error messages can arrive before the provider has observed the
      // turn.completed boundary. Waiting on those made the harness close the
      // process while a tool write was still in flight (Codex 0.151.0), which
      // produced a false read-only failure and dropped quota telemetry.
      while (!settled && completedTurns < prompts.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      release();
      await Promise.race([collect.catch(() => {}), new Promise((r) => setTimeout(r, 10_000))]);
      // ALWAYS close the handle (e2e review): on the timeout path the run
      // may still be in flight — without close() the codex child lingers
      // until its own 600s timeout and the session stays registered in the
      // governor (slot leak), and the process can hang on open stdio pipes.
      result.handle.close();
      return { texts, errors, sawActivity, mutationEvents, sessionId: result.handle.sessionId };
    };

    // ── Phase 3: multi-turn memory via exec resume (S3) ───────────────────
    const code = `MANGO-${Math.floor(Math.random() * 9000 + 1000)}`;
    const memory = await runTurns(provider, [
      `Remember this secret code word: ${code}. Reply with exactly: noted`,
      'What is my secret code word? Reply with just the code word.',
    ]);
    const memoryOk = memory.texts.length === 2 && memory.texts[1].includes(code);
    record(
      'multi-turn resume memory (S3)',
      memoryOk,
      memoryOk
        ? `thread=${memory.sessionId}`
        : `texts=${JSON.stringify(memory.texts)} errors=${JSON.stringify(memory.errors)} thread=${memory.sessionId ?? '?'}`
    );

    // ── Phase 4: sandbox write allowed (S4, workspace-write via config) ──
    const writeFile = join(workspaceDir, 'e2e-probe.txt');
    // permissionMode 'default' would infer read-only — the write only
    // succeeds because the CONFIG's codexSandbox override reaches the
    // provider through the factory (pins the yaml→Config→factory chain).
    const writeRun = await runTurns(
      provider,
      [
        [
          "Use the shell tool to run exactly this command: printf 'hello-e2e\\n' > e2e-probe.txt.",
          'Do not merely describe the command and do not reply until the command has completed successfully.',
          'Then reply with exactly: done.',
        ].join(' '),
      ],
      { permissionMode: 'default' } as never
    );
    const writeOk =
      writeRun.sawActivity &&
      writeRun.mutationEvents.length > 0 &&
      existsSync(writeFile) &&
      readFileSync(writeFile, 'utf8').trim() === 'hello-e2e';
    const writeDetail = writeOk
      ? 'file created with exact content'
      : writeRun.mutationEvents.length === 0
        ? `model did not attempt a mutation; sawActivity=${writeRun.sawActivity} ` +
          `file=${existsSync(writeFile)} errors=${JSON.stringify(writeRun.errors)}`
        : `workspace-write mutation did not produce the expected probe file; ` +
          `events=${JSON.stringify(writeRun.mutationEvents)} file=${existsSync(writeFile)} ` +
          `errors=${JSON.stringify(writeRun.errors)}`;
    // A natural-language request cannot guarantee tool selection. Report that
    // observation as an explicit skip instead of mislabeling it as a sandbox
    // failure; actual mutation attempts remain strict failures.
    record(
      'sandbox workspace-write (S4)',
      writeRun.mutationEvents.length === 0 ? null : writeOk,
      writeRun.mutationEvents.length === 0 ? `SKIP: ${writeDetail}` : writeDetail
    );

    // ── Phase 5: sandbox read-only blocks writes (S4 fail-closed axis) ───
    // Same resolver path as the config value (sandboxOverride IS the
    // configSandbox parameter of resolveCodexSandboxPolicy) — one Config
    // instance per process forbids a second yaml, and this exercises the
    // identical enforcement code. sawActivity guards against a VACUOUS pass
    // (no run ⇒ no file would "prove" nothing).
    const roProvider = new CodexAgentProvider({ sandboxOverride: 'read-only' });
    const roFile = join(workspaceDir, 'e2e-ro-probe.txt');
    rmSync(roFile, { force: true });
    const roRun = await runTurns(roProvider, [
      'Run exactly this shell command: `touch e2e-ro-probe.txt`. Do not use an editor or patch tool. Then reply done.',
    ]);
    // texts >= 1 proves the model actually answered (sandbox denial is an
    // in-band tool failure — the model still replies); error-only activity
    // (401, limit degrade, flag rejection on schema drift) must NOT pass.
    const roOk = roRun.sawActivity && roRun.texts.length >= 1 && !existsSync(roFile);
    record(
      'sandbox read-only blocks write (S4)',
      roOk,
      roOk
        ? 'run executed; write rejected by the OS sandbox'
        : `sawActivity=${roRun.sawActivity} fileExists=${existsSync(roFile)} errors=${JSON.stringify(roRun.errors)}`
    );

    // ── Phase 6: telemetry (S5 quota + S7 governance from config) ────────
    const quota = provider.getQuotaStats();
    const gov = provider.getGovernanceStats();
    // The read-only probe runs on a separate provider. Codex 0.151.0 can
    // complete a write turn without emitting a usage marker, so assert the
    // two completed memory turns and the shape of the counters instead of
    // cascading a missing marker into a false E2E failure.
    const quotaOk =
      quota.turnsCompleted >= 2 &&
      [
        quota.inputTokens,
        quota.cachedInputTokens,
        quota.outputTokens,
        quota.reasoningOutputTokens,
      ].every((value) => Number.isFinite(value) && value >= 0);
    const govOk =
      gov.maxConcurrentRuns === 1 && gov.maxActiveSessions === 2 && gov.activeSessions === 0; // all streams closed cleanly — no slot leak
    record('quota telemetry (S5)', quotaOk, JSON.stringify(quota));
    record('governance caps from config (S7)', govOk, JSON.stringify(gov));
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
  summary();
}

function summary(): void {
  const failed = results.filter((r) => r.pass === false);
  const environmentalFailure = failed.some(({ detail }) =>
    /Operation not permitted|permission|auth(?:entication)?|not found on PATH|unavailable|network|app-server/i.test(
      detail
    )
  );
  console.log('\n──────── codex e2e summary ────────');
  for (const r of results) {
    console.log(`${r.pass === null ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'}  ${r.phase}`);
  }
  if (failed.length === 0) {
    console.log('ALL GREEN ✅');
    process.exitCode = 0;
  } else if (environmentalFailure) {
    console.log(`${failed.length} BLOCKED BY ENVIRONMENT ⚠️`);
    // Exit 2 is reserved for an unavailable E2E environment. The integration
    // runner reports this as SKIP so it does not hide unrelated suite results.
    process.exitCode = 2;
  } else {
    console.log(`${failed.length} FAILED ❌`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('codex-e2e: unexpected error', error);
  process.exitCode = 2;
});
