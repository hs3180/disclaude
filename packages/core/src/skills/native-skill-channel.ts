/**
 * Shared native-skill-channel contract for harness backends (#5717, sharing
 * the codex #5520 fail-fast shape with the Pi backend).
 *
 * A backend that cannot deliver Disclaude-managed skills through the harness's
 * OWN discovery mechanism must fail fast with an actionable diagnostic when an
 * explicitly installed skill source exists — never silently degrade, and never
 * fabricate a skills manifest into any system/developer/user prompt layer.
 * Backends with a verified native channel register their roots there instead
 * and do not consume this gate: claude local plugins, codex app-server
 * `skills/extraRoots/set`, and DSH's `ctx.skills` provider registration
 * (sdk profile, dsh CLI 0.1.2-rc.1 — the standalone sdk-minimal profile and
 * skill-less custom profiles have no channel and fail through this contract).
 */
import { installedDiagnosticsPlugin } from './diagnostics-plugin.js';

/** Per-harness description of a verified absent native skills channel. */
export interface NativeSkillChannel {
  /** Stable harness identifier used in operator-facing diagnostics. */
  readonly harness: string;
  /**
   * The absence proof: what was probed, where, and as of which version. Must
   * cite evidence actually verified against the vendored/installed runtime —
   * never a presumed API.
   */
  readonly evidence: string;
  /** Actionable remedy shown to the operator. */
  readonly remedy: string;
}

/** The explicit, operator-facing failure for an undeliverable skill source. */
export function undeliverableSkillSourceError(channel: NativeSkillChannel): Error {
  return new Error(
    `${channel.harness} cannot natively load Disclaude-managed skills: ${channel.evidence}. ` +
      `${channel.remedy} No prompt manifest was injected and no model turn was submitted.`
  );
}

/**
 * Fail fast when the explicitly installed diagnostics plugin cannot be
 * delivered on a harness without a native skills channel. The explicit-install
 * boundary is preserved exactly: a missing, edited or redirected installation
 * never triggers the failure (it delivers nothing today either), and a clean
 * project runs unchanged.
 */
export function assertNoUndeliverableSkillSources(
  channel: NativeSkillChannel,
  projectRoot: string | undefined
): void {
  if (projectRoot && installedDiagnosticsPlugin(projectRoot)) {
    throw undeliverableSkillSourceError(channel);
  }
}
