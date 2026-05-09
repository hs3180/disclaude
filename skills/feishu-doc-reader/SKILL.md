---
name: feishu-doc-reader
description: Guidance for reading Feishu documents via lark-cli. Use when user shares a Feishu wiki or document link (matching https://*.feishu.cn/wiki/* or https://*.feishu.cn/docx/*), or asks to read/access a Feishu document. Triggers on keywords like "飞书文档", "飞书链接", "Feishu doc", "wiki link", "lark-cli docs".
allowed-tools: Bash
---

# Feishu Document Reader

You have access to `lark-cli` for reading Feishu documents. **Do NOT use webReader** for Feishu document URLs — webReader cannot access authenticated Feishu pages and will only return the login screen.

## When to Use

When the user message contains a Feishu document or wiki link matching these patterns:

- `https://*.feishu.cn/wiki/*`
- `https://*.feishu.cn/docx/*`

## Recommended Workflow

### Step 1: Get the document outline

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope outline --max-depth 3
```

This returns the document structure with heading IDs, so you can identify relevant sections.

### Step 2: Read the relevant sections

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope section --start-block-id <heading_id> --doc-format markdown
```

Use the heading IDs from the outline to fetch only the sections you need.

### Quick read (entire document)

For short documents or when you need the full content:

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --doc-format markdown
```

### Search by keyword

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope keyword --keyword "搜索关键词"
```

## Notes

- The `--doc` parameter accepts both full URLs and document tokens
- Supports both Wiki (`/wiki/{token}`) and Document (`/docx/{id}`) URL types
- Use `--doc-format markdown` for readable output (default is XML)
- For long documents, always start with the outline to save context
