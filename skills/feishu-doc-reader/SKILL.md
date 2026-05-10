---
name: feishu-doc-reader
description: "飞书文档阅读引导 — 当用户消息包含飞书文档/Wiki链接时，指导 Agent 使用 lark-cli 读取文档内容。Use when encountering Feishu document or wiki links (matching https://*.feishu.cn/wiki/* or https://*.feishu.cn/docx/*). Keywords: 飞书文档, feishu doc, wiki link, lark-cli, 飞书链接."
allowed-tools: Bash
---

# Feishu Document Reader

When the user message contains a Feishu document or wiki link (matching patterns like `https://*.feishu.cn/wiki/*` or `https://*.feishu.cn/docx/*`), do NOT use webReader or WebFetch — they cannot access authenticated Feishu pages.

Instead, use `lark-cli docs +fetch` to read the document content.

## Recommended Two-Step Flow

### Step 1: Get Document Outline

First, fetch the outline to understand the document structure:

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope outline --max-depth 3
```

This returns the document's heading hierarchy with block IDs needed for targeted reading.

### Step 2: Read Relevant Sections

Based on the outline, read specific sections of interest:

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope section --start-block-id <heading_id> --doc-format markdown
```

## Quick Read (Entire Document)

For short documents or when you need the full content:

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --doc-format markdown
```

## Supported URL Patterns

- Wiki: `https://xxx.feishu.cn/wiki/{token}`
- Document: `https://xxx.feishu.cn/docx/{id}`

The `--doc` parameter accepts both full URLs and document tokens.

## Advanced Usage

- **Read a range of blocks**: `--scope range --start-block-id <id> --end-block-id <id>`
- **Search by keyword**: `--scope keyword --keyword "关键词"`
- **Detail levels**: `--detail simple` (text only), `--detail with-ids` (includes block IDs), `--detail full`
- **Output formats**: `--doc-format markdown` (recommended), `--doc-format xml`, `--doc-format text`

## Workflow

1. Detect Feishu doc/wiki URL in user message
2. Fetch outline first (`--scope outline`)
3. Decide whether to read full doc or specific sections
4. Read and summarize the content for the user
5. If the user asks follow-up questions about the document, use `--scope keyword` or `--scope section` to find answers

## DO NOT

- Do NOT use webReader or WebFetch for Feishu URLs — they will only get the login page
- Do NOT ask the user to copy-paste the document content — use lark-cli directly
- Do NOT skip the outline step for long documents — it saves tokens and time
