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

## Consumer migration

- #4908 provides this shared core and public API.
- #4909 makes Codex exec and app-server consumers of the same core.
- #4910 hardens validation and trust decisions in the shared core for every consumer.
- #4911 makes Claude native plugin loading follow the same resolution decisions.
- #4912 adds Pi/DSH adapters and operator diagnostics.

Moving the registry into a shared module does not complete the consumer
migrations. A Codex transport parity test is not evidence of cross-harness
parity; each adapter needs its own integration coverage.
