# Project Templates

This directory contains project templates that are **auto-discovered** at startup.

## How It Works

Each subdirectory containing a `CLAUDE.md` file is automatically recognized as a valid project template. No manual configuration needed.

## Adding a Template

1. Create a subdirectory: `templates/my-template/`
2. Add a `CLAUDE.md` file with the template instructions
3. Optionally add a `template.yaml` for metadata:

```yaml
displayName: "My Template"
description: "A description of this template"
```

## Example Structure

```
templates/
├── research/
│   ├── CLAUDE.md          # Required: template instructions
│   └── template.yaml      # Optional: display metadata
├── code-review/
│   └── CLAUDE.md
└── README.md              # This file (ignored by discovery)
```

## Metadata Priority

1. `template.yaml` (highest priority)
2. `CLAUDE.md` YAML frontmatter (`---` block at the top)

## Restrictions

- Directory name "default" is reserved (cannot be used as a template name)
- Directory names must not contain path traversal characters (`..`, `/`, `\`)
- Directory names must be <= 64 characters

@see Issue #2286
