---
name: inline-image
description: Insert an image into a Feishu document at a specific position (not just appended at the end). Use when the agent needs to insert images inline in a Feishu doc, generate illustrated reports with proper image placement, or fix image positioning in documents. Keywords: "inline image", "插入图片", "文档图片", "图片插入", "image insertion", "飞书文档图片".
allowed-tools: [Bash]
---

# Inline Image Insertion for Feishu Documents

Insert an image into a Feishu document at a specific position using the Lark API directly.

## Single Responsibility

- ✅ Insert an image at a specific position in a Feishu document
- ✅ Validate document ID, image file, and position
- ✅ Handle the 3-step Lark API process (create block → upload → bind)
- ❌ DO NOT create or delete documents
- ❌ DO NOT modify document text content
- ❌ DO NOT handle image editing/resizing

## Problem

`lark-cli docs +media-insert` only appends images to the end of a document. This skill uses the Lark API directly to insert images at arbitrary positions, enabling properly formatted illustrated documents.

## Invocation

This skill is invoked by the agent when it needs to insert an image into a Feishu document at a specific position.

### Usage

```bash
DOC_ID="your_document_id" \
IMAGE_PATH="/path/to/image.png" \
INSERT_INDEX="3" \
FEISHU_APP_ID="your_app_id" \
FEISHU_APP_SECRET="your_app_secret" \
npx tsx skills/inline-image/inline-image.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DOC_ID` | Yes | Feishu document ID (alphanumeric string from doc URL) |
| `IMAGE_PATH` | Yes | Absolute path to the image file (PNG/JPG/JPEG) |
| `INSERT_INDEX` | Yes | 0-based position to insert at (-1 to append to end) |
| `FEISHU_APP_ID` | Yes | Feishu application ID (from disclaude.config.yaml) |
| `FEISHU_APP_SECRET` | Yes | Feishu application secret (from disclaude.config.yaml) |
| `INLINE_IMAGE_SKIP_API` | No | Set to '1' to skip API calls (dry-run testing) |

### Context Variables

When invoked, you receive:
- **Feishu credentials**: Available from the system config (`FEISHU_APP_ID`, `FEISHU_APP_SECRET`)

## Execution Flow

```
1. Validate inputs (DOC_ID, IMAGE_PATH, INSERT_INDEX, credentials)
2. Check image file exists and size ≤ 20 MB
3. Get tenant_access_token via app credentials
4. Step 1: Create empty image block (block_type: 27) at specified index
5. Step 2: Upload image file via Drive Media Upload API (multipart/form-data)
6. Step 3: Bind uploaded file to image block via replace_image
7. Report block_id and file_token on success
```

## How It Works

### 3-Step Lark API Process

The Lark API requires 3 sequential calls to insert an image at a specific position:

1. **Create Block** — `POST /open-apis/docx/v1/documents/{docId}/blocks/{docId}/children`
   - Creates an empty image block (`block_type: 27`) at the desired index
   - Returns the new block's ID

2. **Upload Image** — `POST /open-apis/drive/v1/medias/upload_all`
   - Uploads the image binary via multipart form-data
   - `parent_type: "docx_image"`, `parent_node: {docId}`
   - Returns a `file_token`

3. **Bind Image** — `PATCH /open-apis/docx/v1/documents/{docId}/blocks/{blockId}`
   - Uses `replace_image` to bind the uploaded file to the empty block

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
  FEISHU_APP_ID="..." FEISHU_APP_SECRET="..." \
  npx tsx skills/inline-image/inline-image.ts

# 4. Repeat for additional images
```

## Architecture

This skill uses **direct Lark API calls** (via node's native `fetch`) instead of `lark-cli` because:
- `lark-cli docs +media-insert` only appends images (no position control)
- `lark-cli api` only supports JSON bodies (not multipart/form-data uploads)
- The 3-step process requires coordination between block creation and file upload

Authentication is handled by obtaining a `tenant_access_token` from the Feishu auth API.

## Safety Guarantees

- **Input validation**: DOC_ID must be alphanumeric, image must be PNG/JPG/JPEG, size ≤ 20 MB
- **Idempotent blocks**: If the script fails at step 2 or 3, the empty block remains (no data corruption)
- **File path resolution**: Resolves to absolute path to prevent directory traversal
- **Dry-run mode**: Set `INLINE_IMAGE_SKIP_API=1` to validate inputs without making API calls
