---
name: insert-doc-image
description: Upload and insert a local image into a Feishu document at a specific position. Use when the agent needs to place an image at a precise location in a doc, not just append to the end. Keywords: "插入文档图片", "文档图片", "insert doc image", "docx image", "飞书文档图片", "图片插入", "inline image".
allowed-tools: [Bash]
---

# Insert Doc Image

Upload a local image into a Feishu document at a specific position using lark-cli.

## Single Responsibility

- ✅ Upload a local image to a Feishu document at a specified index position
- ✅ Fall back to append (end of document) when index is -1 or beyond block count
- ✅ Validate document ID, image file path, and supported formats
- ✅ Handle partial failure with rollback (re-insert at end if positioned insert fails)
- ✅ Use lark-cli for all operations (auth, upload, block manipulation)
- ❌ DO NOT read FEISHU_APP_ID / FEISHU_APP_SECRET directly
- ❌ DO NOT handle image URLs (use `docs +create` / `docs +update` with `<image url="..."/>` instead)
- ❌ DO NOT modify document text or other blocks

## Invocation

This skill is invoked by the agent when it needs to insert a local image into a specific position within a Feishu document.

### Usage

```bash
DOC_IMAGE_DOC_ID="doxcnXXXX" \
DOC_IMAGE_FILE_PATH="./chart.png" \
DOC_IMAGE_INDEX=3 \
DOC_IMAGE_ALIGN="center" \
DOC_IMAGE_CAPTION="架构图" \
npx tsx skills/insert-doc-image/insert-doc-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOC_IMAGE_DOC_ID` | Yes | Feishu document ID (doxcnXXX format) |
| `DOC_IMAGE_FILE_PATH` | Yes | Local path to the image file (PNG/JPG/GIF/WebP/BMP, max 20MB) |
| `DOC_IMAGE_INDEX` | Yes | Target position (0-based). Use -1 to append at end. |
| `DOC_IMAGE_ALIGN` | No | Image alignment: `left`, `center` (default), `right` |
| `DOC_IMAGE_CAPTION` | No | Image caption text |
| `DOC_IMAGE_SKIP_LARK` | No | Set to `1` for dry-run (testing only) |

### Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from message header, not used by this skill)
- The agent should determine `DOC_IMAGE_DOC_ID`, `DOC_IMAGE_FILE_PATH`, and `DOC_IMAGE_INDEX` from context.

## Execution Flow

```
1. Validate DOC_IMAGE_DOC_ID (doxcnXXX), DOC_IMAGE_FILE_PATH (exists + format)
2. Check lark-cli availability and authentication
3. If index == -1 or index >= block_count:
   → lark-cli docs +media-insert (appends to end) → done
4. If specific index:
   a. lark-cli docs +media-insert → upload image, get file_token (appended at end)
   b. lark-cli api DELETE .../batch_delete → remove appended block
   c. lark-cli api POST .../children → create image block at target index with file_token
   d. If step c fails → rollback: re-insert at end using file_token
```

## When to Use

1. **Document with charts/diagrams**: When generating a report with inline charts that need to be at specific positions relative to text.
2. **After docs +create**: When the document was created with text content and images need to be placed at exact locations.
3. **Not for appending**: If the image just needs to go at the end, use `lark-cli docs +media-insert` directly (no skill needed).

## Architecture

All operations use **lark-cli** — auth is handled by lark-cli's built-in mechanism (keychain / env vars).

- **Upload**: `lark-cli docs +media-insert` handles multipart upload and auth internally
- **Block manipulation**: `lark-cli api` for raw Feishu Docx API calls (create block, delete block)
- **No direct HTTP**: No Node.js `https` calls — everything goes through lark-cli

## Safety Guarantees

- **Input validation**: Doc ID must be `doxcnXXX`, image must exist and be supported format
- **Rollback on failure**: If positioned insert fails, image is re-inserted at end
- **Idempotent upload**: The same image can be inserted multiple times (each creates a new block)
- **No auth leakage**: Never reads FEISHU_APP_ID or FEISHU_APP_SECRET
