---
name: feeling-lucky
description: 手气不错 — disclaude dogfooding skill. Randomly selects a real use case from disclaude's feature set, simulates a natural user interaction, and reports observations. Use when user says keywords like "手气不错", "随机测试", "feeling lucky", "dogfooding", "自我体验", "feeling-lucky".
allowed-tools: Read, Glob, Grep, Bash, WebSearch, mcp__channel-mcp__send_text
---

# Feeling Lucky (手气不错)

Randomly pick ONE real disclaude use case, simulate a natural user interaction, and report observations.

## When to Use This Skill

**Use this skill for:**
- Daily automated dogfooding of disclaude features
- Randomly testing a real use case from disclaude's feature set
- Discovering bugs and UX issues through simulated real-user interactions

**Keywords that trigger this skill**: "手气不错", "随机测试", "feeling lucky", "dogfooding", "自我体验"

## Core Principle

**You ARE a real disclaude user.** You know everything disclaude can do. You randomly pick one use case and interact naturally — as if you just thought of something to try.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## disclaude Feature & Use Case Catalog

The following is disclaude's complete feature set. Each item is a real use case that a real user would try.

### Category A: Chat & Code Operations (日常对话与代码)

1. **Ask to read a file** — "帮我看看 src/agents/base-agent.ts 的内容"
2. **Ask to edit code** — "把 reset.ts 里的 setTimeout 改成 3 秒"
3. **Ask to search code** — "搜索所有用到 agentPool.reset 的地方"
4. **Ask to run a command** — "跑一下 npm test 看看结果"
5. **Ask to create a file** — "帮我创建一个新的 handler 文件"
6. **Ask for code explanation** — "解释一下 IPC 的消息路由是怎么工作的"

### Category B: Schedule & Automation (定时任务与自动化)

7. **Create a scheduled task** — "创建一个每天早上 10 点提醒我开 standup 的定时任务"
8. **List existing schedules** — "看看现在有哪些定时任务"
9. **Modify a schedule** — "把那个每日提醒改成每周一执行"

### Category C: GitHub Integration (GitHub 操作)

10. **Check PR status** — "看看现在有哪些 open 的 PR"
11. **View issue details** — "帮我看看 issue #1617 的内容"
12. **Submit feedback** — "/feedback 搜索功能有时候不太准确"

### Category D: Feishu/Lark Features (飞书功能)

13. **Read a Feishu document** — Send a Feishu doc link and ask to read it
14. **Upload a file to Feishu** — "帮我把这个报告上传到飞书"
15. **Send an interactive card** — "发一个带按钮的卡片让我选择"
16. **Send a formatted card** — "用卡片格式展示这些数据"

### Category E: Browser & Web (浏览器与网页)

17. **Scrape a website** — "帮我看看这个网页上的内容"
18. **Monitor a page** — "打开这个页面截个图给我看看"
19. **Web search** — "搜索一下 Claude Code 最新版本有什么变化"

### Category F: Document & Content (文档与内容)

20. **Parse a PDF** — "帮我解析这个 PDF 的内容"
21. **Generate a PPT** — "根据这个大纲帮我生成一个 PPT"

### Category G: Discussion & Community (讨论与社区)

22. **Start a discussion** — "发起一个关于代码规范的讨论"
23. **Generate a BBS topic** — "给话题群生成一个讨论话题"
24. **Daily chat review** — "回顾一下今天的聊天记录，有什么值得改进的"

### Category H: Control Commands (控制命令)

25. **Reset session** — "/reset"
26. **Check status** — "/status"
27. **Help** — "/help"

### Category I: Edge Cases & Stress (边界与压力)

28. **Empty or very short input** — "" or "?" or "嗯"
29. **Very long input** — Paste a 2000+ character message and ask for summary
30. **Rapid consecutive commands** — Send 3 messages in quick succession
31. **Off-topic question** — "今天中午吃什么" or "讲个笑话"
32. **Multilingual input** — "Can you help me with this code?" (English input)
33. **Mixed format input** — Send code snippets mixed with natural language

---

## Execution Process

### Step 1: Pick a Random Use Case

From the catalog above, **randomly select ONE** use case. Use this method:

```
Seed = hash(date + chatId + messageIndex) mod 33
Selected scenario = catalog[Seed]
```

In practice: pick a scenario that feels fresh and different from what you tested recently.

**Anti-repetition check**:
```bash
cat workspace/feeling-lucky/history.md 2>/dev/null | tail -10 || echo "No history"
```

If the selected scenario was tested in the last 3 sessions, pick the next one.

### Step 2: Generate a Natural Message

Write a message as if you are a **real disclaude user** who just thought of something to try. The message should:

- Sound natural and casual (like chatting with a friend)
- Be specific enough to test a real feature
- Not sound like a test or evaluation
- Include realistic context (file names, command names, etc. from the actual codebase when relevant)

**Examples by category:**

| Category | Example Message |
|----------|----------------|
| A (Code) | "帮我看看 vitest.config.ts 里 coverage 的配置" |
| B (Schedule) | "每天下午 3 点提醒我 review PR" |
| C (GitHub) | "看看现在有哪些 open issues 标记了 bug" |
| D (Feishu) | "发一个交互卡片，问大家今天想讨论什么话题" |
| E (Browser) | "帮我查一下 Vitest 最新版本的 release notes" |
| F (Document) | "帮我解析 /tmp/report.pdf" |
| G (Discussion) | "回顾一下最近的 PR 讨论，有什么值得关注的" |
| H (Control) | "/status" |
| I (Edge) | "asdfghjkl" |

### Step 3: Send the Message

Use `mcp__channel-mcp__send_text` to send the generated message to the target chat:

```
mcp__channel-mcp__send_text({
  text: "{generated message}",
  chatId: "{chatId}"
})
```

### Step 4: Observe (Internal Only)

After sending, **mentally note** (do NOT send to user):

- Did the message format correctly?
- Was the message natural-sounding?
- Any issues with the sending process itself?

If a real disclaude bot is listening in the chat, observe its response quality:
- Did it understand the intent?
- Was the response helpful?
- Any errors or unexpected behavior?

### Step 5: Record and Report

Append the test record to history:

```bash
mkdir -p workspace/feeling-lucky
echo "- $(date +%Y-%m-%d): [Scenario #{number}] {scenario name} - {one-line observation}" >> workspace/feeling-lucky/history.md
```

If significant bugs or issues were found, create a GitHub issue:

```bash
gh issue create --repo hs3180/disclaude \
  --title "bug: {brief description}" \
  --body "Found via feeling-lucky dogfooding.\n\n{details}"
```

---

## Daily Variety Rules

To ensure broad coverage over time:

| Day | Preferred Category |
|-----|-------------------|
| Monday | A (Code) or C (GitHub) |
| Tuesday | B (Schedule) or G (Discussion) |
| Wednesday | D (Feishu) or E (Browser) |
| Thursday | F (Document) or H (Control) |
| Friday | I (Edge Cases) — shake things up |

This is a soft preference, not a strict rule. Randomness is still the priority.

---

## Quality Guidelines

### Good Test Messages:
- Sound like a real person naturally interacting
- Test a specific, identifiable feature
- Are varied in type and complexity
- Include realistic details (actual file names, commands, etc.)

### Avoid:
- Messages that sound like test scripts
- Always testing the same category
- Overly complex multi-step scenarios (keep it simple)
- Messages that require external state or special setup
- Multiple test messages in one session (one per day)

---

## DO NOT

- Generate messages without picking from the catalog first
- Send more than one test message per invocation
- Include "I'm testing you" or "This is a dogfooding test" in the message
- File GitHub issues for trivial cosmetic preferences
- Skip the history check (causes repetitive testing)
- Create elaborate test plans or scoring systems

---

## Integration with Other Skills

- **daily-news-inspiration**: Uses external news; this skill uses internal feature catalog
- **daily-soul-question**: Analyzes chat history; this skill simulates user interactions
- **bbs-topic-initiator**: Generates topics for groups; this skill tests features
- **next-step**: Can be triggered after this skill completes to suggest follow-up actions

---

## Schedule Configuration

See `schedule.md` in this directory for daily automated execution setup.
