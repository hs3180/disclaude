/**
 * Disclaude built-in skills on DSH's native skill registry (#5717 rework).
 *
 * The booted DSH profile's `dsh-base` bundle mounts a native skill stack
 * (`@deepseek-ai/dsh-skill` service + `dsh-tool-skill` model tool), verified
 * against the installed dsh CLI 0.1.2-rc.1: `dsh --profile sdk
 * --dump-default-config` lists `skill`, `skill-filesystem`, `skill-badge`
 * (disabled) and `tool-skill`. Disclaude registers its built-in and explicitly
 * installed skills as ONE provider on that registry; DSH itself authors the
 * model-facing session catalog and `<skill_content>` rendering through its
 * `skill` tool. Disclaude never fabricates a skills manifest into any
 * system/developer/user prompt layer.
 *
 * `@deepseek-ai/dsh-skill` is not a workspace dependency (only the booted app
 * composition provides the service), so the shapes below are structural
 * declarations verified against `@deepseek-ai/dsh-skill@0.1.2-rc.1`
 * `lib/types/index.d.ts` (`SkillRegistry.registerProvider`, `SkillProvider`,
 * `SkillCandidate`, `SkillDefinition`, `BUNDLED_SKILL_RANK = 600`, name
 * grammar `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`).
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  parseSkillDocument,
  SkillsRegistry,
  type ResolvedSkill,
  type SkillSource,
} from '../../../skills/skills-registry.js';
import { installedDiagnosticsPlugin } from '../../../skills/diagnostics-plugin.js';

/** Provider identity inside the DSH skills registry. */
export const DISCLAUDE_DSH_SKILL_PROVIDER = 'disclaude';

/** Prompt-visible origin label for skills contributed by Disclaude. */
const DISCLAUDE_DSH_SKILL_SOURCE = 'disclaude';

/** DSH public skill-name grammar (dsh-skill SKILL_NAME); the registry throws on violations at list time. */
const DSH_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** dsh-skill BUNDLED_SKILL_RANK: packaged/local-bundled roots lose to every project/user rank. */
const DSH_BUNDLED_SKILL_RANK = 600;

interface DshSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean };
  readonly source: string;
  readonly provider: string;
  readonly resourceBase?: { readonly kind: 'directory'; readonly path: string };
}

/** Candidate shape our provider returns to the registry (structural, see module docs). */
export interface DshSkillCandidate extends DshSkillSummary {
  readonly rank: number;
  readonly locator: unknown;
  readonly path?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface DshSkillDefinition extends DshSkillSummary {
  readonly content: string;
  readonly path?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface DshSkillLookupOptions {
  readonly cwd?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface DshSkillProvider {
  readonly name: string;
  readonly list: (
    options: DshSkillLookupOptions
  ) => Promise<
    readonly DshSkillCandidate[] | { readonly candidates: readonly DshSkillCandidate[]; readonly complete: boolean }
  >;
  readonly get: (
    candidate: DshSkillCandidate,
    options: DshSkillLookupOptions
  ) => Promise<DshSkillDefinition | undefined>;
}

/** Structural `ctx.skills` face (dsh-skill SkillRegistry). */
export interface DshSkillRegistryLike {
  readonly registerProvider: (
    create: (control: { readonly signal: AbortSignal; readonly invalidate: () => void }) => DshSkillProvider
  ) => () => void;
}

/** Skill registration plan the DSH controller receives over initialize. */
export interface DisclaudeDshSkillPlan {
  /** Disclaude builtins root (contains `skills/`; `Config.getBuiltinsDir()`). */
  readonly builtinRoot: string;
  /** Project root for re-validating the explicitly installed diagnostics plugin in-process. */
  readonly projectRoot?: string;
}

/**
 * Host-side plan: built-ins always; the diagnostics skill only through its
 * explicit installation, re-validated inside DSH from projectRoot so an
 * edited/redirected install grants nothing (shared module, same boundary as
 * the claude/codex backends).
 */
export function dshSkillPlan(projectRoot: string | undefined, builtinRoot: string): DisclaudeDshSkillPlan {
  return { builtinRoot, ...(projectRoot === undefined ? {} : { projectRoot }) };
}

function skillSources(plan: DisclaudeDshSkillPlan): SkillSource[] {
  const sources: SkillSource[] = [{ kind: 'builtin', root: plan.builtinRoot }];
  const diagnostics = plan.projectRoot ? installedDiagnosticsPlugin(plan.projectRoot) : undefined;
  if (diagnostics) {
    sources.push({ kind: 'user', root: diagnostics });
  }
  return sources;
}

interface ListedSkill extends ResolvedSkill {
  /** Absolute skill directory backing `reference`. */
  readonly directory: string;
}

function listSkills(plan: DisclaudeDshSkillPlan, warn: (message: string) => void): ListedSkill[] {
  const roots = new Map(skillSources(plan).map((source) => [source.kind, source.root]));
  const skills: ListedSkill[] = [];
  for (const skill of new SkillsRegistry(skillSources(plan)).resolve().skills) {
    if (!DSH_SKILL_NAME.test(skill.name)) {
      warn(`skill "${skill.name}" is not a valid DSH skill name and stays unlisted`);
      continue;
    }
    const root = roots.get(skill.source);
    if (!root) {continue;}
    // Without a referenceRoot the registry emits paths relative to the source
    // root: `skills/<name>/SKILL.md`.
    skills.push({ ...skill, directory: join(root, dirname(skill.reference)) });
  }
  return skills;
}

/**
 * Register the Disclaude provider on the booted profile's skill registry.
 * Discovery and precedence reuse the shared `SkillsRegistry` (one semantic
 * across claude/codex/DSH, reusable by the future Pi channel, T-100); the
 * DSH-native candidates are derived from its resolution. Names outside DSH's
 * public grammar are dropped with a warning instead of failing every catalog.
 *
 * @returns the registry disposer plus the number of listed skills.
 */
export function registerDisclaudeSkills(
  registry: DshSkillRegistryLike,
  plan: DisclaudeDshSkillPlan,
  warn: (message: string) => void
): { dispose: () => void; skills: number } {
  let listed: ListedSkill[] | undefined;
  const resolve = (): ListedSkill[] => (listed ??= listSkills(plan, warn));
  return {
    dispose: registry.registerProvider(() => ({
      name: DISCLAUDE_DSH_SKILL_PROVIDER,
      list: (options) => {
        options.signal?.throwIfAborted();
        return Promise.resolve(resolve().map((skill) => ({
          name: skill.name,
          description: skill.description ?? skill.name,
          invocation: { modelInvocable: true, userInvocable: false },
          source: DISCLAUDE_DSH_SKILL_SOURCE,
          provider: DISCLAUDE_DSH_SKILL_PROVIDER,
          rank: DSH_BUNDLED_SKILL_RANK,
          locator: { directory: skill.directory, name: skill.name },
          resourceBase: { kind: 'directory', path: skill.directory },
          path: join(skill.directory, 'SKILL.md'),
        })));
      },
      get: async (candidate, options) => {
        options.signal?.throwIfAborted();
        const { name, path } = candidate;
        if (typeof path !== 'string' || !path.endsWith('SKILL.md')) {return undefined;}
        let content: string;
        try {
          content = await readFile(path, { encoding: 'utf8', signal: options.signal });
        } catch {
          return undefined;
        }
        try {
          const document = parseSkillDocument(content, name);
          return {
            name,
            description: candidate.description,
            invocation: candidate.invocation,
            source: DISCLAUDE_DSH_SKILL_SOURCE,
            provider: DISCLAUDE_DSH_SKILL_PROVIDER,
            resourceBase: candidate.resourceBase,
            content: document.body.trim(),
            path,
          };
        } catch {
          warn(`skill "${name}" at ${path} could not be parsed and stays unloadable`);
          return undefined;
        }
      },
    })),
    skills: resolve().length,
  };
}
