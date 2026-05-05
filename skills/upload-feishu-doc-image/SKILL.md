---
name: upload-feishu-doc-image
description: Upload and insert an image into a Feishu document at a specific position. Use when the agent needs to embed charts, screenshots, or any image into a Feishu doc at a precise location (not just appended at the end). Keywords: "上传飞书文档图片", "insert image feishu", "飞书图片", "文档图片插入", "inline image".
allowed-tools: [Bash]
---

# Upload Feishu Document Image

Upload and insert an image into a Feishu document at a specific position using lark-cli.

## Single Responsibility

- ✅ Insert an image into a Feishu document at a specific index position
- ✅ Validate document ID, image file, and insert position
- ✅ Handle partial failure with cleanup
- ❌ DO NOT create or manage documents
- ❌ DO NOT generate or process images
- ❌ DO NOT read FEISHU_APP_ID / FEISHU_APP_SECRET directly

## Invocation

This skill is invoked by the agent when it needs to insert an image into a Feishu document at a specific position (not just at the end).

### Usage

```bash
# Insert image at a specific position (0-indexed)
FEISHU_DOC_ID="doxcnAbCdEf123" \
FEISHU_IMAGE_PATH="/path/to/chart.png" \
FEISHU_IMAGE_INDEX="3" \
npx tsx skills/upload-feishu-doc-image/upload-feishu-doc-image.ts

# Append image to the end of the document
FEISHU_DOC_ID="doxcnAbCdEf123" \
FEISHU_IMAGE_PATH="/path/to/chart.png" \
FEISHU_IMAGE_INDEX="-1" \
npx tsx skills/upload-feishu-doc-image/upload-feishu-doc-image.ts
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEISHU_DOC_ID` | Yes | — | Feishu document ID |
| `FEISHU_IMAGE_PATH` | Yes | — | Absolute or relative path to the image file |
| `FEISHU_IMAGE_INDEX` | No | `-1` | Insert position: -1 = append to end, 0+ = specific block index |
| `FEISHU_SKIP_LARK` | No | — | Set to `'1'` for dry-run mode (testing only) |

### Context Variables

When invoked, you receive:
- **Document ID**: The Feishu document ID (from the document being edited)
- **Image path**: Path to the locally generated image file
- **Insert position**: The block index where the image should appear

## Execution Flow

```
### Case 1: Append (index = -1)
1. Validate FEISHU_DOC_ID, FEISHU_IMAGE_PATH, FEISHU_IMAGE_INDEX
2. Validate image file (exists, size < 20MB, supported format)
3. Check lark-cli availability and authentication
4. Call lark-cli docs +media-insert (handles upload + insert at end)
5. Report success

### Case 2: Insert at position (index >= 0)
1. Validate inputs and image file
2. Check lark-cli availability and authentication
3. GET document children count (N)
4. lark-cli docs +media-insert → upload & insert at end (index N)
5. Extract file_token from the inserted block
6. DELETE the temporary block from end (index N)
7. POST create empty image block at desired position (index)
8. PATCH bind file_token to the new block via replace_image
9. Report success
```

## Supported Image Formats

| Format | Extension |
|--------|-----------|
| PNG | `.png` |
| JPEG | `.jpg`, `.jpeg` |
| GIF | `.gif` |
| BMP | `.bmp` |
| WebP | `.webp` |

**Max file size**: 20 MB

## When to Use

1. **Generating reports with charts**: After generating a chart image locally, insert it into the Feishu document at the correct position alongside text.
2. **Screenshot documentation**: Insert screenshots into specific sections of a document.
3. **Data visualization**: Embed charts or graphs into data analysis reports.

## Architecture

### Authentication

This skill uses **lark-cli** for all API operations — authentication is handled automatically by lark-cli. No direct handling of FEISHU_APP_ID / FEISHU_APP_SECRET.

### API Operations

| Operation | lark-cli Command | Purpose |
|-----------|------------------|---------|
| Upload image | `lark-cli docs +media-insert` | Upload file & insert at end |
| List blocks | `lark-cli api GET .../children` | Get children count |
| Create block | `lark-cli api POST .../children` | Create empty image block |
| Bind image | `lark-cli api PATCH .../blocks/{id}` | Bind file_token via replace_image |
| Delete block | `lark-cli api DELETE .../batch_delete` | Remove temporary block |

### Key Technical Details

- **block_type: 27** — The correct Feishu image block type (NOT 4, which is Heading2)
- **Three-step bind**: Create empty block → upload file → replace_image binds them
- **file_token persistence**: Drive file tokens survive block deletion; safe to rearrange

## Error Handling & Cleanup

| Scenario | Behavior |
|----------|----------|
| Invalid DOC_ID | Exit with validation error (no API call) |
| Image file missing/empty/too large | Exit with validation error (no API call) |
| lark-cli not installed | Exit with installation instructions |
| lark-cli not authenticated | Exit with auth instructions |
| Upload succeeds, block creation fails | Log warning, report error (file remains in Drive) |
| Block created, bind fails | Delete empty block via batch_delete, report error |
| Delete temporary block fails | Log warning (non-fatal, may leave duplicate at end) |

## Prerequisites

1. **lark-cli** installed: `npm install -g @larksuite/cli`
2. **lark-cli** authenticated: `lark-cli auth login --recommend`
3. **lark-cli** has docs scope: Required for `+media-insert` and docx API calls
4. Image file exists locally and is in a supported format
