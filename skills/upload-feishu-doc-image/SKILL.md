---
name: upload-feishu-doc-image
description: Upload and insert an image into a Feishu document at a specific position. Use when the agent needs to embed charts, screenshots, or any image into a Feishu doc at a precise location (not just appended at the end). Keywords: "上传飞书文档图片", "insert image feishu", "飞书图片", "文档图片插入", "inline image".
allowed-tools: [Bash]
user-invocable: true
---

# 上传飞书文档图片

Insert an image into a Feishu document at a specific position using lark-cli.

## Problem

`lark-cli docs +media-insert` only appends images to the end of a document. This skill inserts images at arbitrary positions by:
1. Uploading the image via `lark-cli docs +media-insert` (appends to end, auth handled by lark-cli)
2. Extracting the file_token from the uploaded block
3. Creating an empty image block at the desired position
4. Binding the file_token to the positioned block
5. Cleaning up the temporary block at the end

## Single Responsibility

- ✅ Insert an image at a specific position in a Feishu document
- ✅ Validate document ID, image file, and position
- ✅ Clean up temporary blocks on failure (rollback)
- ✅ Handle the append case (index = -1) efficiently
- ❌ DO NOT create or delete documents
- ❌ DO NOT modify document text content
- ❌ DO NOT handle image editing/resizing

## Invocation

This skill is invoked by the agent when it needs to insert an image into a Feishu document at a specific position.

### Usage

```bash
DOC_ID="your_document_id" \
IMAGE_PATH="/path/to/chart.png" \
INSERT_INDEX="3" \
npx tsx skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOC_ID` | Yes | Feishu document ID (alphanumeric, may include `_` and `-`) |
| `IMAGE_PATH` | Yes | Absolute path to image file (PNG/JPG/JPEG, max 20 MB) |
| `INSERT_INDEX` | Yes | 0-based position to insert at (-1 to append to end) |
| `UPLOAD_SKIP_LARK` | No | Set to '1' to skip API calls (dry-run testing) |

### Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from message header)

## Execution Flow

```
1. Validate inputs (DOC_ID, IMAGE_PATH, INSERT_INDEX)
2. Check image file exists and size ≤ 20 MB
3. Check lark-cli availability
4. Get current document block count
5. If INSERT_INDEX == -1 (append):
   → Upload via +media-insert directly (single step)
6. If INSERT_INDEX >= 0 (positional insert):
   a. Upload image via +media-insert (appends to end, gets file_token)
   b. Create empty block (block_type: 27) at desired position
   c. Bind file_token to the empty block via replace_image
   d. Delete temporary block at end (cleanup)
7. Report success or failure with rollback on error
```

## How It Works

### Authentication

This skill uses **lark-cli's built-in authentication** exclusively — no manual credential handling. All API calls go through `lark-cli api` or `lark-cli docs +media-insert`, which handle authentication automatically.

If lark-cli is not authenticated, the skill exits with a clear error message asking the user to authenticate first.

### Insertion Strategy

For positional inserts (index ≥ 0), the skill uses a 5-step process:

1. **Upload**: `lark-cli docs +media-insert` uploads the image and creates a complete image block at the end
2. **Read**: `lark-cli api GET` retrieves the file_token from the new block
3. **Create**: `lark-cli api POST` creates an empty image block (`block_type: 27`) at the desired position
4. **Bind**: `lark-cli api PATCH` binds the file_token to the positioned block
5. **Cleanup**: `lark-cli api DELETE` removes the temporary block from the end

For append operations (index = -1), only step 1 is needed.

### Important: block_type 27 (not 4!)

The correct image block type is **27**. Using `block_type: 4` (which is Heading2) causes `invalid param` errors.

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
  npx tsx skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
```

## Safety Guarantees

- **Input validation**: DOC_ID must match alphanumeric pattern, image must be PNG/JPG/JPEG, size ≤ 20 MB
- **Rollback on failure**: If steps 3 or 4 fail, the skill attempts to clean up both the empty block and the temporary upload block
- **Auth via lark-cli**: No direct credential handling — uses lark-cli's built-in auth
- **Dry-run mode**: Set `UPLOAD_SKIP_LARK=1` to validate inputs without making API calls

## Architecture

All Feishu API calls go through `lark-cli` — consistent with existing skills (rename-group, pr-scanner, etc.).
