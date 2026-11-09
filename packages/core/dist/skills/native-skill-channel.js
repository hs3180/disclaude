/**
 * Shared native-skill-channel contract for harness backends (#5717, sharing
 * the codex #5520 fail-fast shape with the Pi backend).
 *
 * A backend that cannot deliver Disclaude-managed skills through the harness's
 * OWN discovery mechanism must fail fast with an actionable diagnostic when an
 * explicitly installed skill source exists — never silently degrade, and never
 * fabricate a skills manifest into any system/developer/user prompt layer.
 * Backends with a verified native channel (claude local plugins, codex
 * app-server `skills/extraRoots/set`) register their roots there instead and
 * do not consume this gate.
 */
import { installedDiagnosticsPlugin } from './diagnostics-plugin.js';
/** The explicit, operator-facing failure for an undeliverable skill source. */
export function undeliverableSkillSourceError(channel) {
    return new Error(`${channel.harness} cannot natively load Disclaude-managed skills: ${channel.evidence}. ` +
        `${channel.remedy} No prompt manifest was injected and no model turn was submitted.`);
}
/**
 * Fail fast when the explicitly installed diagnostics plugin cannot be
 * delivered on a harness without a native skills channel. The explicit-install
 * boundary is preserved exactly: a missing, edited or redirected installation
 * never triggers the failure (it delivers nothing today either), and a clean
 * project runs unchanged.
 */
export function assertNoUndeliverableSkillSources(channel, projectRoot) {
    if (projectRoot && installedDiagnosticsPlugin(projectRoot)) {
        throw undeliverableSkillSourceError(channel);
    }
}
