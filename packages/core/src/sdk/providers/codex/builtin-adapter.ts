/** Backend-neutral discovery bridge for Disclaude builtin skills/agents. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface BuiltinResource {
  kind: 'skill' | 'agent';
  name: string;
  path: string;
  description?: string;
}

function descriptionFromMarkdown(path: string): string | undefined {
  try {
    const source = readFileSync(path, 'utf8');
    const match = source.match(/^description:\s*(.+)$/m);
    return match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return undefined;
  }
}

/** Discover resource files without invoking Claude's local-plugin API. */
export function discoverBuiltinResources(root: string): BuiltinResource[] {
  const resources: BuiltinResource[] = [];
  for (const kind of ['skill', 'agent'] as const) {
    const directory = join(root, `${kind}s`);
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const resourcePath = join(directory, entry, kind === 'skill' ? 'SKILL.md' : `${entry}.md`);
      try {
        if (!statSync(resourcePath).isFile()) {continue;}
      } catch {
        continue;
      }
      resources.push({
        kind,
        name: entry,
        path: resourcePath,
        description: descriptionFromMarkdown(resourcePath),
      });
    }
  }
  return resources;
}

/** Compact context that lets Codex discover and invoke supported builtins. */
export function formatCodexBuiltinContext(resources: BuiltinResource[]): string {
  if (resources.length === 0) {return '';}
  const lines = resources.map((resource) =>
    `- ${resource.kind} [${resource.name}](${resource.path})${resource.description ? `: ${resource.description}` : ''}`,
  );
  return [
    'Disclaude builtin resources (Codex-compatible discovery):',
    'Use a listed resource by reading its Markdown instructions; Claude-only plugin APIs are unavailable.',
    ...lines,
  ].join('\n');
}
