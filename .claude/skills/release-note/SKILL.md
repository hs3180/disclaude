---
name: release-note
description: Write release notes suitable for WeChat Official Account. Use when publishing version updates, announcing new features, or communicating project progress to Chinese audience via WeChat. Generates plain Chinese text without markdown formatting, readable within 5 minutes, with accurate content from commit logs.
argument-hint: [version] [commit-range]
disable-model-invocation: true
allowed-tools: Bash, Read, Grep
context: default
agent: general-purpose
---

# Release Note Writer for WeChat Official Account

A skill for writing WeChat Official Account compatible release notes in plain Chinese.

## Overview

This skill generates release notes specifically designed for WeChat Official Account (微信公众号) publication. It extracts accurate information from Git commit logs and presents it in an engaging, readable format that works well on mobile devices.

**Key Characteristics:**
- Plain Chinese text (no markdown formatting)
- Conversational tone (avoiding bureaucratic language)
- Accurate content from commit history
- Readable within 5 minutes
- Includes project URL for traffic guidance
- Suitable for general audience

## When to Use

Use this skill when:
- Publishing a new version release (0.x.0, 0.x.y, etc.)
- Announcing significant features or improvements
- Communicating project progress to users
- Writing version summaries for WeChat Official Account
- Creating release notes for Chinese audience

## Process

### Step 1: Gather Information

**Check Git History:**
```bash
git log --oneline <commit-range>
git show --stat <latest-commit>
```

**Identify Key Information:**
- Version number (from package.json or git tag)
- Major features and changes
- Bug fixes and improvements
- Breaking changes (if any)
- Migration notes (if applicable)

### Step 2: Analyze Commit Messages

**Read Commit Details:**
```bash
git log <commit-range> --pretty=full
```

**Extract:**
- Feature additions (feat:)
- Bug fixes (fix:)
- Breaking changes (BREAKING CHANGE:)
- Performance improvements (perf:)
- Documentation updates (docs:)
- Refactoring (refactor:)

**Group by Category:**
- New Features
- Improvements
- Bug Fixes
- Internal Changes

### Step 3: Write Release Note

**Structure:**

```
[项目名称] [版本号] 版本来啦！[一句话亮点]

大家好！[项目名称] 迎来了 [版本号] 的更新。
在这个版本中，我们[总结性描述主要改进]。

[主要功能1 - 2-3句话说明]

[主要功能2 - 2-3句话说明]

[如果有3-5个主要功能，继续列举]

[可选：性能优化/稳定性提升等内容]

[技术细节部分 - 给开发者看的，2-3段]

## 怎么用

[简要说明使用方式或注意事项]

---

[项目地址或相关链接]

有问题或建议欢迎反馈！
```

**Writing Guidelines:**

1. **Tone**: Conversational, friendly, not bureaucratic
   - Good: "代码预览更好看了"
   - Bad: "实现了代码可视化功能"

2. **Accuracy**: Base all content on actual commits
   - Only mention features that were actually implemented
   - Verify version numbers from package.json or tags
   - Check commit messages for technical details

3. **Length**: Keep total reading time under 5 minutes
   - Focus on 3-5 major changes
   - Group minor changes together
   - Omit internal refactoring details from user-facing section

4. **Format**: Plain Chinese text only
   - No markdown formatting (no **, ##, etc.)
   - No code blocks in user-facing section
   - Use simple paragraph structure
   - One blank line between sections

5. **Technical Details Section**: Separate section for developers
   - Can mention module names and file changes
   - Include implementation details
   - Add deployment instructions if applicable

### Step 4: Review and Refine

**Check against requirements:**
- [ ] Plain Chinese text (no markdown)
- [ ] Conversational tone (no official language)
- [ ] Accurate content from commits
- [ ] Reading time < 5 minutes
- [ ] Includes project URL
- [ ] Clear version number
- [ ] No typos or grammatical errors

**Example Transformation:**

```
Original (from commit):
feat: Add Write Tool content preview card for Feishu

Implement visual content preview cards when Agent uses Write tool:
- Small files (≤50 lines): Show complete content with line numbers
- Large files (>50 lines): Show truncated preview (first/last 10 lines)

WeChat Release Note:
代码预览更好看了

之前当 AI 帮你写代码的时候，只能看到简单的文本提示。现在不一样了：
小文件会完整显示出来，带上行号和语法高亮。大文件会自动显示开头和结尾各 10 行，既不会刷屏，又能了解大致内容。

系统会自动识别 20 多种编程语言，TypeScript、Python、Go、Rust 等等都能正确高亮显示。
```

## Constraints

1. **No Markdown**: WeChat Official Account editor doesn't support markdown
2. **Mobile First**: Most readers use mobile phones, keep paragraphs short
3. **Be Concise**: Focus on what users care about, skip implementation details in user section
4. **Be Accurate**: Don't invent features, verify everything from commits
5. **Be Friendly**: Use conversational language, avoid technical jargon in user-facing section

## Success Criteria

A successful release note:
- ✅ Contains accurate version number
- ✅ Lists 3-5 major changes with clear descriptions
- ✅ Uses conversational Chinese (no official/bureaucratic language)
- ✅ Readable within 5 minutes
- ✅ Includes project URL or relevant links
- ✅ Has no markdown formatting
- ✅ Separates technical details for developers
- ✅ Based on actual Git commits

## Examples

### Example: Disclaude 0.1.0

```
Disclaude 0.1 版本来啦！更聪明的 AI 机器人体验

大家好！Disclaude 迎来了 0.1 版本的更新。在这个版本中，我们重点优化了代码展示效果，并增加了长时间任务的支持能力。

代码预览更好看了

之前当 AI 帮你写代码的时候，只能看到简单的文本提示。现在不一样了：小文件会完整显示出来，带上行号和语法高亮，一眼就能看清楚。大文件会自动显示开头和结尾各 10 行，既不会刷屏，又能了解大致内容。

而且系统会自动识别 20 多种编程语言，TypeScript、Python、Go、Rust 等等都能正确高亮显示。再也不会看到一堆黑乎乎的代码了。

能处理更复杂的任务了

有时候你给 AI 一个比较复杂的任务，比如"分析这个大型项目的架构"，这种任务可能需要执行很久。新版本增加了长任务支持。AI 会自动把复杂任务拆解成多个小步骤，一步步执行。每完成一步，都会在飞书里实时告诉你进度。

不用担心任务执行时间太长，系统默认支持 24 小时的超时时间，足够处理各种复杂场景了。

稳定性提升

这个版本还优化了后台运行机制。即使任务执行时间很长，系统也能稳定运行，不会出现意外中断。所有的执行过程都有详细的日志记录，方便排查问题。

怎么用

这些功能都是自动的，不需要特殊配置。当你让 AI 写代码时，就会看到漂亮的卡片预览。遇到复杂任务时，AI 会自动启用长任务模式。

如果你已经在用 Disclaude，只需要等待服务更新就会自动获得这些新功能。

---

技术细节（给开发者看的）

版本 0.1.0 主要包含两个核心更新：Write Tool 卡片预览功能和长任务自主执行能力。

Write Tool 卡片预览功能新增了 src/feishu/write-card-builder.ts 模块，智能判断文件大小并生成相应的飞书交互卡片。小文件显示完整内容，大文件显示截断版本，自动检测文件类型并应用语法高亮。

长任务自主执行完善了 src/long-task/ 目录下的任务管理模块，支持 24 小时超时控制，实时进度反馈，结构化的结果持久化。每个子任务在隔离的 Agent 实例中执行，确保上下文清晰。

版本已经推送到 GitHub 仓库，可以通过 npm run pm2:restart 部署更新。

项目地址：github.com:hs3180/disclaude

有问题或建议欢迎反馈！
```

## Notes

- Always verify information from actual Git commits before writing
- Test readability by reading aloud or estimating reading time
- Keep paragraphs short (3-5 sentences max for mobile readers)
- Use transition words to maintain flow (接下来、同时、另外)
- Include deployment instructions only if they're simple and safe
- Add project URL at the end for traffic guidance
