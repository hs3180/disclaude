/**
 * Tests for the codex sandbox policy resolver — Issue #4631 (S4 of #4627).
 *
 * Locks the full mapping table (permissionMode / explicit override /
 * denylist cap / web-search fail-closed) as a pure-function contract,
 * including the deny paths verified live against codex-cli 0.132.0:
 * - read-only blocks file mutation (enforcement probe, see module header)
 * - web search has no working off switch → unsupported policy throws
 */

import { describe, expect, it } from 'vitest';

import { resolveCodexSandboxPolicy } from './sandbox-policy.js';

describe('resolveCodexSandboxPolicy (Issue #4631)', () => {
  // ── base level: permissionMode inference ─────────────────────────────

  it("maps permissionMode 'bypassPermissions' → workspace-write", () => {
    const d = resolveCodexSandboxPolicy({ permissionMode: 'bypassPermissions' });
    expect(d.sandbox).toBe('workspace-write');
    expect(d.configOverrides).toEqual(['sandbox_mode=workspace-write']);
  });

  it('maps absent permissionMode → workspace-write (ChatAgent bypass default)', () => {
    const d = resolveCodexSandboxPolicy({});
    expect(d.sandbox).toBe('workspace-write');
  });

  it("maps permissionMode 'default' (ask) → read-only — headless has no approver", () => {
    // Fail closed: 'ask' cannot be honored by codex exec, so degrade to the
    // most restrictive sandbox instead of silently granting autonomy.
    const d = resolveCodexSandboxPolicy({ permissionMode: 'default' });
    expect(d.sandbox).toBe('read-only');
    expect(d.reasons.join(' ')).toMatch(/fail closed/);
  });

  // ── explicit config override ─────────────────────────────────────────

  it('explicit agent.codexSandbox overrides permissionMode inference', () => {
    const d = resolveCodexSandboxPolicy(
      { permissionMode: 'default' },
      'danger-full-access',
    );
    expect(d.sandbox).toBe('danger-full-access');
    expect(d.reasons.join(' ')).toMatch(/explicit override/);
  });

  // ── denylist cap (fail closed) ───────────────────────────────────────

  it('caps at read-only when the denylist blocks mutation tools (claude names)', () => {
    for (const name of ['Bash', 'Write', 'Edit', 'NotebookEdit']) {
      const d = resolveCodexSandboxPolicy(
        { permissionMode: 'bypassPermissions', disallowedTools: [name] },
      );
      expect(d.sandbox, name).toBe('read-only');
    }
  });

  it('caps at read-only when the denylist blocks mutation tools (codex names)', () => {
    for (const name of ['shell', 'file_change', 'apply_patch', 'command_execution']) {
      const d = resolveCodexSandboxPolicy({ disallowedTools: [name] });
      expect(d.sandbox, name).toBe('read-only');
    }
  });

  it('the denylist cap outranks an explicit danger-full-access override', () => {
    // Security policy (denylist) beats preference (explicit config).
    const d = resolveCodexSandboxPolicy(
      { permissionMode: 'bypassPermissions', disallowedTools: ['Bash'] },
      'danger-full-access',
    );
    expect(d.sandbox).toBe('read-only');
    expect(d.reasons.join(' ')).toMatch(/capped at read-only/);
  });

  it('is case-insensitive on denylist names (Bash/bash/WebSearch/web_search)', () => {
    expect(resolveCodexSandboxPolicy({ disallowedTools: ['bash'] }).sandbox).toBe('read-only');
  });

  // ── not-applicable denylist entries (pi-gate parity: no match, no effect) ──

  it('ignores claude-only denylist names — codex has no such capability', () => {
    // This is ChatAgent's ACTUAL default denylist (buildDisallowedTools,
    // #4181): every entry names claude-only tools, so the codex backend
    // must run unrestricted-by-default, not fail.
    const d = resolveCodexSandboxPolicy({
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
    expect(d.sandbox).toBe('workspace-write');
  });

  // ── unenforceable policy → fail closed with a clear error ────────────

  it('throws for WebSearch denylist entries (no working off switch on 0.132.0)', () => {
    expect(() =>
      resolveCodexSandboxPolicy({ disallowedTools: ['WebSearch'] }),
    ).toThrow(/cannot disable its built-in web search.*fail closed/s);
    expect(() =>
      resolveCodexSandboxPolicy({ disallowedTools: ['web_search'] }),
    ).toThrow(/#4631/);
  });

  it('the web-search refusal wins even alongside mutation entries (checks run regardless)', () => {
    expect(() =>
      resolveCodexSandboxPolicy({ disallowedTools: ['Bash', 'WebSearch'] }),
    ).toThrow(/web search/i);
  });

  // ── decision shape ───────────────────────────────────────────────────

  it('returns the runner-ready argv fragment and ordered reasons', () => {
    const d = resolveCodexSandboxPolicy(
      { permissionMode: 'default', disallowedTools: ['Bash'] },
    );
    expect(d.configOverrides).toEqual(['sandbox_mode=read-only']);
    expect(d.reasons.length).toBe(2); // base inference + denylist cap
    expect(d.reasons[0]).toMatch(/permissionMode/);
    expect(d.reasons[1]).toMatch(/disallowedTools/);
  });
});
