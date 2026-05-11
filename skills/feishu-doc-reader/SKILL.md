---
name: feishu-doc-reader
description: "Feishu document reader — use lark-cli to read Feishu Wiki/Document links instead of webReader. Trigger when user shares a feishu.cn/wiki or feishu.cn/docx URL. 关键词: 飞书文档, 飞书链接, feishu doc, read document."
allowed-tools: Bash
---

# Feishu Document Reader

Read Feishu Wiki and Document pages using `lark-cli docs +fetch`.

## Why lark-cli Instead of webReader

**webReader cannot access Feishu documents** — they require authentication and return only a login page. `lark-cli` is pre-configured with bot credentials and can read any document the bot has access to.

## When to Use

When the user message contains a Feishu document or wiki URL matching these patterns:

- `https://*.feishu.cn/wiki/*` (Wiki pages)
- `https://*.feishu.cn/docx/*` (Documents)
- `https://*.feishu.cn/sheets/*` (Sheets — not supported by docs +fetch, skip)

## Recommended Flow

### Step 1: Get the outline

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope outline --max-depth 3
```

This returns the document structure with heading IDs. Use this to understand what sections are available.

### Step 2: Read relevant sections

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope section --start-block-id <heading_id> --doc-format markdown
```

Use the `heading_id` from the outline to read only the sections relevant to the user's question.

### Quick Read (entire document)

For short documents or when the user asks for a full summary:

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --doc-format markdown
```

### Search by keyword

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope keyword --keyword "关键词"
```

## Notes

- The `--doc` parameter accepts both full URLs and document tokens
- `--doc-format markdown` is recommended for readability
- If lark-cli returns an error about permissions, inform the user that the bot may not have access to that document
- For large documents, prefer the outline → section approach to avoid excessive output

## DO NOT

- Do NOT use webReader for Feishu document URLs — it will only get the login page
- Do NOT attempt to read Sheets URLs (`/sheets/`) — they are not supported by `docs +fetch`
- Do NOT read the entire document when the user only asks about a specific section
