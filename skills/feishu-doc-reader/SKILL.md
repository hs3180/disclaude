---
name: feishu-doc-reader
description: "Read Feishu (Lark) documents via lark-cli. Use when the user shares a Feishu doc/wiki/docx link or asks to read content from a Feishu document. Keywords: '飞书文档', 'read doc', 'fetch doc', 'doc link', 'wiki link', '文档内容', '查看文档', 'Feishu doc', 'Lark doc'."
allowed-tools: [Bash]
---

# Feishu Doc Reader

Read Feishu (Lark) documents via `lark-cli docs +fetch`. This skill provides guidance for the Agent to access Feishu document content that cannot be reached by standard web readers (which lack authentication).

**Use for**: Reading Feishu doc/wiki content, extracting document text, navigating document structure
**Not for**: Editing documents, uploading images (use `upload-feishu-doc-image` skill), creating documents

## When to Activate

Activate this skill when:
- User shares a Feishu URL: `https://*.feishu.cn/docx/*`, `https://*.feishu.cn/wiki/*`, `https://*.feishu.cn/doc/*`
- User asks to read/check/fetch a Feishu document's content
- User refers to a document by name and provides a link

## URL Pattern Detection

Feishu document URLs follow these patterns:

| Type | URL Pattern | Token Location |
|------|-------------|----------------|
| Docx | `https://*.feishu.cn/docx/{token}` | path segment after `/docx/` |
| Wiki | `https://*.feishu.cn/wiki/{wiki_token}` | path segment after `/wiki/` |
| Legacy Doc | `https://*.feishu.cn/doc/{token}` | path segment after `/doc/` |

Extract the token from the URL. For **wiki** URLs, see Step 2 below for special handling.

## Workflow

### Step 1: Extract Document Token

From the URL, extract the document token. For example:
- `https://abc.feishu.cn/docx/DoxcnOabcdefg1234567` → token = `DoxcnOabcdefg1234567`
- `https://abc.feishu.cn/wiki/Wkbcdefg1234567` → wiki_token = `Wkbcdefg1234567`

If the URL contains query parameters like `?from=from_copylink` or a `#` fragment, ignore them — only the path segment matters.

### Step 2: Resolve Wiki Token (wiki URLs only)

**Wiki URLs require an extra resolution step.** The `/wiki/{wiki_token}` path contains a `wiki_token`, not the underlying document's `obj_token`. You must resolve it first:

```bash
lark-cli wiki spaces get_node --token {wiki_token}
```

This returns JSON with:
- `obj_token` — the actual document token to use with `docs +fetch`
- `obj_type` — the document type (usually `docx` or `doc`)

Use the returned `obj_token` as the document token in subsequent steps.

**For docx and legacy doc URLs, skip this step** — the token in the URL is already the `obj_token`.

### Step 3: Get Document Outline (Recommended First Step)

Always start by fetching the document outline to understand its structure:

```bash
lark-cli docs +fetch {token} --scope outline
```

This returns the document's table of contents, showing section titles and their positions. Use this to decide which sections to read in detail.

**Tip**: For short documents (< 20 sections), you may skip the outline and fetch the full content directly.

### Step 4: Read Document Content

Choose the appropriate scope based on your needs:

| Scope | Use When | Command |
|-------|----------|---------|
| `outline` | Get document structure/TOC | `lark-cli docs +fetch {token} --scope outline` |
| `section` | Read a specific section | `lark-cli docs +fetch {token} --scope section:{section_id}` |
| `range` | Read a range of sections | `lark-cli docs +fetch {token} --scope range:{start_id}..{end_id}` |
| `keyword` | Search for a keyword | `lark-cli docs +fetch {token} --scope keyword:{keyword}` |
| *(default)* | Read full document | `lark-cli docs +fetch {token}` |

#### Detail Levels

Control output verbosity with `--detail`:

| Level | Output |
|-------|--------|
| `simple` (default) | Clean text content, good for reading |
| `with-ids` | Includes section/block IDs (needed for `section`/`range` scope) |
| `full` | Full raw structure with all metadata |

**For outline + section navigation**: Use `--detail with-ids` to get section IDs from the outline, then use those IDs with `--scope section:{id}`.

#### Output Format

Control output format with `--doc-format`:

| Format | Use When |
|--------|----------|
| `markdown` (default) | Reading document content, most readable |
| `text` | Plain text extraction, no formatting |
| `xml` | Structured parsing, programmatic access |

### Step 5: Present Content to User

After fetching, present the document content in a clear, organized manner:

1. Summarize what the document covers
2. Present the relevant sections the user asked about
3. If the document is long, offer to read specific sections in detail

## Recommended Two-Step Flow

For most documents, follow this efficient pattern:

```bash
# Step A: Get outline with section IDs
lark-cli docs +fetch {token} --scope outline --detail with-ids

# Step B: Read specific sections of interest
lark-cli docs +fetch {token} --scope section:{section_id} --detail simple
```

This avoids fetching large documents in full and focuses on relevant sections.

## Examples

### Read a docx document

```bash
# User shares: https://abc.feishu.cn/docx/DoxcnOabcdefg1234567
lark-cli docs +fetch DoxcnOabcdefg1234567 --scope outline --detail with-ids
# Then read specific sections:
lark-cli docs +fetch DoxcnOabcdefg1234567 --scope section:{section_id}
```

### Read a wiki document

```bash
# User shares: https://abc.feishu.cn/wiki/Wkbcdefg1234567
# Step 1: Resolve wiki token
lark-cli wiki spaces get_node --token Wkbcdefg1234567
# Step 2: Use returned obj_token
lark-cli docs +fetch {obj_token} --scope outline
# Step 3: Read content
lark-cli docs +fetch {obj_token} --scope section:{section_id}
```

### Read a full short document

```bash
# For short documents, skip outline
lark-cli docs +fetch DoxcnOabcdefg1234567
```

### Search for a keyword in a document

```bash
lark-cli docs +fetch DoxcnOabcdefg1234567 --scope keyword:API设计
```

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| Token not found | Invalid token or URL | Verify the URL and extract token correctly |
| Permission denied | Bot lacks access to the document | Inform user that the bot needs document access |
| Wiki resolution fails | Invalid wiki_token | Check the wiki URL and try again |
| Empty content | Document is empty or token wrong | Verify token, check if document has content |
| Timeout | Document too large | Use `--scope section` to read parts individually |

If `lark-cli` is not installed or fails, inform the user that Feishu document reading requires `lark-cli` to be configured.

## DO NOT

- Do NOT attempt to use web readers (mcp__web_reader__webReader) for Feishu URLs — they cannot access authenticated content
- Do NOT modify, edit, or write to Feishu documents — this skill is read-only
- Do NOT expose document tokens in public channels
- Do NOT fetch entire large documents when only a section is needed — use the two-step flow
