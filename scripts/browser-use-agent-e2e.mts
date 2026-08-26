#!/usr/bin/env node
/**
 * Agent-level browser-use e2e runner — CLI entry (Issue #4602 part 2, option b).
 *
 * Instantiates a real one-shot ChatAgent (the same AgentFactory.createAgent
 * entry the scheduler uses), feeds it the #4602 checklist prompt, and prints
 * the pass/fail table for the 5 assertion points (skill discovery / attach
 * without self-spawn / js() round-trip / screenshot artifact / CDP failure
 * path). Assertion + orchestration logic lives in
 * `packages/primary-node/src/testing/browser-use-e2e.ts` (unit-tested there);
 * this file is the thin operator shell.
 *
 * Run with (from the repo root, one repeatable command — the #4602 acceptance):
 *   npx tsx scripts/browser-use-agent-e2e.mts \
 *     --workspace <dir> --cdp-url http://127.0.0.1:9222
 *
 * Preconditions (cannot be met from CI — operator shell only, same split as
 * the Card Kit bench #4398/#4416):
 *   - ANTHROPIC_API_KEY (or --api-key / provider config in disclaude.config.yaml)
 *   - a reachable CDP Chromium endpoint (docker compose --profile playwright up)
 *   - `browser-use` CLI on PATH for the agent subprocess (see
 *     skills/browser-use/SKILL.md "Environment")
 *
 * BU_CDP_URL is exported for this process; base-agent's buildSdkEnv forwards
 * the full process.env to the SDK subprocess, so the agent (and the
 * browser-use CLI it spawns) inherits the attach target.
 *
 * @module scripts/browser-use-agent-e2e
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AgentFactory } from '../packages/primary-node/src/agents/factory.js';
import {
  AGENT_E2E_PROMPT,
  E2E_SCREENSHOT_RELATIVE_PATH,
  evaluateE2EReport,
  preflight,
  type HarnessConfig,
} from '../packages/primary-node/src/testing/browser-use-e2e.js';

interface Argv {
  workspaceDir?: string;
  cdpUrl?: string;
  apiKey?: string;
  model?: string;
  provider?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

function usage(): void {
  console.log(`
browser-use agent-level e2e (Issue #4602 part 2) — one-shot ChatAgent + 5-check verdict

Usage:
  npx tsx scripts/browser-use-agent-e2e.mts --workspace <dir> --cdp-url <url>

Options:
  --workspace <dir>    workspace dir (agent cwd + artifact root).
                       Default: DISCLAUDE_WORKSPACE_DIR env or ./workspace
  --cdp-url <url>      CDP endpoint for BU_CDP_URL (default: env BU_CDP_URL)
  --api-key <key>      model API key (default: env ANTHROPIC_API_KEY)
  --model <name>       model override (default: disclaude config)
  --provider <name>    provider override (default: disclaude config)
  --api-base-url <url> API base URL override
  --timeout-ms <n>     per-turn timeout (default 600000)

The agent must end its reply with a \`\`\`e2e-report block; the harness prints
PASS/FAIL per check and exits non-zero when any check fails.
`);
}

function parseArgs(): Argv {
  const argv: Argv = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string => args[++i] ?? '';
    switch (a) {
      case '--workspace': argv.workspaceDir = next(); break;
      case '--cdp-url': argv.cdpUrl = next(); break;
      case '--api-key': argv.apiKey = next(); break;
      case '--model': argv.model = next(); break;
      case '--provider': argv.provider = next(); break;
      case '--api-base-url': argv.apiBaseUrl = next(); break;
      case '--timeout-ms': argv.timeoutMs = Number(next()); break;
      case '--help': case '-h': usage(); process.exit(0);
      default:
        console.error(`Unknown argument: ${a}`);
        usage();
        process.exit(1);
    }
  }
  return argv;
}

async function main(): Promise<void> {
  const argv = parseArgs();

  const workspaceDir = path.resolve(
    argv.workspaceDir ?? process.env.DISCLAUDE_WORKSPACE_DIR ?? './workspace',
  );
  const cdpUrl = argv.cdpUrl ?? process.env.BU_CDP_URL ?? '';
  const apiKey = argv.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';

  const config: HarnessConfig = {
    chatId: 'e2e-browser-use-agent',
    workspaceDir,
    cdpUrl,
    apiKey,
    model: argv.model,
    provider: argv.provider,
    apiBaseUrl: argv.apiBaseUrl,
    turnTimeoutMs: argv.timeoutMs ?? 600_000,
  };

  const pf = preflight(config);
  if (!pf.ok) {
    console.error('Preflight failed:');
    for (const p of pf.problems) console.error(`  - ${p}`);
    process.exit(2);
  }

  // Export the attach target for the agent subprocess (see file header —
  // buildSdkEnv forwards process.env). A dead BU_CDP_URL from the environment
  // must not silently win over the explicit flag.
  process.env.BU_CDP_URL = cdpUrl;
  // Keep the agent away from the self-launch path even if it ignores the
  // prompt: headless hosts are exactly where self-launch is fragile (#4496).
  process.env.DISCLAUDE_WORKSPACE_DIR = workspaceDir;

  // Artifact parent dir: pre-created here so a screenshot check failure means
  // the agent failed, not the harness (SKILL.md warns capture_screenshot
  // hangs on a missing parent — #4600; we remove the safety net ON PURPOSE to
  // keep the artifact check honest, but the dir itself must exist for the run
  // to be about the agent's behavior).
  mkdirSync(path.join(workspaceDir, path.dirname(E2E_SCREENSHOT_RELATIVE_PATH)), {
    recursive: true,
  });

  // Capture the agent's reply via the channel callbacks — the same seam a
  // Feishu chat would see, so the assertion target is the user-visible text.
  const replies: string[] = [];
  const callbacks = {
    sendMessage: async (_chatId: string, text: string) => {
      replies.push(text);
      process.stderr.write(`[agent->chat] ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}\n`);
    },
    sendCard: async () => {},
    sendFile: async () => {},
  };

  const agent = AgentFactory.createAgent(config.chatId, callbacks, {
    apiKey: config.apiKey,
    model: config.model,
    provider: config.provider,
    apiBaseUrl: config.apiBaseUrl,
    // Unbound cwd: run in the workspace dir itself (this harness IS the
    // workspace owner; a cwdProvider binding would just resolve here).
    cwdProvider: () => workspaceDir,
    cwdResolver: () => ({
      effectiveCwd: workspaceDir,
      boundWorkingDir: undefined,
      reason: 'unbound' as const,
    }),
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.stop();
  }, config.turnTimeoutMs);

  let exitCode = 0;
  try {
    await agent.processMessage({
      chatId: config.chatId,
      payload: AGENT_E2E_PROMPT,
      messageId: `e2e-${Date.now()}`,
      chatType: 'p2p',
    });
    // turnComplete is undefined until the first turn starts; processMessage
    // awaiting means the turn promise exists (set in the turn prologue).
    await (agent.turnComplete ?? Promise.resolve());
  } catch (error) {
    console.error(`Agent run failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  } finally {
    clearTimeout(timer);
    agent.dispose();
  }

  if (timedOut) {
    console.error(`Timed out after ${config.turnTimeoutMs}ms.`);
    process.exit(3);
  }
  if (exitCode !== 0) process.exit(exitCode);

  const verdict = evaluateE2EReport(replies.join('\n\n'), workspaceDir);
  console.log(verdict.report);
  process.exit(verdict.failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Unhandled error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
