---
name: upload-doc-image
description: Insert an image into a Feishu document at a specific position. Use when the agent needs to upload images inline in a Feishu doc, generate illustrated reports with proper image placement, or insert charts/diagrams at specific locations. Keywords: "上传飞书文档图片", "插入图片", "文档图片", "image insertion", "飞书文档图片", "inline image".
allowed-tools: [Bash]
---

# Upload Feishu Document Image

Insert an image into a Feishu document at a specific position using lark-cli.

## Single Responsibility

- ✅ Insert an image at a specific position in a Feishu document
- ✅ Validate document ID, image file, and position
- ✅ Handle cleanup on partial failure (rollback empty blocks)
- ❌ DO NOT create or delete documents
- ❌ DO NOT modify document text content
- ❌ DO NOT handle image editing/resizing
- ❌ DO NOT read FEISHU_APP_ID/FEISHU_APP_SECRET directly — use lark-cli auth

## Problem

`lark-cli docs +media-insert` only appends images to the end of a document. This skill inserts images at arbitrary positions by uploading first, then rearranging blocks.

## Invocation

This skill is invoked by the agent when it needs to insert an image into a Feishu document at a specific position.

### Usage

```bash
DOC_ID="your_document_id" \
IMAGE_PATH="/path/to/image.png" \
INSERT_INDEX="3" \
npx tsx skills/upload-doc-image/upload-doc-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOC_ID` | Yes | Feishu document ID (from doc URL) |
| `IMAGE_PATH` | Yes | Absolute path to the image file (PNG/JPG/JPEG) |
| `INSERT_INDEX` | Yes | 0-based position to insert at (-1 to append to end) |
| `UPLOAD_DOC_IMAGE_SKIP_LARK` | No | Set to '1' to skip lark-cli check and API calls (testing) |

### Authentication

This skill uses **lark-cli's built-in authentication** — the same auth mechanism as `rename-group` and other skills. No separate `FEISHU_APP_ID`/`FEISHU_APP_SECRET` env vars are required.

If lark-cli is not authenticated, the script will detect this and instruct the user to run `lark-cli auth login` first.

## Execution Flow

```
1. Validate inputs (DOC_ID, IMAGE_PATH, INSERT_INDEX)
2. Check lark-cli availability
3. If INSERT_INDEX == -1 (append):
   a. lark-cli docs +media-insert → done
4. If INSERT_INDEX >= 0 (specific position):
   a. lark-cli docs +media-insert → upload image, append to end
   b. Read appended block to extract file_token
   c. Delete appended block via lark-cli api DELETE
   d. Create empty image block at desired index via lark-cli api POST
   e. Bind file_token to new block via lark-cli api PATCH (replace_image)
5. Report block_id and file_token on success
6. On failure at steps 4d/4e: clean up any orphaned empty blocks
```

## How It Works

### Append Mode (INSERT_INDEX = -1)

Uses `lark-cli docs +media-insert` directly. This is the simplest case — no block manipulation needed.

### Position Mode (INSERT_INDEX >= 0)

The Lark API requires 3 steps to insert an image at a specific position, but since `lark-cli api` doesn't support multipart file uploads, we use a workaround:

1. **Upload** — `lark-cli docs +media-insert` handles the multipart upload and appends to end
2. **Rearrange** — Extract the file_token, delete the appended block, create a new empty block at the desired position, then bind the file_token to it

### Important: block_type 27 (not 4!)

The correct image block type is **27**. Using `block_type: 4` (which is actually Heading2) causes `invalid param` errors.

## When to Use

1. **Generating illustrated documents**: When creating reports with charts/diagrams that need proper placement
2. **Fixing image positions**: When images were appended but should be inline
3. **Combining with lark-cli**: Use `lark-cli docs +create --markdown` for text, then this skill for images

### Typical Workflow

```bash
# 1. Create document with text content
lark-cli docs +create --markdown @report.md
# → returns document_id

# 2. Generate chart/diagram
# (agent creates the image file)

# 3. Insert image at the right position
DOC_ID="xxx" IMAGE_PATH="./chart.png" INSERT_INDEX="3" \
  npx tsx skills/upload-doc-image/upload-doc-image.ts

# 4. Repeat for additional images
```

## Architecture

This skill uses **lark-cli for all operations** (no direct API calls with manual auth):

- `lark-cli docs +media-insert` — handles multipart file upload with lark-cli's auth
- `lark-cli api POST` — creates image blocks at specific positions
- `lark-cli api DELETE` — cleans up blocks during rearrangement
- `lark-cli api PATCH` — binds uploaded files to image blocks

This is consistent with existing skills like `rename-group` that use lark-cli for all API operations.

## Safety Guarantees

- **Input validation**: DOC_ID must be non-empty, image must be PNG/JPG/JPEG, size ≤ 20 MB
- **Rollback**: If block creation or binding fails, the orphaned empty block is deleted
- **File path resolution**: Resolves to absolute path to prevent directory traversal
- **Dry-run mode**: Set `UPLOAD_DOC_IMAGE_SKIP_LARK=1` to validate inputs without making API calls
