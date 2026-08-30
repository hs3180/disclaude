/**
 * Tests for the agent-level browser-use e2e harness (Issue #4602 part 2).
 *
 * The live run (real ChatAgent + CDP endpoint + model key) is operator-only —
 * `scripts/browser-use-agent-e2e.mts`, same tooling/live split as the Card Kit
 * bench (#4398/#4416/#4454). What CI locks here is the assertion core the
 * verdict rests on: report parsing, per-check verdicts (including the exact
 * regression each check exists to catch), and preflight gating.
 *
 * @module primary-node/testing/browser-use-e2e.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AGENT_E2E_PROMPT,
  E2E_CHECKS,
  E2E_SCREENSHOT_RELATIVE_PATH,
  evaluateE2EReport,
  parseE2EReport,
  preflight,
  type HarnessConfig,
} from './browser-use-e2e.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function makeConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    chatId: 'e2e-test',
    workspaceDir: process.cwd(), // exists by definition
    cdpUrl: 'http://127.0.0.1:9222',
    apiKey: 'sk-test',
    turnTimeoutMs: 1000,
    ...overrides,
  };
}

/** A well-formed reply that passes every check (screenshot written by caller). */
function passingReport(shotPath: string): string {
  return [
    'I ran the checklist with browser-use.',
    '```e2e-report',
    'skill_discovery=browser-use',
    'attach_no_self_spawn=true',
    'js_round_trip={"marker":42,"heading":"hello-agent-e2e"}',
    `screenshot_artifact=${shotPath}`,
    'cdp_failure_explicit=BU_CDP_URL http://127.0.0.1:1 unreachable after 30s: Connection refused',
    '```',
  ].join('\n');
}

describe('parseE2EReport', () => {
  it('parses the last e2e-report block when several are present', () => {
    const reply =
      '```e2e-report\nskill_discovery=old\n```\nfinal answer\n```e2e-report\nskill_discovery=browser-use\n```';
    expect(parseE2EReport(reply)['skill_discovery']).toBe('browser-use');
  });

  it('tolerates blank lines and skips malformed ones', () => {
    const parsed = parseE2EReport('```e2e-report\n\na=1\n\nno-equals-line\nb = spaced \n```');
    expect(parsed).toEqual({ a: '1', b: 'spaced' });
  });

  it('returns empty for a reply without the block', () => {
    expect(parseE2EReport('no report here')).toEqual({});
  });
});

describe('evaluateE2EReport — verdicts per check', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), 'bu-e2e-'));
  });
  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeShot(relative: string, bytes: Buffer = Buffer.concat([PNG_MAGIC, Buffer.alloc(8)])): string {
    const abs = path.join(workspaceDir, relative);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    return relative;
  }

  it('all 5 checks pass for a well-formed successful run', () => {
    const shot = writeShot(E2E_SCREENSHOT_RELATIVE_PATH);
    const verdict = evaluateE2EReport(passingReport(shot), workspaceDir);
    expect(verdict.failed).toEqual([]);
    expect(verdict.report).toContain('ALL PASS');
    expect(verdict.results.map((r) => r.id)).toEqual(E2E_CHECKS.map((c) => c.id));
  });

  it('skill_discovery fails when the agent used something other than browser-use', () => {
    const shot = writeShot(E2E_SCREENSHOT_RELATIVE_PATH);
    const reply = passingReport(shot).replace('skill_discovery=browser-use', 'skill_discovery=curl');
    const verdict = evaluateE2EReport(reply, workspaceDir);
    expect(verdict.failed).toContain('skill_discovery');
  });

  it('attach_no_self_spawn fails on any value not starting with true (the #4496 silent-fallback regression)', () => {
    const shot = writeShot(E2E_SCREENSHOT_RELATIVE_PATH);
    const reply = passingReport(shot).replace(
      'attach_no_self_spawn=true',
      'attach_no_self_spawn=false, launched local chromium because attach failed',
    );
    const verdict = evaluateE2EReport(reply, workspaceDir);
    expect(verdict.failed).toContain('attach_no_self_spawn');
  });

  it('js_round_trip requires the exact marker=42 / heading=hello-agent-e2e payload', () => {
    const shot = writeShot(E2E_SCREENSHOT_RELATIVE_PATH);
    for (const bad of ['ERROR', '{"marker":41,"heading":"hello-agent-e2e"}', 'not json']) {
      const reply = passingReport(shot).replace(
        'js_round_trip={"marker":42,"heading":"hello-agent-e2e"}',
        `js_round_trip=${bad}`,
      );
      expect(evaluateE2EReport(reply, workspaceDir).failed).toContain('js_round_trip');
    }
  });

  it('screenshot_artifact fails on missing file, non-PNG bytes, and path escapes', () => {
    // Missing file: report references a path that was never written.
    let verdict = evaluateE2EReport(passingReport('e2e/browser-shot.png'), workspaceDir);
    expect(verdict.failed).toContain('screenshot_artifact');

    // Wrong magic bytes (e.g. an HTML error page saved as .png).
    writeShot('e2e/not-png.png', Buffer.from('<html>oops'));
    verdict = evaluateE2EReport(
      passingReport('e2e/not-png.png'),
      workspaceDir,
    );
    expect(verdict.failed).toContain('screenshot_artifact');

    // Absolute path pointing outside the workspace must not be trusted.
    const shot = writeShot(E2E_SCREENSHOT_RELATIVE_PATH);
    verdict = evaluateE2EReport(passingReport('/etc/passwd'), workspaceDir);
    expect(verdict.failed).toContain('screenshot_artifact');
    // sanity: the good shot alone passes
    expect(evaluateE2EReport(passingReport(shot), workspaceDir).failed).toEqual([]);
  });

  it('cdp_failure_explicit fails on EMPTY (silent success on a dead endpoint — the #4496 Scope-3 regression)', () => {
    const shot = writeShot(E2E_SCREENSHOT_RELATIVE_PATH);
    const reply = passingReport(shot).replace(
      /cdp_failure_explicit=.*/,
      'cdp_failure_explicit=EMPTY',
    );
    const verdict = evaluateE2EReport(reply, workspaceDir);
    expect(verdict.failed).toContain('cdp_failure_explicit');
  });

  it('every missing key is unevaluable and reported, not silently skipped', () => {
    const verdict = evaluateE2EReport('reply with no report block at all', workspaceDir);
    expect(verdict.failed).toEqual(E2E_CHECKS.map((c) => c.id));
    for (const r of verdict.results) {
      expect(r.passed).toBeNull();
      expect(r.evidence).toContain('missing from e2e-report');
    }
  });
});

describe('AGENT_E2E_PROMPT contract', () => {
  it('does not name the skill — discovery must be unprompted (#4460 acceptance)', () => {
    expect(AGENT_E2E_PROMPT).not.toMatch(/browser-use/i);
  });

  it('pins the screenshot path and all 5 report keys', () => {
    expect(AGENT_E2E_PROMPT).toContain(E2E_SCREENSHOT_RELATIVE_PATH);
    for (const c of E2E_CHECKS) {
      expect(AGENT_E2E_PROMPT).toContain(`${c.id}=`);
    }
  });

  it('warns the agent about the mkdir prerequisite (#4600)', () => {
    expect(AGENT_E2E_PROMPT).toMatch(/create the parent directory first/i);
  });

  it('makes the agent reload the harness daemon before the dead-endpoint attach (daemon-pin trap, cdp-endpoint.md)', () => {
    // Without the reload, step 4 runs against the daemon's still-healthy
    // pinned session and check 5 passes vacuously — the exact false-positive
    // docs/cdp-endpoint.md warns about and smoke.sh case 6 reloads around.
    expect(AGENT_E2E_PROMPT).toMatch(/--reload/);
    // And the reload must be ordered BEFORE the dead-endpoint attempt.
    const reloadAt = AGENT_E2E_PROMPT.indexOf('--reload');
    const deadAt = AGENT_E2E_PROMPT.indexOf('http://127.0.0.1:1');
    expect(reloadAt).toBeGreaterThan(-1);
    expect(deadAt).toBeGreaterThan(reloadAt);
  });
});

describe('preflight', () => {
  it('passes with key, cdp url and existing workspace', () => {
    expect(preflight(makeConfig()).ok).toBe(true);
  });

  it('reports each missing input separately', () => {
    const verdict = preflight(
      makeConfig({ apiKey: '', cdpUrl: '', workspaceDir: '/nonexistent-dir-xyz' }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toHaveLength(3);
    expect(verdict.problems.some((p) => p.includes('API key'))).toBe(true);
    expect(verdict.problems.some((p) => p.includes('CDP endpoint'))).toBe(true);
    expect(verdict.problems.some((p) => p.includes('workspace'))).toBe(true);
  });
});
