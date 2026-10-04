/** Tests Codex sandbox/full-access selection and invalid permission-mode rejection. */

import { describe, expect, it } from 'vitest';

import { resolveCodexSandboxPolicy } from './sandbox-policy.js';

describe('resolveCodexSandboxPolicy (Issue #4631)', () => {
  // ── base level: explicit Codex policy ─────────────────────────────────

  it('maps the normal Codex policy → workspace-write', () => {
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

  it('maps explicit full-access opt-in to danger-full-access', () => {
    const d = resolveCodexSandboxPolicy({ permissionMode: 'default' }, undefined, true);
    expect(d.sandbox).toBe('danger-full-access');
    expect(d.reasons.join(' ')).toMatch(/fullAccess=true/);
  });











  // ── decision shape ───────────────────────────────────────────────────



  it('throws on an out-of-enum permissionMode instead of widening (fail closed)', () => {
    expect(() =>
      resolveCodexSandboxPolicy({ permissionMode: 'acceptEdits' as never }),
    ).toThrow(/unknown permissionMode.*fail closed/s);
  });
});
