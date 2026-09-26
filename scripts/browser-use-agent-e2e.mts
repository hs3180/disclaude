#!/usr/bin/env node
/** Agent-level browser validation using the configured coordinated IPC entry point.
 * Set DISCLAUDE_BROWSER_SOCKET; the IPC adapter is resolved relative to it,
 * then run: npx tsx scripts/browser-use-agent-e2e.mts --workspace <dir>
 * A model API key is required. No Chromium endpoint is forwarded to the agent.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Config, setDefaultProvider } from '../packages/core/src/index.js';
import { AgentFactory } from '../packages/service/src/agents/factory.js';
import {
  AGENT_E2E_PROMPT,
  E2E_SCREENSHOT_RELATIVE_PATH,
  evaluateE2EReport,
  preflight,
  type HarnessConfig,
} from '../packages/service/src/testing/browser-use-e2e.js';

interface Argv {
  workspaceDir?: string;
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
  npx tsx scripts/browser-use-agent-e2e.mts --workspace <dir>

Options:
  --workspace <dir>    workspace dir (agent cwd + artifact root).
                       Default: DISCLAUDE_WORKSPACE_DIR env or ./workspace
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
  const apiKey = argv.apiKey ?? Config.getAgentConfig().apiKey;

  const config: HarnessConfig = {
    chatId: 'e2e-browser-use-agent',
    workspaceDir,
    browserSocket: process.env.DISCLAUDE_BROWSER_SOCKET,
    apiKey,
    agentBackend: Config.AGENT_BACKEND,
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

  // Agent transport settings come from the coordinated environment.
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

  // Match production bootstrap before constructing a ChatAgent.
  const agentBackend = Config.AGENT_BACKEND;
  if (!agentBackend) throw new Error('No agent backend configured');
  setDefaultProvider(agentBackend);
  const agent = AgentFactory.createAgent(config.chatId, callbacks, {
    agentBackend,
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
  // Resolved by the timeout callback — racing turnComplete against this
  // guarantees the runner reaches its teardown even when the turn promise
  // never settles (see the comment at the await below).
  let fireTimeoutGuard: (() => void) | undefined;
  const timeoutGuard = new Promise<void>((resolve) => {
    fireTimeoutGuard = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      agent.stop();
    } catch (stopError) {
      console.error(`agent.stop() threw: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
    }
    fireTimeoutGuard?.();
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
    //
    // Race it against the timeout: stop() only closes the channel/query and
    // aborts the controller — the turn promise is settled from inside the
    // iterator paths (resolveTurn/rejectTurn) or dispose(), so if the
    // iterator is stuck on I/O that ignores the abort, a bare await would
    // hang forever and the finally below (incl. dispose) would never run.
    // Both race participants keep their rejection handled (Promise.race
    // attaches handlers to all of them), so a late rejectTurn after a lost
    // race cannot become an unhandled rejection.
    await Promise.race([agent.turnComplete ?? Promise.resolve(), timeoutGuard]);
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
