import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export type SkillSourceKind = 'builtin' | 'user' | 'project';

export interface SkillSource {
  kind: SkillSourceKind;
  root: string;
}

export interface ResolvedSkill {
  name: string;
  source: SkillSourceKind;
  /** Safe, source-relative reference suitable for model-facing manifests. */
  reference: string;
  description?: string;
}

export interface SkillDiagnostic {
  code: 'COLLISION' | 'INVALID_SKILL';
  name?: string;
  source: SkillSourceKind;
  detail: string;
}

export interface SkillsRegistryResolution {
  revision: string;
  skills: readonly ResolvedSkill[];
  diagnostics: readonly SkillDiagnostic[];
  manifest: string;
}

interface Candidate extends ResolvedSkill {
  priority: number;
  fingerprint: string;
}

const PRIORITY: Record<SkillSourceKind, number> = { builtin: 0, user: 1, project: 2 };

/**
 * Single source of truth for skill discovery and precedence.  The public
 * result deliberately contains source-relative references only; callers that
 * need to open a skill retain the source root separately.
 */
export class SkillsRegistry {
  private cached?: SkillsRegistryResolution;
  private cachedFingerprint?: string;

  constructor(private readonly sources: readonly SkillSource[]) {}

  resolve(): SkillsRegistryResolution {
    const diagnostics: SkillDiagnostic[] = [];
    const candidates = this.sources.flatMap((source) => this.discover(source, diagnostics));
    const fingerprint = createHash('sha256')
      .update(candidates.map((candidate) => candidate.fingerprint).sort().join('\n'))
      .update(this.sources.map((source) => `${source.kind}:${resolve(source.root)}`).sort().join('\n'))
      .digest('hex');
    if (this.cached && this.cachedFingerprint === fingerprint) {return this.cached;}

    const byName = new Map<string, Candidate>();
    for (const candidate of candidates.sort((a, b) => a.name.localeCompare(b.name) || b.priority - a.priority)) {
      const existing = byName.get(candidate.name);
      if (!existing) {
        byName.set(candidate.name, candidate);
        continue;
      }
      if (existing.priority === candidate.priority) {
        const detail = `duplicate skill name at ${candidate.source} precedence`;
        diagnostics.push({ code: 'COLLISION', name: candidate.name, source: candidate.source, detail });
        throw new Error(`Skill registry collision for "${candidate.name}": ${detail}`);
      }
      if (candidate.priority > existing.priority) {byName.set(candidate.name, candidate);}
    }

    const skills = [...byName.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, source, reference, description }) => ({ name, source, reference, description }));
    const revision = createHash('sha256').update(fingerprint).update(JSON.stringify(skills)).digest('hex').slice(0, 16);
    const manifest = formatSkillManifest(skills);
    this.cachedFingerprint = fingerprint;
    this.cached = { revision, skills, diagnostics, manifest };
    return this.cached;
  }

  private discover(source: SkillSource, diagnostics: SkillDiagnostic[]): Candidate[] {
    const root = resolve(source.root);
    const skillsRoot = join(root, 'skills');
    if (!existsSync(skillsRoot)) {return [];}
    const approvedRoot = realpathSync(root);
    let entries: string[];
    try { entries = readdirSync(skillsRoot).sort(); } catch { return []; }
    const candidates: Candidate[] = [];
    for (const name of entries) {
      const path = join(skillsRoot, name, 'SKILL.md');
      try {
        if (!statSync(path).isFile()) {continue;}
        const realPath = realpathSync(path);
        if (!realPath.startsWith(`${approvedRoot}/`) && realPath !== approvedRoot) {
          diagnostics.push({ code: 'INVALID_SKILL', name, source: source.kind, detail: 'skill resolves outside its approved root' });
          continue;
        }
        const content = readFileSync(path, 'utf8');
        const metadata = metadataFromFrontmatter(content, name);
        const reference = relative(root, path).split('\\').join('/');
        if (!reference || reference.startsWith('../')) {
          diagnostics.push({ code: 'INVALID_SKILL', source: source.kind, detail: 'skill reference is outside its source root' });
          continue;
        }
        candidates.push({
          name,
          source: source.kind,
          reference,
          description: metadata.description,
          priority: PRIORITY[source.kind],
          fingerprint: `${source.kind}:${reference}:${createHash('sha256').update(content).digest('hex')}`,
        });
      } catch {
        diagnostics.push({ code: 'INVALID_SKILL', name, source: source.kind, detail: 'skill could not be read' });
      }
    }
    return candidates;
  }
}

function metadataFromFrontmatter(source: string, directoryName: string): { description?: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {throw new Error('missing strict frontmatter');}
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([a-z][a-z0-9_-]*):[ \t]*(.*?)\s*$/i);
    if (!field || !['name', 'description'].includes(field[1])) {throw new Error('invalid frontmatter field');}
    if (fields.has(field[1]) || !field[2]) {throw new Error('invalid frontmatter value');}
    fields.set(field[1], field[2].replace(/^['"]|['"]$/g, ''));
  }
  const declaredName = fields.get('name');
  if (declaredName && declaredName !== directoryName) {throw new Error('frontmatter name does not match skill directory');}
  const description = fields.get('description');
  return description ? { description: sanitizeDescription(description) } : {};
}

function sanitizeDescription(description: string): string {
  // Strip controls and Markdown link delimiters so one metadata field cannot
  // add manifest rows, forge links, or create an oversized model prompt.
  return description
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\[\]()`<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/** Compact, stable model-facing index. No absolute filesystem paths are emitted. */
export function formatSkillManifest(skills: readonly ResolvedSkill[]): string {
  if (skills.length === 0) {return '';}
  return [
    'Disclaude skills:',
    ...skills.map((skill) => `- skill [${skill.name}](${skill.reference})${skill.description ? `: ${skill.description}` : ''}`),
  ].join('\n');
}

/** Shared Codex source layout; transports must not implement their own scan. */
export function codexSkillsRegistry(workspaceRoot: string, builtinRoot: string): SkillsRegistry {
  const workspace = resolve(workspaceRoot);
  return new SkillsRegistry([
    { kind: 'project', root: workspace },
    { kind: 'project', root: join(workspace, '.claude') },
    { kind: 'builtin', root: builtinRoot },
  ]);
}
