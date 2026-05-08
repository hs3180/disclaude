---
name: feishu-doc-reader
description: Guidance for reading Feishu (Lark) documents and wiki pages via lark-cli. Use when user shares a Feishu document link (feishu.cn/wiki/* or feishu.cn/docx/*) and you need to read its content. Keywords: 飞书文档, feishu doc, lark doc, wiki, 文档阅读, lark-cli docs fetch, read feishu document.
---

# Feishu Document Reader

Guidance for reading Feishu (Lark) documents and wiki pages using `lark-cli`.

## When to Use

When the user shares a **Feishu document or wiki link** and you need to read the content, do **NOT** use `webReader` or `WebFetch` — Feishu documents require authentication, so those tools will only return a login page.

**Recognized URL patterns:**

- `https://*.feishu.cn/wiki/*` — Wiki pages
- `https://*.feishu.cn/docx/*` — Document pages

## Recommended Flow

### Step 1: Get Document Outline

Always start with the outline to understand the document structure before reading content:

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope outline --max-depth 3
```

### Step 2: Read Relevant Sections

Based on the outline, read only the sections you need:

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope section --start-block-id <heading_id> --detail with-ids --doc-format markdown
```

This avoids loading the entire document when only specific sections are relevant.

## Alternative: Quick Full Read

For short documents or when you need everything:

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --doc-format markdown
```

## Search by Keyword

To find specific content within a large document:

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope keyword --keyword "关键词"
```

## Parameters Reference

| Parameter | Description | Example |
|-----------|-------------|---------|
| `--doc` | Full URL or document token | `https://xxx.feishu.cn/wiki/AbCdEf` or `AbCdEf` |
| `--scope` | Reading mode: `outline`, `section`, `range`, `keyword` (default: full) | `--scope outline` |
| `--doc-format` | Output format: `markdown`, `xml`, `text` | `--doc-format markdown` |
| `--max-depth` | Outline depth (for `outline` scope) | `--max-depth 3` |
| `--start-block-id` | Section heading ID (for `section` scope) | From outline output |
| `--keyword` | Search keyword (for `keyword` scope) | `--keyword "部署"` |
| `--detail` | Detail level: `simple`, `with-ids`, `full` | `--detail with-ids` |
| `--api-version` | API version (always use `v2`) | `--api-version v2` |

## Common Mistakes

- **Using webReader/WebFetch** for Feishu URLs — will fail because auth is required. Always use `lark-cli docs +fetch`.
- **Reading the entire document** when only one section is needed — use `--scope outline` first, then `--scope section`.
- **Forgetting `--api-version v2`** — older API version has limited features.

## Examples

### Read a wiki page about deployment

```bash
# Step 1: Outline
lark-cli docs +fetch --api-version v2 --doc "https://xxx.feishu.cn/wiki/YgJMw6RRki" --scope outline --max-depth 3

# Step 2: Read the "Deployment" section
lark-cli docs +fetch --api-version v2 --doc "https://xxx.feishu.cn/wiki/YgJMw6RRki" --scope section --start-block-id "heading_xxx" --detail with-ids --doc-format markdown
```

### Search for a keyword in a doc

```bash
lark-cli docs +fetch --api-version v2 --doc "https://xxx.feishu.cn/docx/AbCdEf123" --scope keyword --keyword "配置"
```
