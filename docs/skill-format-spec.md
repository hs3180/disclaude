# CLI Skill format

Disclaude supports both agent-invoked `SKILL.md` instructions and command-line
tools documented by a Skill `README.md`. They are related but distinct: an
agent Skill teaches the harness when and how to act; a CLI Skill documents a
deterministic command that the agent can invoke.

## CLI contract

A CLI Skill exposes a documented command, either as a packaged executable
(such as `disclaude channel`) or as a script:

```sh
node skills/<name>/cli.mjs <command> [arguments] [options]
```

- Use stable subcommands and long option names. Document required arguments,
  accepted values, and side effects.
- Accept large structured input from a file or stdin rather than requiring
  multi-kilobyte shell arguments.
- Send diagnostics and progress to stderr. By default, stdout contains one
  machine-readable JSON result; a short plain-text result is acceptable when
  the README explicitly documents it.
- Exit with `0` on success and nonzero on failure. When returning JSON, use
  `ok: true` for success and `ok: false` for failure; do not encode an error as
  a successful result.

Example:

```json
{"ok":true,"command":"screenshot","artifact":"workspace/browser/shot.png"}
```

## Skill README

The README is the command's human- and agent-facing interface. It should cover:

1. Purpose and a working quick start.
2. Every command, argument, option, and expected side effect.
3. Output fields and exit behavior, including an error example.
4. Runtime requirements and configuration, including what is not bundled.
5. Artifacts, persistent state, and their ownership/cleanup behavior.
6. Important limitations and any supported alternatives.

Link to a sibling `SKILL.md` when agent-facing instructions are also provided.
Do not require historical issue numbers, PR links, or migration status as part
of a user-facing Skill contract.

## Artifacts and state

Do not place binary or bulky output in JSON. Write it to a documented path and
return the path in an `artifact` or `artifacts` field. Explain whether files
are overwritten, accumulated, or caller-managed. Preserve user data by default;
document any command that deletes or replaces it.

For commands that keep state between invocations, document the state location,
how the caller selects it, and who is responsible for cleanup. Do not imply
that a later command shares state unless that behavior is implemented.

## References

- [`skills/channel/README.md`](../skills/channel/README.md) documents the
  packaged `disclaude channel` command.
- [`skills/browser-use/SKILL.md`](../skills/browser-use/SKILL.md) documents the
  browser automation Skill and its command-line tool.
- The [shared skills registry](skills-registry.md) defines Skill discovery and
  precedence across agent harnesses.
