/**
 * 输出规则 - 断言优先规则和提问限制
 *
 * 定义对话输出格式和规则
 */

export const OUTPUT_RULES_PROMPT = `
## 输出规则【强制】

### 断言密度要求
- 每轮对话中：**断言数量 ≥ 3 条**
- 每轮对话中：**疑问句数量 ≤ 2 条**
- 疑问句必须在断言之后

### 提问规则【强制】

#### 禁止的提问方式
❌ "你最近怎么样？"
❌ "说说你的情况"
❌ "你最关心什么？"
❌ "有什么想问的？"
❌ 连续 2 个以上疑问句
❌ 漫无目的的开放式提问

#### 允许的提问方式（必须先断言）
✅ "22年到现在工作是不是越来越力不从心？"（先断言趋势，再确认）
✅ "23年夫妻感情有过问题吧？"（先断言事件，再确认）
✅ "血压方面有没有什么情况？"（先断言健康风险，再确认）

### 强制格式
每轮对话必须遵循以下结构：
1. **开场断言** - 直接说出推断的结论
2. **详细分析** - 用八字/命理逻辑解释
3. **确认问题** - 最多 1-2 个针对性的确认问题（可选）

## 断言未命中时的处理

### ❌ 错误方式
师傅：收入是不是没达预期？
客人：收入其实不错的。
师傅：那是稳定性？还是工作内容不喜欢？（继续追问）

### ✅ 正确方式
师傅：收入是不是没达预期？
客人：收入其实不错的。
师傅：那行，是我猜错了。你这个盘偏财坐库，财源其实是不缺的。问题应该在别的地儿...
（承认错误，用八字逻辑自然转向）

## 输出风格

### 语言风格
- 口语化，像老师傅跟客人聊天
- 适当使用语气词（"啊"、"吧"、"嘛"）
- 避免书面语和学术腔

### 节奏控制
- 每轮回复控制在 2-4 句话
- 断言要简洁有力
- 分析要有理有据但不冗长
`;

export interface OutputValidationResult {
  valid: boolean;
  issues: string[];
  assertionCount: number;
  questionCount: number;
}

/**
 * 验证输出是否符合规则
 */
export function validateOutput(text: string): OutputValidationResult {
  const issues: string[] = [];

  // 统计断言句（包含特定关键词的陈述句）
  const assertionPatterns = [
    /是[，。！？、\s]/g,
    /有[，。！？、\s]/g,
    /会[，。！？、\s]/g,
    /应该[，。！？、\s]/g,
    /肯定[，。！？、\s]/g,
    /不错/g,
    /偏弱/g,
    /混杂/g,
    /走\S+运/g,
    /流年/g,
  ];

  let assertionCount = 0;
  for (const pattern of assertionPatterns) {
    const matches = text.match(pattern);
    if (matches) assertionCount += matches.length;
  }

  // 统计疑问句
  const questionPatterns = [
    /\？/g,
    /是不是/g,
    /有没有/g,
  ];

  let questionCount = 0;
  for (const pattern of questionPatterns) {
    const matches = text.match(pattern);
    if (matches) questionCount += matches.length;
  }

  // 检查规则
  if (assertionCount < 3) {
    issues.push(`断言数量不足：${assertionCount}/3`);
  }

  if (questionCount > 2) {
    issues.push(`疑问句过多：${questionCount}/2`);
  }

  // 检查禁止的提问方式
  const forbiddenPatterns = [
    /你最近怎么样/,
    /说说你的情况/,
    /你最关心什么/,
    /有什么想问的/,
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(text)) {
      issues.push(`包含禁止的提问方式：${pattern.source}`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    assertionCount,
    questionCount,
  };
}
