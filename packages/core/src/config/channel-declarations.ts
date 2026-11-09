/**
 * Named channel declarations (#5254 rework, review 2026-11-06).
 *
 * Users declare channels by name with an explicit type marker instead of
 * nesting multiple apps under one platform section:
 *
 * ```yaml
 * channels:
 *   personal:
 *     type: feishu
 *     appId: cli_personal
 *     appSecret: $FEISHU_PERSONAL_APP_SECRET
 *     agent: assistant     # optional default agents preset for this channel
 *   work:
 *     type: feishu
 *     appId: cli_work
 *     appSecret: ${FEISHU_WORK_APP_SECRET}
 * ```
 *
 * Legacy type sections (`channels.feishu`, `channels.rest`, …) keep their
 * meaning exactly when they carry no `type` field; a singleton
 * `channels.feishu.appId/appSecret` configuration is untouched by this layer.
 *
 * Dynamic-registration seam (reserved, not implemented): declarations are
 * resolved into plain `ChannelDeclaration` records before any channel
 * instance exists. Channel instances are created from `(type, config)` pairs
 * via the channel registries (`channels/channel-registry.ts` for descriptors,
 * `ChannelLifecycleManager.createAndWireByType()` for wired instances), never
 * from raw config. A future dynamic source can therefore produce
 * `ChannelDeclaration` records at runtime, validate them with
 * `channelDeclarationErrors()` plus the per-type credential checks, resolve
 * credentials per type, and feed the same instance-creation path — without
 * reparsing config or widening the YAML shape.
 *
 * @module config/channel-declarations
 */

import type { DisclaudeConfig } from './types.js';

/**
 * Built-in legacy type sections. A declaration may not reuse these names:
 * `channels.feishu: { type: feishu }` would be ambiguous with the legacy
 * singleton section (shared settings like `streamingCard`, `enabled`).
 */
export const CHANNEL_TYPE_SECTION_KEYS = ['rest', 'feishu', 'ruliu', 'wechat'] as const;

/** Declaration names become part of routed chat IDs (`feishu:<name>:<chat>`). */
const CHANNEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * One declared channel, decoupled from both its YAML origin and its instance.
 * `config` carries the type-specific fields (credentials, `agent`, …) with
 * the `type` marker stripped.
 */
export interface ChannelDeclaration {
  /** Stable channel name — the `channels` map key. */
  readonly name: string;
  /** Channel type marker, e.g. `feishu`. */
  readonly type: string;
  /** Type-specific fields, without `type`. */
  readonly config: Record<string, unknown>;
}

/** True when a `channels.<name>` entry is a named declaration (`type` marker present). */
export function isChannelDeclaration(
  entry: unknown
): entry is Record<string, unknown> & { type: string } {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }
  const { type } = entry as Record<string, unknown>;
  return typeof type === 'string' && type.trim() !== '';
}

/**
 * Split a config's `channels` map into named declarations, in declaration
 * order. Legacy type sections (no `type` marker) are skipped — they resolve
 * through their own per-type paths.
 */
export function resolveChannelDeclarations(config: DisclaudeConfig): ChannelDeclaration[] {
  const declarations: ChannelDeclaration[] = [];
  for (const [name, entry] of Object.entries(config.channels ?? {})) {
    if (!isChannelDeclaration(entry)) {
      continue;
    }
    const { type, ...rest } = entry;
    declarations.push({ name, type, config: rest });
  }
  return declarations;
}

/**
 * Structural validation for named declarations. Credential-field rules
 * (literals vs `$VARIABLE` references) live in `channel-credentials.ts`
 * beside the legacy per-type checks; this layer only pins the declaration
 * shape: stable name, deduplicated and not shadowing a legacy type section,
 * boolean `enabled`, and an `agent` that names a configured preset.
 */
export function channelDeclarationErrors(config: DisclaudeConfig): string[] {
  const errors: string[] = [];
  const normalizedNames = new Map<string, string>();
  for (const declaration of resolveChannelDeclarations(config)) {
    const path = `channels.${declaration.name}`;
    if (!CHANNEL_NAME_PATTERN.test(declaration.name)) {
      errors.push(
        `${path}: channel names must start with a letter or digit and contain only letters, digits, _ or -`
      );
    }
    const normalized = declaration.name.toLowerCase();
    if ((CHANNEL_TYPE_SECTION_KEYS as readonly string[]).includes(normalized)) {
      errors.push(
        `${path}: "${declaration.name}" is a built-in channel type section name; declare this channel under another name`
      );
    }
    const previous = normalizedNames.get(normalized);
    if (previous) {
      errors.push(`${path}: duplicate channel name (also ${previous})`);
    }
    normalizedNames.set(normalized, declaration.name);
    if (
      declaration.config.enabled !== undefined &&
      typeof declaration.config.enabled !== 'boolean'
    ) {
      errors.push(`${path}.enabled must be a boolean`);
    }
    const { agent } = declaration.config;
    if (agent !== undefined && (typeof agent !== 'string' || !agent.trim())) {
      errors.push(`${path}.agent must be a non-empty agents preset name`);
    } else if (typeof agent === 'string' && !Object.hasOwn(config.agents ?? {}, agent)) {
      errors.push(`${path}.agent references unknown agents preset: ${agent}`);
    }
  }
  return errors;
}
