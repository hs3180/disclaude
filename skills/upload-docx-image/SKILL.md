---
name: upload-docx-image
description: Upload and insert an image into a Feishu document at a specific position. Use when the user needs to insert charts, diagrams, or images into a Feishu doc at a precise location (not just appended at the end). Keywords: "上传飞书文档图片", "文档插入图片", "insert image", "docx image", "飞书文档", "inline image", "插入图片".
allowed-tools: [Bash]
---

# 上传飞书文档图片

Insert an image into a Feishu document at a **specific position** via a 3-step Lark API process.

## Single Responsibility

- ✅ Insert an image at a specific block index in a Feishu document
- ✅ Validate inputs (DOC_ID, image path, insertion index)
- ✅ Clean up empty blocks on partial failure
- ❌ DO NOT create or delete documents
- ❌ DO NOT handle document text content
- ❌ DO NOT manage document permissions

## Invocation

This skill is invoked by the agent when the user needs to insert an image into a Feishu document at a specific position. The agent provides the document ID, image file path, and insertion index.

### Usage

```bash
DOC_ID="xxxxxx" \
IMAGE_PATH="./chart.png" \
INSERT_INDEX="3" \
npx tsx skills/upload-docx-image/upload-docx-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOC_ID` | Yes | Feishu document ID (from the document URL) |
| `IMAGE_PATH` | Yes | Local path to the image file (PNG, JPG, JPEG, GIF, WebP, BMP) |
| `INSERT_INDEX` | Yes | Block index where the image should be inserted. Use `-1` to append at the end. |
| `LARK_ACCESS_TOKEN` | No* | Pre-obtained tenant_access_token. If not set, the script reads from `lark-cli`'s credential store. |
| `UPLOAD_SKIP_LARK` | No | Set to `1` to skip actual API calls (testing/dry-run only) |

\* The script prefers `lark-cli`'s built-in authentication. `LARK_ACCESS_TOKEN` is provided as an escape hatch for environments where `lark-cli` config is not directly accessible.

### Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)

## Execution Flow

```
1. Validate DOC_ID, IMAGE_PATH, INSERT_INDEX
2. Check lark-cli availability and authentication
3. Obtain tenant_access_token from lark-cli config
4. Step 1: Create empty image block (block_type: 27) at INSERT_INDEX
5. Step 2: Upload image file via Drive Media API (parent_type: docx_image)
6. Step 3: Bind uploaded image to the empty block (replace_image)
7. On failure in step 2/3: delete the empty block to prevent orphan blocks
8. Report success or failure
```

## When to Use

1. **Generating illustrated documents**: When the agent creates a Feishu document with charts or diagrams that need to appear at specific positions
2. **After creating a document**: After `lark-cli docs +create` creates a document, use this skill to insert images at the right positions
3. **Replacing `+media-insert`**: When you need images at positions other than the end of the document

## Architecture

This skill calls Lark API directly — NOT through `lark-cli api` (which does not support multipart file uploads). Authentication uses `lark-cli`'s stored credentials (app_id + app_secret from `lark-cli config init`).

## Safety Guarantees

- **Input validation**: DOC_ID is validated, image file must exist and be under 20MB, index must be an integer
- **Partial failure cleanup**: If the image upload or binding fails, the empty block is deleted to prevent document corruption
- **Idempotent**: Re-running with the same parameters creates a new block each time (does not update existing blocks)
- **No IPC**: Direct Lark API calls, no worker→primary message passing

## Prerequisites

- `lark-cli` must be installed and authenticated (`lark-cli config init` + `lark-cli auth login`)
- The Feishu app must have `docx:document` and `drive:drive` scopes
- The image file must exist locally and be in a supported format
