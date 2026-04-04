---
name: "Dogfooding"
cron: "0 0 10 * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Dogfooding Schedule

定期执行 disclaude 自我体验流程：检测版本变化，运行探索场景，生成反馈报告。

## 配置

- **执行频率**: 每天 10:00 UTC
- **状态文件**: `workspace/.dogfooding-state.json`
- **报告目录**: `workspace/reports/`

## 执行步骤

### Step 1: 版本变化检测

```bash
CURRENT_VERSION=$(node -p "require('./package.json').version")
LAST_TESTED=$(cat workspace/.dogfooding-state.json 2>/dev/null | jq -r '.lastTestedVersion // "none"')

if [ "$CURRENT_VERSION" = "$LAST_TESTED" ]; then
  echo "No version change detected ($CURRENT_VERSION). Skipping."
  exit 0
fi

echo "Version change detected: $LAST_TESTED -> $CURRENT_VERSION"
```

**如果没有版本变化**: 直接退出，不执行后续步骤。

**如果有版本变化**: 继续 Step 2。

### Step 2: 执行健康检查

按以下顺序执行系统健康检查：

1. **进程健康**: 检查 PM2 进程状态
2. **配置完整性**: 验证配置文件有效
3. **近期错误**: 分析最近日志中的错误模式
4. **Skill 加载**: 验证所有 skill 可被发现
5. **Schedule 健康**: 验证 schedule 文件有效
6. **GitHub API**: 验证 gh CLI 连接正常
7. **依赖状态**: 检查依赖是否有更新

### Step 3: 执行探索场景

对每个场景，分析代码路径并评估预期行为：

| #   | 场景         | 检查内容                                  |
| --- | ------------ | ----------------------------------------- |
| 1   | 基础对话     | 检查 message-handler 是否正确路由普通消息 |
| 2   | Skill 触发   | 检查 skill finder 是否能发现所有 skill    |
| 3   | 模糊请求     | 检查 agent prompt 是否包含意图澄清指导    |
| 4   | 上下文保持   | 检查 session restore 配置是否正确         |
| 5   | 空输入处理   | 检查空消息是否有防护逻辑                  |
| 6   | 长输入处理   | 检查消息长度限制和截断逻辑                |
| 7   | MCP 工具调用 | 检查 MCP server 配置和工具注册            |
| 8   | 错误恢复     | 检查错误处理中间件是否健壮                |

### Step 4: 生成报告

按 `skills/dogfooding/SKILL.md` 中定义的报告格式生成结构化报告。

### Step 5: 发送报告

使用 `send_user_feedback` 发送报告到配置的 chatId。

### Step 6: 更新状态

```bash
mkdir -p workspace/reports
echo '{"lastTestedVersion": "'"$CURRENT_VERSION"'", "lastTestedAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'" }' > workspace/.dogfooding-state.json
```

## 错误处理

| 场景                | 处理方式                            |
| ------------------- | ----------------------------------- |
| package.json 不存在 | 报告错误，退出                      |
| 状态文件损坏        | 重置为 "none"，继续执行             |
| gh CLI 不可用       | 跳过 GitHub 相关检查，标记为 ⏭️     |
| PM2 不可用          | 跳过进程检查，标记为 ⏭️             |
| 报告发送失败        | 保存到本地文件 `workspace/reports/` |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用（版本比较保证）
2. **轻量级**: Dry-run 模式不发送实际消息，不影响生产环境
3. **状态管理**: 通过 JSON 文件管理状态，不依赖内存
4. **渐进增强**: 当前为 Phase 1 (dry-run)，未来可扩展为 live 模式
