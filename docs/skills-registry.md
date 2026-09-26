# Shared Skills Registry

`SkillsRegistry` belongs to `@disclaude/core`, under `src/skills`. It has no
Codex, Claude, Pi, or DSH dependency. All harness adapters must consume this
contract for discovery, precedence, validation, and diagnostics rather than
implementing a private registry.

```ts
import { SkillsRegistry, type SkillSource } from '@disclaude/core';

const sources: SkillSource[] = [
  { kind: 'builtin', root: builtinRoot },
  { kind: 'user', root: userRoot },
  { kind: 'project', root: projectRoot },
];
const registry = new SkillsRegistry(sources);
const resolution = registry.resolve();
```

Each root contains a `skills/<name>/SKILL.md` tree. Source configuration belongs
to the caller; the registry neither reads a harness home directory nor assumes
that a runtime working directory is the project root. Project skills override
user skills, which override builtins. Same-priority name collisions fail.

The result contains the effective skills, a stable revision, a compact manifest,
and separate diagnostics. Only the manifest belongs in model-facing prompts.
References are relative to the selected source root; adapters retain their
source mapping to load native resources. A relative reference must not be
resolved against an unrelated chat-state working directory.

## Project skill layout

The shared project directory is `.disclaude/skills/<name>/SKILL.md`.
Codex exec and app-server resolve this source through the same adapter and
also retain the existing top-level `skills/<name>/SKILL.md` source. Both are
project-precedence sources, so duplicate names across them are rejected.

`.claude/skills` is a Claude-specific directory and is not scanned as a shared
project source. Move skills intended for the shared registry to
`.disclaude/skills`; keep Claude-only skills in `.claude/skills` for Claude's
native loader. This change does not move files or alter Claude's loader.
