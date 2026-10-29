import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { CodexAppServerLifecycle } from './app-server-lifecycle.js';
import { codexNativeSkillRoots } from './skill-sources.js';

/** Real-CLI proof for native skill-directory registration (#5546 review):
 * the app-server must accept `skills/extraRoots/set` after `initialize` and
 * before `thread/start`. Verified acceptance across 0.140.0–0.164.0 (older
 * CLIs fail earlier, e.g. 0.130 rejects the `--stdio` argument itself). Each
 * test runs only against the binary named by its environment variable and
 * submits no model call or turn. */
const skillsBin = process.env.DISCLAUDE_CODEX_E2E_SKILLS_BIN;
const legacyBin = process.env.DISCLAUDE_CODEX_E2E_LEGACY_SKILLS_BIN;
const e2eDirs: string[] = [];

function probeFixture(binary: string): { workspace: string; home: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'codex-skills-e2e-'));
  const home = mkdtempSync(join(tmpdir(), 'codex-skills-e2e-home-'));
  e2eDirs.push(workspace, home);
  mkdirSync(join(workspace, 'skills', 'e2e-native-probe'), { recursive: true });
  writeFileSync(join(workspace, 'skills', 'e2e-native-probe', 'SKILL.md'),
    '---\nname: e2e-native-probe\ndescription: Real CLI registration probe.\n---\nRead references/marker.txt.\n');
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`[skills-e2e] binary=${binary} version=${version} workspace=${workspace}`);
  return { workspace, home };
}

function lifecycleFor(binary: string, workspace: string, home: string): CodexAppServerLifecycle {
  // builtinRoot = workspace keeps the probe hermetic; dedup yields exactly the probe root.
  const extraSkillRoots = codexNativeSkillRoots(workspace, workspace);
  if (extraSkillRoots.length !== 1 || extraSkillRoots[0] !== join(workspace, 'skills')) {
    throw new Error(`probe roots not computed from the real workspace: ${JSON.stringify(extraSkillRoots)}`);
  }
  return new CodexAppServerLifecycle({
    binary, extraSkillRoots, requestTimeoutMs: 20_000, sessionKey: 'skills-e2e',
    env: { ...process.env, CODEX_HOME: home },
  });
}

it.skipIf(!skillsBin)('real CLI accepts skills/extraRoots/set and then starts a thread', async () => {
  const { workspace, home } = probeFixture(skillsBin!);
  const lifecycle = lifecycleFor(skillsBin!, workspace, home);
  try {
    // Reaching a thread id proves, against the real app-server and in order:
    // initialize with the experimental capability, skills/extraRoots/set, thread/start.
    const threadId = await lifecycle.ensureThread('skills-e2e', { cwd: workspace });
    if (!threadId) { throw new Error('real CLI returned no thread id'); }
    console.log(`[skills-e2e] native registration accepted; thread ${threadId} started with no model turn`);
  } finally { await lifecycle.close(); }
}, 90_000);

it.skipIf(!legacyBin)('real CLI without skills/extraRoots/set fails with -32601 before any thread', async () => {
  const { workspace, home } = probeFixture(legacyBin!);
  const lifecycle = lifecycleFor(legacyBin!, workspace, home);
  try {
    await lifecycle.ensureThread('skills-e2e', { cwd: workspace });
    throw new Error('legacy CLI unexpectedly accepted native skill registration');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/does not support native skill directory loading/.test(message) || !/Update Codex CLI/.test(message)) {
      throw new Error(`unexpected failure without the upgrade diagnostic: ${message}`);
    }
    console.log('[skills-e2e] legacy CLI refused registration with the documented diagnostic and no thread started');
  } finally { await lifecycle.close(); }
}, 90_000);

process.on('exit', () => { for (const dir of e2eDirs.splice(0)) { rmSync(dir, { recursive: true, force: true }); } });
