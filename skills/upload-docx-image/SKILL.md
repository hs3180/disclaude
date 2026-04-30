---
name: upload-docx-image
description: Insert an image into a Feishu document at a specific position. Use when the agent needs to add an image (chart, diagram, screenshot) into a Feishu document at a precise location, not just appended at the end. Keywords: "insert image", "上传文档图片", "插入图片", "文档图片", "inline image", "docx image".
allowed-tools: [Bash]
---

# Upload Feishu Document Image

Insert an image at a specific position in a Feishu document via lark-cli three-step API process.

## Single Responsibility

- ✅ Insert an image into a Feishu document at a specific index position
- ✅ Validate document ID and image file
- ✅ Rollback empty blocks on upload failure
- ❌ DO NOT create or manage documents
- ❌ DO NOT upload images to Feishu messages (use `lark-cli im` instead)
- ❌ DO NOT read FEISHU_APP_ID / FEISHU_APP_SECRET directly — always use lark-cli auth

## When to Use

Use this skill when:
1. The user asks to insert an image into a Feishu document at a **specific position** (not just append)
2. `lark-cli docs +media-insert` is insufficient because it only appends to the end
3. Generating reports or documents that need inline images (charts, diagrams, etc.)

**Do NOT use when:**
- Uploading images for chat messages → use `lark-cli im` instead
- Appending to the end is acceptable → use `lark-cli docs +media-insert` (simpler)

## Invocation

```bash
DOCX_DOC_ID="doxcnabcd1234" \
DOCX_IMAGE_PATH="/path/to/image.png" \
DOCX_INDEX="3" \
npx tsx skills/upload-docx-image/upload-docx-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOCX_DOC_ID` | Yes | Feishu document ID (alphanumeric, may contain `-` and `_`) |
| `DOCX_IMAGE_PATH` | Yes | Local file path to the image |
| `DOCX_INDEX` | No | Insert position: `-1` = append (default), `0+` = specific index |
| `DOCX_SKIP_LARK` | No | Set to `1` for dry-run / testing (skips all API calls) |

### Context Variables

When invoked, you receive:
- **Document ID**: From the user's message or the document being edited
- **Image Path**: Local path to the image file (from a previous tool output or user-provided)
- **Index**: Determine based on where the image should appear relative to other content

## Execution Flow

```
1. Validate DOCX_DOC_ID and DOCX_IMAGE_PATH
2. Check lark-cli availability and authentication status
3. Step 1: Create empty image block (block_type: 27) at specified index
   → lark-cli api POST /open-apis/docx/v1/documents/{docId}/blocks/{docId}/children
4. Step 2: Upload image via Drive Media Upload API (parent_type: docx_image)
   → lark-cli drive upload (handles multipart + auth)
5. Step 3: Bind uploaded image to block (replace_image)
   → lark-cli api PATCH /open-apis/docx/v1/documents/{docId}/blocks/{blockId}
6. On failure in step 2/3: rollback by deleting the empty block
```

## Prerequisites

- **lark-cli** must be installed (`npm install -g @larksuite/cli`)
- **lark-cli** must be authenticated (`lark-cli auth login --recommend`)
- The app must have **drive:drive:media:upload** and **docx:document** scopes

## Supported Image Formats

| Format | Extension |
|--------|-----------|
| PNG | `.png` |
| JPEG | `.jpg`, `.jpeg` |
| GIF | `.gif` |
| BMP | `.bmp` |
| WebP | `.webp` |

**Max file size**: 20 MB

## Architecture

All Feishu API calls use **lark-cli** for authentication — no direct credential handling. The script follows the same pattern as `skills/rename-group/rename-group.ts`:
- `lark-cli api METHOD /path -d '{...}'` for JSON API calls
- `lark-cli drive` shortcuts for file upload (multipart form-data)

## Error Handling

- **Step 1 fails**: Script exits immediately (no cleanup needed)
- **Step 2 or 3 fails**: Empty block created in step 1 is deleted (best-effort rollback)
- **Rollback fails**: Warning is logged but script still exits with error code

## Safety Guarantees

- **Input validation**: Document ID regex, image format whitelist, file size check
- **Auth check**: Verifies lark-cli is authenticated before making API calls
- **Rollback**: Empty blocks are cleaned up on failure to prevent document pollution
- **No credential access**: Uses lark-cli's built-in auth exclusively
