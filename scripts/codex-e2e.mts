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
 * schema contract is empirically pinned to codex-cli 0.132.0 — see
 * docs/codex-backend.md §7) or before trusting the codex backend in
 * production:
 *
 *   npx tsx scripts/codex-e2e.ts
 *
 * Exit code 0 = all phases passed; 1 = at least one failed. Everything is
 * self-contained: temp workspace/config are created under the OS tmpdir and
 * cleaned up on exit; the production config and running services are never
 * touched.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '../packages/core/src/sdk/types.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const PHASE_TIMEOUT_MS = 240_000; // one codex turn can take ~1-2 min

/** Phase results collected for the final summary table. */
const results: Array<{ phase: string; pass: boolean; detail: string }> = [];

function record(phase: string, pass: boolean, detail: string): void {
  results.push({ phase, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${phase} — ${detail}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'codex-e2e-'));
  const workspaceDir = join(root, 'workspace');
  // The workspace dir must EXIST before any spawn — codex runs with
  // options.cwd = workspaceDir and a missing cwd is an ENOENT spawn error.
  mkdirSync(workspaceDir, { recursive: true });
  const configFile = join(root, 'e2e.config.yaml');
  try {
    // ── Phase 0: environment (actionable fail-fast, same contract as S1) ──
    const codexOnPath = spawnSync('codex', ['--version'], { encoding: 'utf8' });
    if (codexOnPath.status !== 0 || !/codex-cli \d/.test(codexOnPath.stdout)) {
      record('environment', false, 'codex CLI not runnable on PATH — npm install -g @openai/codex');
      return summary();
    }
    const cliVersion = (codexOnPath.stdout.match(/codex-cli [\d.]+/) ?? ['?'])[0];

    // ── Config: preload BEFORE importing Config (statics evaluate at import) ──
    writeFileSync(configFile, [
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
    ].join('\n'));
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
    record('config chain', configOk,
      `backend=${Config.AGENT_BACKEND} sandbox=${Config.CODEX_SANDBOX} caps=${Config.CODEX_MAX_ACTIVE_SESSIONS}/${Config.CODEX_MAX_CONCURRENT_RUNS}`);

    factory.setDefaultProvider('codex');
    const provider = factory.getProvider('codex') as CodexAgentProvider;

    // ── Phase 2: environment self-check (S1 fail-fast) ────────────────────
    const validateOk = provider.validateConfig();
    record('validateConfig (binary + login)', validateOk,
      validateOk ? `provider ${provider.name}@${provider.version} ready (${cliVersion})`
        : String(provider.getInfo().unavailableReason));
    if (!validateOk) return summary();

    /** Run N turns over one stream; returns texts, errors, any-activity flag. */
    const runTurns = async (
      p: CodexAgentProvider,
      prompts: string[],
      opts: { sandboxOverride?: 'read-only' } = {},
    ): Promise<{ texts: string[]; errors: string[]; sawActivity: boolean; sessionId?: string }> => {
      const queue = [...prompts];
      let release: () => void = () => {};
      const parked = new Promise<void>((r) => { release = r; });
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
      } as never);
      const texts: string[] = [];
      const errors: string[] = [];
      let sawActivity = false;
      const collect = (async () => {
        for await (const m of result.iterator as AsyncIterable<AgentMessage>) {
          sawActivity = true;
          if (m.type === 'text') texts.push(m.content);
          if (m.type === 'error') errors.push(m.content);
        }
      })();
      const deadline = Date.now() + PHASE_TIMEOUT_MS;
      while (texts.length + errors.length < prompts.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      release();
      await Promise.race([collect, new Promise((r) => setTimeout(r, 10_000))]);
      return { texts, errors, sawActivity, sessionId: result.handle.sessionId };
    };

    // ── Phase 3: multi-turn memory via exec resume (S3) ───────────────────
    const code = `MANGO-${Math.floor(Math.random() * 9000 + 1000)}`;
    const memory = await runTurns(provider, [
      `Remember this secret code word: ${code}. Reply with exactly: noted`,
      'What is my secret code word? Reply with just the code word.',
    ]);
    const memoryOk = memory.texts.length === 2 && memory.texts[1].includes(code);
    record('multi-turn resume memory (S3)', memoryOk,
      memoryOk
        ? `thread=${memory.sessionId}`
        : `texts=${JSON.stringify(memory.texts)} errors=${JSON.stringify(memory.errors)} thread=${memory.sessionId ?? '?'}`);

    // ── Phase 4: sandbox write allowed (S4, workspace-write via config) ──
    const writeFile = join(workspaceDir, 'e2e-probe.txt');
    const writeRun = await runTurns(provider, [
      'Create a file named e2e-probe.txt containing exactly: hello-e2e. Then reply: done',
    ]);
    const writeOk = writeRun.sawActivity &&
      existsSync(writeFile) && readFileSync(writeFile, 'utf8').trim() === 'hello-e2e';
    record('sandbox workspace-write (S4)', writeOk,
      writeOk ? 'file created with exact content'
        : `sawActivity=${writeRun.sawActivity} file=${existsSync(writeFile)} errors=${JSON.stringify(writeRun.errors)}`);

    // ── Phase 5: sandbox read-only blocks writes (S4 fail-closed axis) ───
    // Same resolver path as the config value (sandboxOverride IS the
    // configSandbox parameter of resolveCodexSandboxPolicy) — one Config
    // instance per process forbids a second yaml, and this exercises the
    // identical enforcement code. sawActivity guards against a VACUOUS pass
    // (no run ⇒ no file would "prove" nothing).
    const roProvider = new CodexAgentProvider({ sandboxOverride: 'read-only' });
    const roFile = join(workspaceDir, 'e2e-ro-probe.txt');
    const roRun = await runTurns(roProvider, [
      'Create a file named e2e-ro-probe.txt containing hello. You must actually create it.',
    ]);
    const roOk = roRun.sawActivity && !existsSync(roFile);
    record('sandbox read-only blocks write (S4)', roOk,
      roOk ? 'run executed; write rejected by the OS sandbox'
        : `sawActivity=${roRun.sawActivity} fileExists=${existsSync(roFile)} errors=${JSON.stringify(roRun.errors)}`);

    // ── Phase 6: telemetry (S5 quota + S7 governance from config) ────────
    const quota = provider.getQuotaStats();
    const gov = provider.getGovernanceStats();
    const quotaOk = quota.turnsCompleted >= 3; // memory×2 + write×1 (ro runs on a separate provider)
    const govOk = gov.maxConcurrentRuns === 1 && gov.maxActiveSessions === 2;
    record('quota telemetry (S5)', quotaOk, JSON.stringify(quota));
    record('governance caps from config (S7)', govOk, JSON.stringify(gov));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  summary();
}

function summary(): void {
  const failed = results.filter((r) => !r.pass);
  console.log('\n──────── codex e2e summary ────────');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.phase}`);
  }
  console.log(`${failed.length === 0 ? 'ALL GREEN ✅' : `${failed.length} FAILED ❌`}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('codex-e2e: unexpected error', error);
  process.exitCode = 2;
});
