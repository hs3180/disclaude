---
name: feishu-doc-reader
description: Read Feishu document and wiki content via lark-cli. Use when user shares Feishu doc/wiki links and you need to access the content. Keywords: "飞书文档", "飞书知识库", "feishu doc", "lark doc", "飞书链接".
allowed-tools: [Bash]
---

# Feishu Doc Reader

Read Feishu documents and wiki pages via `lark-cli docs +fetch`.

## When to Use

**Trigger this skill when:**
- User shares a Feishu document link (matching `https://*.feishu.cn/wiki/*` or `https://*.feishu.cn/docx/*`)
- User asks you to read, summarize, or analyze a Feishu document
- You encounter a Feishu document URL in conversation

## Important: Do NOT Use webReader

Feishu documents require authentication. The built-in `webReader` tool cannot access them — it will only get the login page.

**Always use `lark-cli docs +fetch` instead.**

## How to Read Feishu Documents

### Recommended: Two-Step Flow (Outline → Section)

For large documents, use the two-step approach for efficiency:

**Step 1: Get the document outline**
```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope outline --max-depth 3
```

**Step 2: Read relevant sections**
```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope section --start-block-id <heading_id> --doc-format markdown
```

### Quick Read: Entire Document

For shorter documents or when you need the full content:
```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --doc-format markdown
```

### Search by Keyword

When looking for specific information:
```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope keyword --keyword "关键词"
```

## URL Formats Supported

The `--doc` parameter accepts both full URLs and document tokens:

| Type | Format | Example |
|------|--------|---------|
| Wiki | `https://xxx.feishu.cn/wiki/{token}` | `https://example.feishu.cn/wiki/YgJMw6RRkifisVkPVR8cKnWLnmb` |
| Document | `https://xxx.feishu.cn/docx/{id}` | `https://example.feishu.cn/docx/ABC123def456` |

## Workflow

1. **Detect** the Feishu doc/wiki URL in the user message
2. **Read outline** first (for documents you haven't seen before)
3. **Read sections** relevant to the user's question
4. **Respond** with the extracted information, citing the document

## Examples

### Example 1: User shares a wiki link
```
User: 帮我看看这个文档 https://xxx.feishu.cn/wiki/YgJMw6RRki
```

Steps:
1. Run outline fetch to understand the document structure
2. Based on the user's intent, read relevant sections or the full document
3. Summarize or answer the user's question

### Example 2: User asks about specific content
```
User: 这个文档里关于部署的部分写了什么？https://xxx.feishu.cn/docx/ABC123
```

Steps:
1. Run outline fetch to find the "部署" section heading ID
2. Read that specific section
3. Summarize the deployment-related content

## DO NOT

- Do NOT use `webReader` or `mcp__web_reader__webReader` for Feishu document URLs
- Do NOT ask the user to copy-paste document content — use lark-cli instead
- Do NOT skip the outline step for large or unknown documents
