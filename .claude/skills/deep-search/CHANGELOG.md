# Deep Search Upgrade

## 概述

将 `internet-research` 升级为 `deep-search`，实现更系统、更深入的网络研究能力。

## 主要改进

### 1. 重命名
- ❌ ~~`internet-research`~~
- ✅ `deep-search`

更准确地反映这是一个深度研究能力，而非简单的网络搜索。

### 2. 流程优化

**原流程 (3步):**
1. 创建研究大纲
2. 浏览和收集信息
3. 汇总研究报告

**新流程 (4阶段):**

#### 阶段 1: 构建研究大纲 & 生成关键词组
- 将研究问题分解为 4-6 个维度
- 为每个维度生成 3-5 组精准搜索关键词
- 使用专业术语、行业黑话、多种表达方式
- 结合 AND/OR 运算符优化查询

**示例:**
```
维度: 临床应用
- "AI medical diagnosis accuracy 2024"
- "machine learning clinical decision support systems"
- "artificial intelligence radiology FDA approval 2024"
```

#### 阶段 2: Google 搜索 & 发现垂直领域站点
- **优先使用 Google 搜索**
- 使用高级搜索运算符 (site:, filetype:, intitle: 等)
- 执行关键词组搜索
- 识别和评估垂直领域候选站点:
  - 权威域名 (.edu, .gov, 知名行业站点)
  - 专业平台 (领域社区、论坛、数据库)
  - 专业出版物 (行业期刊、研究门户)
  - 公司资源 (官方文档、博客、白皮书)
- 筛选 5-10 个高价值垂直领域站点

#### 阶段 3: 深入垂直领域站点搜集信息
- 逐个访问选定的垂直领域站点
- 探索站点结构 (导航、内容分区、搜索功能)
- 提取核心信息:
  - 阅读关键文章、文档和资源
  - 截图保存重要页面
  - 提取具体数据点、统计、引言
  - 记录发布日期和作者资质
- 跟踪内部链接:
  - 探索推荐文章和参考资料
  - 跟踪引用链接到原始来源
  - 调查相关主题和子主题
- 域内交叉验证: 对比同一主题的多篇文章

#### 阶段 4: 汇总信息完成研究
生成结构化报告，包含:
- 执行摘要
- 研究维度回顾
- 分析的垂直领域站点列表
- 按维度分类的关键发现
- 跨域分析 (共识、分歧、趋势、知识缺口)
- 数据与统计
- 推荐资源
- 完整来源列表
- 研究局限性
- 进一步研究建议

### 3. Google 搜索优先

**原方案:** 没有指定搜索引擎，随意使用

**新方案:**
- ✅ **强制优先使用 Google**
- Google 高级搜索运算符:
  - 精确匹配: `"machine learning interpretability"`
  - 组合查询: `AI AND healthcare AND ethics`
  - 排除术语: `cloud computing -AWS -Microsoft`
  - 站点搜索: `site:arxiv.org "transformer architecture"`
  - 时间范围: `AI regulation 2024..2025`
  - 文件类型: `market analysis filetype:pdf`
  - 标题搜索: `intitle:"systematic review" LLM`
- 利用 Google 专业化搜索 (News, Scholar, Images)

### 4. 垂直领域站点策略

**新增核心概念:**

什么是垂直领域站点?
- 深度专注于特定领域或行业的网站
- 提供权威、专业、全面的内容
- 示例: Stack Overflow (编程)、PubMed (医学)、SSRN (社会科学)

垂直领域站点评估标准:
- **权威性**: .edu, .gov, established industry
- **专业性**: 内容由领域专家、从业者创建
- **深度**: 全面覆盖 vs 浅层提及
- **时效性**: 最近更新，反映当前状态
- **客观性**: 平衡视角，最小化偏见
- **社区**: 活跃参与，被他人引用

**原方案:** 没有明确的垂直领域站点概念，随意浏览

**新方案:**
- ✅ 系统性识别垂直领域站点
- ✅ 深入探索每个选定的站点
- ✅ 从多个垂直领域交叉验证信息
- ✅ 建立权威来源列表

### 5. 关键词生成策略

**原方案:** 简单的主题拆解

**新方案:** 战略性关键词组生成
- 每个维度 3-5 组关键词
- 使用具体、精准的短语（非通用术语）
- 包含技术术语、行业黑话、变体表达
- 考虑不同视角（专家、初学者、批判、比较）

**示例架构:**
```
研究主题: AI in healthcare 2024

维度 1: 临床应用
  - 关键词组 1: "AI medical diagnosis accuracy 2024"
  - 关键词组 2: "machine learning clinical decision support systems"
  - 关键词组 3: "artificial intelligence radiology FDA approval 2024"

维度 2: 市场分析
  - 关键词组 1: "healthcare AI market size 2024 report"
  - 关键词组 2: "medical AI investment trends 2024"
  - 关键词组 3: "top AI healthcare companies valuation 2024"

维度 3: 监管与伦理
  - 关键词组 1: "FDA AI medical device regulation 2024"
  - 关键词组 2: "AI healthcare ethics guidelines WHO"
  - 关键词组 3: "HIPAA compliance artificial intelligence 2024"

维度 4: 技术挑战
  - 关键词组 1: "AI model bias healthcare datasets"
  - 关键词组 2: "medical AI interpretability explainable AI"
  - 关键词组 3: "clinical AI integration challenges EHR"

维度 5: 案例研究
  - 关键词组 1: "IBM Watson Health case study outcomes"
  - 关键词组 2: "Google DeepMind healthcare implementation"
  - 关键词组 3: "AI radiology success rates hospital"
```

### 6. 报告结构增强

**原报告结构:**
```
# Research Report: [Topic]
## Executive Summary
## Key Findings
## Detailed Analysis
## Sources
```

**新报告结构:**
```
# Deep Research Report: [Topic]
## Executive Summary
## Research Dimensions
## Vertical Domains Analyzed
## Key Findings by Dimension
### [Dimension 1]
**Primary Insight:**
- Supporting details with data
- Cross-validated sources
- Contrasting perspectives
## Cross-Domain Analysis
- Consensus Areas
- Diverging Viewpoints
- Emerging Trends
- Knowledge Gaps
## Data & Statistics
[Table format]
## Recommended Resources
[Top 3-5 most valuable]
## Sources
[Comprehensive list]
## Research Limitations
[Acknowledge constraints]
## Next Steps / Further Research
[Suggest specific areas]
```

### 7. 质量标准提升

**原成功标准:**
- ✅ 调查 3-5 个主题领域
- ✅ 3+ 来源验证事实
- ✅ 结构化报告格式
- ✅ 来源引用
- ✅ 承认局限性

**新成功标准:**
- ✅ 展示研究大纲和关键词组
- ✅ 每组关键词通过 Google 搜索并分析结果
- ✅ 识别并评估 5-10 个高价值垂直领域站点
- ✅ 深入探索每个垂直领域并提取全面信息
- ✅ 综合到包含所有部分的结构化报告中
- ✅ 跨域分析识别共识、分歧和趋势
- ✅ 承认局限性并建议进一步研究

## 技术细节

### 允许的工具

**保持不变:**
- ✅ 所有 Playwright 浏览器工具
- ✅ WebSearch 工具

**限制:**
- ❌ 本地文件操作 (Read, Write, Edit)
- ❌ Bash 命令执行
- ❌ Grep, Glob 等搜索工具
- ❌ 其他 MCP 工具

### 模型调用

**保持不变:**
```yaml
disable-model-invocation: true
```

确保 skill 不会触发额外的模型调用。

## 使用示例

### 激活方式

```bash
# Feishu/Lark
/deep search

# 触发方式
"deep search AI in healthcare 2024"
"conduct deep research on quantum computing applications"
"comprehensive investigation of remote work trends"
"thoroughly research renewable energy storage technologies"
```

### 执行流程示例

**用户:** "deep search AI in healthcare 2024"

**Stage 1 - 研究大纲:**
```
我将深入研究 "AI in healthcare 2024"。

研究维度:
1. 临床应用与诊断
2. 市场规模与投资趋势
3. 监管政策与伦理规范
4. 技术挑战与限制
5. 主要厂商与产品
6. 未来展望与风险

关键词组 (维度 1 - 临床应用):
- "AI medical diagnosis accuracy 2024"
- "machine learning clinical decision support systems"
- "artificial intelligence radiology FDA approval 2024"
...
```

**Stage 2 - Google 搜索与垂直领域发现:**
```
正在执行 Google 搜索...
✅ "AI medical diagnosis accuracy 2024" → 发现 12 个潜在垂直站点
✅ "machine learning clinical decision support..." → 发现 8 个潜在垂直站点
...

识别的高价值垂直领域:
1. PubMed (pubmed.ncbi.nlm.nih.gov) - 医学文献数据库
2. FDA.gov - 官方监管文件
3. Nature Medicine AI - 顶级期刊
4. HIMSS.org - 医疗信息系统专业组织
5. Rock Health (rockhealth.com) - 数字健康投资研究
6. Journal of Medical AI - 专业学术期刊
7. McKinsey Healthcare Insights - 行业分析
8. Google Health Blog - 技术公司视角
...
```

**Stage 3 - 深入搜集:**
```
正在深入垂直领域站点...

[1/10] PubMed:
  ✅ 阅读 23 篇相关文献
  ✅ 提取关键数据: 诊断准确率提升 15-30%
  ✅ 识别 5 个主要研究方向
  ✅ 截图保存重要页面

[2/10] FDA.gov:
  ✅ 查阅 8 个 AI 医疗设备批准文件
  ✅ 提取监管要求清单
  ✅ 记录审批时间线
...

进度更新: 已完成 6/10 个垂直领域站点...
```

**Stage 4 - 综合报告:**
```
# Deep Research Report: AI in Healthcare 2024

## Executive Summary
2024年AI在医疗健康领域进入规模化应用阶段...
(详细报告...)
```

## 总结

### 核心改进

1. ✅ **更系统的方法论** - 4阶段流程，从关键词到垂直领域到深度搜集
2. ✅ **Google 搜索优先** - 利用高级运算符和专业化搜索
3. ✅ **垂直领域聚焦** - 深入探索权威专业站点，而非浅层浏览
4. ✅ **战略性关键词生成** - 多维度、多组别、精准化的关键词策略
5. ✅ **更全面的报告** - 跨域分析、数据表格、推荐资源
6. ✅ **更高的质量标准** - 5-10个垂直站点、交叉验证、知识缺口识别

### 适用场景

**原 internet-research 适合:**
- 快速查找事实
- 简单主题调研
- 来源验证

**新 deep-search 适合:**
- 复杂主题的全面研究
- 需要多角度分析的课题
- 学术或专业级别的调研
- 需要深入理解行业动态
- 战略决策支持

### 升级价值

| 维度 | internet-research | deep-search |
|------|------------------|-------------|
| **深度** | ⭐⭐ 浅层浏览 | ⭐⭐⭐⭐⭐ 深度垂直挖掘 |
| **广度** | ⭐⭐⭐ 3-5个主题 | ⭐⭐⭐⭐⭐ 多维度交叉分析 |
| **系统性** | ⭐⭐ 3步流程 | ⭐⭐⭐⭐⭐ 4阶段方法论 |
| **权威性** | ⭐⭐⭐ 基础验证 | ⭐⭐⭐⭐⭐ 垂直领域专家 |
| **可重复性** | ⭐⭐⭐ 较好 | ⭐⭐⭐⭐⭐ 高度结构化 |
| **适用场景** | 快速调研 | 深度研究 |

## 向后兼容

❌ **不向后兼容** - 这是一个全新的 skill，完全替代 internet-research

如需恢复 internet-research:
```bash
git checkout .claude/skills/internet-research/SKILL.md
```

## 文件变更

### 新增
- `.claude/skills/deep-search/SKILL.md` - 完整的 deep-search skill 定义

### 删除
- `.claude/skills/internet-research/SKILL.md` - 旧的 research skill

### 修改
- `README.md` - 更新文档引用
  - Line 16: `internet-research` → `deep-search`
  - Line 75-79: 更新 skill 描述
  - Line 438: 更新成就列表

---

升级完成日期: 2025-01-27
版本: 1.0.0

---

## v1.2.0 - 完全自主执行 (2025-01-27)

### 关键修复

**问题:** Skill 在两个阶段等待用户确认，导致在 bot 环境（Feishu/Lark）中无法完整执行。

**修复内容:**
1. **Stage 1 后** - 移除等待确认指令
   - 之前: `Present the outline and keyword groups to the user and wait for confirmation before proceeding.`
   - 现在: `Proceed immediately to Stage 2 without waiting for user confirmation.`

2. **Stage 2 后** - 移除等待确认指令
   - 之前: `Present discovered vertical domains with brief descriptions to the user and wait for confirmation before proceeding to deep exploration.`
   - 现在: `Proceed immediately to Stage 3 without waiting for user confirmation.`

3. **USAGE.md 更新**
   - 删除 "你需要：审阅大纲，确认研究方向正确"
   - 删除 "你需要：了解将要深入哪些站点"
   - 更改为 "自动继续执行搜索，无需等待确认"
   - 更改为 "自动继续深度搜集，无需等待确认"

### 影响范围

**现在 Skill 可以:**
- ✅ 在 Feishu/Lark bot 中完全自主运行
- ✅ 在 CLI 模式下一口气完成
- ✅ 在 API 调用中无需人工干预
- ✅ 在自动化工作流中无缝集成

**执行特性:**
- 从开始到结束零用户交互
- 保留所有进度更新输出
- 最终生成完整研究报告
- 适合无人值守场景

### 向后兼容性

✅ **完全向后兼容** - 移除等待点不会破坏现有功能，反而使 skill 更通用

### 文件变更

**修改:**
- `.claude/skills/deep-search/SKILL.md` - 移除 2 处等待确认指令
- `.claude/skills/deep-search/USAGE.md` - 更新用户交互说明
- `.claude/skills/deep-search/IMPROVEMENTS.md` - 记录 v1.2.0 改进

**版本升级:** 1.1.0 → 1.2.0

---

## v1.3.0 - 多搜索引擎支持与工具限制 (2025-01-27)

### 关键改进

**改进 1: 多搜索引擎备选策略**
- **优先级顺序**: Google (首选) → Bing (备选 #1) → DuckDuckGo (备选 #2)
- **自动切换**: 当 Google 不可用时（reCAPTCHA、限流、地理封锁），自动切换到 Bing
- **最终备选**: 如果 Bing 也失败，使用 DuckDuckGo 作为最后选择
- **文档记录**: 记录使用了哪个搜索引擎以及失败原因

**优势:**
- ✅ 提高研究可靠性，避免因单一搜索引擎不可访问而导致研究失败
- ✅ 适应不同地区和网络环境的限制
- ✅ DuckDuckGo 提供无过滤的搜索结果作为补充

**改进 2: 禁用 WebSearch 和 Write 工具**

**工具变更:**
```yaml
# 之前 (v1.2.0)
allowed-tools: Write, mcp__playwright__browser_*

# 现在 (v1.3.0)
allowed-tools: mcp__playwright__browser_*
```

**具体限制:**
- ❌ 不能使用 Write 工具保存文件
- ❌ 不能使用 WebSearch API
- ✅ 只能使用 Playwright 浏览器工具进行搜索
- ✅ 所有研究发现直接在对话中呈现

**原因:**
- 专注于浏览器自动化研究方法
- 避免依赖外部搜索 API
- 简化输出，结果直接呈现给用户

### 影响范围

**搜索策略变化:**
- **Stage 2 重构**: 从 "Google Search" 改为 "Multi-Engine Search"
- **新搜索流程**: Google → Bing → DuckDuckGo 自动回退
- **失败处理**: 每个搜索引擎失败时自动尝试下一个

**报告输出变化:**
- **之前**: 可以选择保存到文件或在对话中呈现
- **现在**: 只能在对话中呈现（无文件保存能力）
- **优势**: 简化流程，用户立即看到结果

**适用场景:**
- ✅ 更适合 bot 环境（Feishu/Lark），无需文件系统访问
- ✅ 更适合只读环境，避免权限问题
- ✅ 更可靠的多搜索引擎策略

### 文件变更

**修改:**
- `.claude/skills/deep-search/SKILL.md`
  - 更新版本号: 1.2.0 → 1.3.0
  - 更新 `allowed-tools`: 移除 `Write`，只保留 `mcp__playwright__browser_*`
  - 重写 Stage 2: 添加多搜索引擎备选策略
  - 更新 Stage 4: 移除文件保存选项
  - 更新 Troubleshooting: 调整搜索引擎不可访问的解决方案
  - 更新 Success Criteria: 反映多搜索引擎策略

### 向后兼容性

⚠️ **破坏性变更**:
- 移除了文件保存能力
- 所有研究报告现在只能在对话中呈现
- 如果之前依赖文件保存，需要手动复制对话内容

**建议:**
- 用户可以直接从对话中复制研究报告
- 或使用其他工具保存对话内容

### 验证

- ✅ 版本号更新为 1.3.0
- ✅ `allowed-tools` 只包含 Playwright 浏览器工具
- ✅ Stage 2 包含完整的多搜索引擎备选策略
- ✅ Stage 4 移除了文件保存选项
- ✅ Troubleshooting 更新了搜索引擎失败处理
- ✅ 构建成功 (`npm run build`)

---

## v1.4.0 - 强制进度同步与完整性检查 (2025-01-27)

### 关键改进

**问题发现 (基于实际执行分析):**
- ❌ Stage 2 仅执行 1/30 次搜索 (3.3% 完成度)
- ❌ Stage 3 完全跳过 (0% 完成度)
- ❌ 没有进度更新，用户不知道系统在做什么
- ⚠️ 一次性超长报告输出 (用户体验差)

**修复 1: 强制进度同步 (MANDATORY Progress Updates)**

**Stage 2 搜索进度:**
```markdown
After EACH search, MUST output:
[搜索进度] 维度 X/Y - 关键词组 Z/Total
🔍 搜索引擎: [Google/Bing/DuckDuckGo]
📝 关键词: "[keyword]"
📊 结果数: [X]
✅ 已发现域名: [domain list]
```

**Stage 2 维度完成:**
```markdown
After each dimension, MUST output:
[维度完成] 维度名称
✅ 已完成搜索: N/N 关键词组
📚 发现候选垂直领域: X 个
🎯 优先推荐: [top 3 domains]
⏭️ 继续下一维度...
```

**Stage 2 阶段完成:**
```markdown
After ALL dimensions, MUST output:
[阶段完成] Stage 2: 多引擎搜索与垂直领域发现
✅ 总搜索次数: N/Total (100%)
🎯 选定深入探索: Y 个高价值域名
⏭️ 即将进入 Stage 3: 深度搜集 (预计 20-30 分钟)
```

**Stage 3 深度搜集:**
```markdown
Before each domain:
[深度搜集] 域名 X/Total
📍 目标: [Domain] - [purpose]

After each domain:
[搜集完成] [Domain]
✅ 提取关键信息: 论文 X 篇, 数据 X 个...
📊 总体进度: X/Total (Z%)

Every 3 domains:
[阶段性汇总] 已完成 X/Total 域名
📚 累计: 论文 X 篇, 数据 X 个...
```

**Stage 3 阶段完成:**
```markdown
After ALL domains:
[阶段完成] Stage 3: 深度垂直领域搜集
✅ 已访问域名: X/Total (100%)
📚 累计收集: 论文 N 篇, 数据 N 个...
⏭️ 即将进入 Stage 4: 综合报告生成
```

**修复 2: 两步报告输出策略**

**Step 1: Executive Summary (REQUIRED FIRST)**
```markdown
# 深度研究完成 ✅

## 研究概况
- 📊 研究维度: N 个
- 🔍 执行搜索: N 次
- 📚 访问域名: N 个
- ⏱️ 研究用时: 约 X 分钟

## 核心发现 (Top 8-10)
1. [关键发现] - [一句话]
...

## 报告目录
[完整目录]

**回复选项:**
- "完整报告" - 查看全部
- "2", "3" 等 - 查看特定章节
- "HTN规划" 等 - 查看特定主题
```

**Step 2: Full Report (ON REQUEST ONLY)**
- 只在用户请求后提供完整报告
- 或根据用户请求提供特定章节

**修复 3: 强制完整性检查**

新增 `Success Criteria` 检查清单:
```markdown
### Stage 1: Research Outline ✅
- [ ] 4-6 研究维度
- [ ] 20-30 关键词组
- [ ] 关键词具体明确

### Stage 2: Multi-Engine Search ✅
- [ ] 全部 20-30 次搜索完成
- [ ] 每次搜索后输出进度
- [ ] 每个维度后输出汇总
- [ ] Stage 完成通知

### Stage 3: Deep Dive ✅
- [ ] 访问 5-10 个域名
- [ ] 每个域名前/后更新
- [ ] 每 3 个域名阶段性汇总
- [ ] Stage 完成通知

### Stage 4: Report Synthesis ✅
- [ ] 先输出执行摘要
- [ ] 用户请求后才输出完整报告
```

**完成要求:**
- ❌ 如果跳过任何 Stage 2 搜索 = 未完成
- ❌ 如果跳过任何 Stage 3 域名 = 未完成
- ❌ 如果缺少进度更新 = 未完成
- ✅ 所有检查点验证通过 = 完成

### 影响范围

**用户体验改进:**
1. **透明度提升** - 用户实时看到进度
2. **可预测性增强** - 明确的阶段和进度百分比
3. **可控性增加** - 用户可以选择需要的报告内容
4. **完整性保证** - 强制检查确保不跳过步骤

**执行保证:**
- Stage 2 必须完成 20-30 次搜索（不再是 1 次）
- Stage 3 必须访问 5-10 个域名（不再跳过）
- 每个步骤都有明确的进度通知

### 文件变更

**修改:**
- `.claude/skills/deep-search/SKILL.md`
  - 版本号: 1.3.0 → 1.4.0
  - 添加 MANDATORY 进度同步要求到 Stage 2
  - 添加 MANDATORY 进度同步要求到 Stage 3
  - 更新 Stage 4 为两步输出策略
  - 重写 Success Criteria 为检查清单格式
  - 添加完成要求和验证标准

### 向后兼容性

✅ **完全向后兼容** - 只是加强执行要求，不改变接口

### 验证

- ✅ 版本号更新为 1.4.0
- ✅ 所有 MANDATORY 要求已添加
- ✅ 两步输出策略已定义
- ✅ 检查清单格式已实施
- ✅ 构建成功 (`npm run build`)
