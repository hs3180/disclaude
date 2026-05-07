---
name: feishu-doc-reader
description: Feishu document reader - guides Agent to read Feishu Wiki/Document links using lark-cli instead of webReader. Use when user shares Feishu document URLs (feishu.cn/wiki/* or feishu.cn/docx/*). Keywords: "飞书文档", "飞书链接", "Feishu doc", "wiki link", "docx link".
allowed-tools: Bash
---

# Feishu Document Reader

当用户消息包含飞书文档或 Wiki 链接时，使用 `lark-cli docs +fetch` 读取内容。

**适用于**: 读取飞书文档/Wiki 内容 ｜ **不适用于**: 读取非飞书网页（用 webReader）

## 核心规则

**禁止使用 webReader 读取飞书文档页面** — 飞书文档需要认证登录，webReader 只能获取到登录页面。必须使用 `lark-cli docs +fetch`。

## 识别飞书文档链接

以下 URL 模式为飞书文档：

- `https://*.feishu.cn/wiki/*` — Wiki 页面
- `https://*.feishu.cn/docx/*` — 文档页面
- `https://*.feishu.cn/sheets/*` — 表格页面（如需读取，也用 lark-cli）

## 推荐读取流程（两步法）

对于较长的文档，推荐先看大纲再读取相关章节，避免一次性读取过多内容。

### 第一步：获取文档大纲

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope outline --max-depth 3
```

### 第二步：读取目标章节

根据大纲中的 heading ID，读取感兴趣的章节：

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope section --start-block-id <heading_id> --doc-format markdown
```

## 快速读取（短文档）

如果文档较短或需要全文，直接一次性读取：

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --doc-format markdown
```

## 按关键词搜索

在文档中搜索特定关键词：

```bash
lark-cli docs +fetch --api-version v2 --doc "<URL>" --scope keyword --keyword "关键词" --doc-format markdown
```

## 参数说明

| 参数 | 说明 |
|------|------|
| `--doc` | 飞书文档的完整 URL 或文档 token |
| `--doc-format` | 输出格式：`markdown`（推荐）、`text`、`xml` |
| `--scope` | 读取模式：`outline`、`section`、`keyword`、不填则全文 |
| `--max-depth` | 大纲层级深度（仅 outline 模式） |
| `--start-block-id` | 起始 block ID（仅 section 模式，从大纲获取） |
| `--keyword` | 搜索关键词（仅 keyword 模式） |

## 典型场景

### 用户分享了一个飞书 Wiki 链接

1. 识别链接为飞书文档
2. 用两步法读取：先 outline → 再 section
3. 根据文档内容回答用户问题

### 用户提问涉及飞书文档内容

1. 如果用户提供了飞书链接，先用 lark-cli 读取
2. 如果用户没有提供链接但提到飞书文档，询问链接
3. 读取后基于文档内容作答

## 注意事项

- `--doc` 参数同时支持完整 URL 和文档 token
- 飞书文档可能较长，优先使用两步法避免 context 浪费
- Wiki 链接（`/wiki/`）和文档链接（`/docx/`）均支持
- 读取失败时检查链接是否有效、是否有访问权限

## DO NOT

- 不要使用 webReader 或 mcp__web_reader__webReader 读取飞书文档
- 不要要求用户手动复制粘贴文档内容
- 不要一次性读取超长文档的全文（先用 outline 评估）

## 关联

- Issue: #3035
- 参考: lark-cli lark-doc skill
