---
name: "PR 扫描器"
cron: "0 */30 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-03-07T00:00:00.000Z"
---

# PR 扫描任务

每30分钟扫描仓库的 open PR，发现新 PR 时创建群聊通知。

## 执行步骤

### 1. 获取当前 open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open --json number,title,author,createdAt,headRefName,additions,deletions,changedFiles
```

### 2. 加载已处理的 PR 记录

读取 `workspace/data/processed-prs.json` 文件，获取已处理过的 PR 编号列表。

如果文件不存在，创建一个空记录：
```json
{
  "processedPRs": [],
  "lastScanTime": null
}
```

### 3. 识别新 PR

对比当前 open PR 列表与已处理记录，找出未处理的新 PR。

### 4. 为每个新 PR 创建讨论群聊

对于每个新 PR：

1. **创建群聊**：
   使用 `create_group` 工具创建群聊：
   ```json
   {
     "name": "PR #{{number}}: {{title}}",
     "description": "讨论 PR #{{number}}"
   }
   ```

2. **获取 PR 详细信息**：
   ```bash
   gh pr view {{number}} --repo hs3180/disclaude
   ```

3. **发送 PR 信息卡片**：
   使用 `send_message` 工具发送 PR 信息到新创建的群聊：
   ```json
   {
     "chatId": "{{新建群聊的chatId}}",
     "format": "card",
     "content": {
       "config": { "wide_screen_mode": true },
       "header": {
         "title": { "tag": "plain_text", "content": "PR #{{number}}" },
         "template": "blue"
       },
       "elements": [
         {
           "tag": "div",
           "text": { "tag": "lark_md", "content": "**{{title}}**\n\n作者: {{author}}\n创建时间: {{createdAt}}\n变更: +{{additions}} -{{deletions}} ({{changedFiles}} files)" }
         },
         {
           "tag": "action",
           "actions": [
             {
               "tag": "button",
               "text": { "tag": "plain_text", "content": "查看 PR" },
               "type": "primary",
               "url": "https://github.com/hs3180/disclaude/pull/{{number}}"
             }
           ]
         }
       ]
     }
   }
   ```

### 5. 更新已处理 PR 记录

将新处理的 PR 编号添加到 `workspace/data/processed-prs.json`：
```json
{
  "processedPRs": [{{所有已处理的PR编号}}],
  "lastScanTime": "{{当前时间ISO格式}}"
}
```

## 数据文件

`workspace/data/processed-prs.json` 用于跟踪已处理的 PR，避免重复创建群聊。

## 错误处理

1. 如果 `gh pr list` 失败，记录错误并跳过本次执行
2. 如果 `create_group` 失败，记录错误但继续处理其他 PR
3. 如果 `send_message` 失败，记录错误但继续处理其他 PR
4. 如果读取/写入 `processed-prs.json` 失败，创建新文件

## 示例输出

```
🔍 PR 扫描完成
- 发现 5 个 open PR
- 已处理 4 个
- 新 PR: 1 个 (#1025)

✅ 为 PR #1025 创建讨论群聊
- 群聊 ID: oc_xxx
- 已发送 PR 信息卡片
```

## 相关

- Issue #393: 定时扫描 PR 并创建讨论群聊
- Scheduler 模块
