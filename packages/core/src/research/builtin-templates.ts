/**
 * Built-in report templates for the research report rendering system.
 *
 * Issue #1339: Agentic Research - Template rendering for research reports.
 *
 * Provides four default templates:
 * - `summary`: Brief summary for quick sharing
 * - `detailed`: Full research report with all sections
 * - `technical`: Technical analysis with architecture details
 * - `briefing`: Executive briefing for decision-makers
 *
 * @module @disclaude/core/research
 */

import type { ReportTemplate, BuiltinTemplateType } from './template-types.js';

/**
 * Summary template — brief overview for quick sharing.
 */
const summaryTemplate: ReportTemplate = {
  id: 'summary',
  name: '研究摘要',
  description: '简短摘要，适合快速分享研究成果',
  format: 'markdown',
  tags: ['quick', 'sharing', 'brief'],
  variables: [
    { name: 'title', description: '报告标题', type: 'string', required: true },
    { name: 'topic', description: '研究主题', type: 'string', required: true },
    { name: 'summary', description: '摘要内容', type: 'string', required: true },
    { name: 'conclusions', description: '结论列表', type: 'string[]', required: false },
    { name: 'metadata.startTime', description: '研究开始时间', type: 'string', required: false },
    { name: 'metadata.endTime', description: '研究结束时间', type: 'string', required: false },
  ],
  content: `# {{title}}

> **研究主题**: {{topic}}
{{#if metadata.startTime}}
> **时间**: {{metadata.startTime}}{{#if metadata.endTime}} → {{metadata.endTime}}{{/if}}
{{/if}}

## 摘要

{{summary}}

{{#if conclusions}}
## 结论

{{#each conclusions}}
- {{this}}
{{/each}}
{{/if}}
`,
};

/**
 * Detailed template — full research report with all sections.
 */
const detailedTemplate: ReportTemplate = {
  id: 'detailed',
  name: '详细研究报告',
  description: '完整的研究报告，包含所有研究细节和发现',
  format: 'markdown',
  tags: ['full', 'comprehensive', 'complete'],
  variables: [
    { name: 'title', description: '报告标题', type: 'string', required: true },
    { name: 'topic', description: '研究主题', type: 'string', required: true },
    { name: 'summary', description: '摘要内容', type: 'string', required: true },
    { name: 'objectives', description: '研究目标列表', type: 'string[]', required: false },
    { name: 'findings', description: '研究发现', type: 'object', required: false },
    { name: 'conclusions', description: '结论列表', type: 'string[]', required: false },
    { name: 'recommendations', description: '建议列表', type: 'string[]', required: false },
    { name: 'resources', description: '参考资源', type: 'object', required: false },
    { name: 'pendingQuestions', description: '待调查问题', type: 'string[]', required: false },
    { name: 'metadata.startTime', description: '研究开始时间', type: 'string', required: false },
    { name: 'metadata.endTime', description: '研究结束时间', type: 'string', required: false },
    { name: 'metadata.version', description: '报告版本', type: 'number', required: false },
  ],
  content: `# {{title}}

> **研究主题**: {{topic}}
{{#if metadata.startTime}}
> **研究时间**: {{metadata.startTime}}{{#if metadata.endTime}} → {{metadata.endTime}}{{/if}}
{{/if}}
{{#if metadata.version}}
> **版本**: v{{metadata.version}}
{{/if}}

## 摘要

{{summary}}

{{#if objectives}}
## 研究目标

{{#each objectives}}
- [ ] {{this}}
{{/each}}
{{/if}}

{{#if findings}}
## 研究发现

{{#each findings}}
### {{title}}

{{description}}

{{#if source}}
> 来源: {{source}}
{{/if}}
{{#if confidence}}
> 置信度: {{confidence}}
{{/if}}
{{#if tags}}
> 标签: {{tags}}
{{/if}}

---
{{/each}}
{{/if}}

{{#if conclusions}}
## 结论

{{#each conclusions}}
{{this}}

{{/each}}
{{/if}}

{{#if recommendations}}
## 建议

{{#each recommendations}}
1. {{this}}
{{/each}}
{{/if}}

{{#if pendingQuestions}}
## 待调查

{{#each pendingQuestions}}
- [ ] {{this}}
{{/each}}
{{/if}}

{{#if resources}}
## 参考资料

{{#each resources}}
- [{{name}}]({{url}}){{#if description}} — {{description}}{{/if}}
{{/each}}
{{/if}}
`,
};

/**
 * Technical template — technical analysis with architecture focus.
 */
const technicalTemplate: ReportTemplate = {
  id: 'technical',
  name: '技术分析报告',
  description: '技术调研报告，侧重架构设计和实现细节',
  format: 'markdown',
  tags: ['technical', 'architecture', 'engineering'],
  variables: [
    { name: 'title', description: '报告标题', type: 'string', required: true },
    { name: 'topic', description: '研究主题', type: 'string', required: true },
    { name: 'summary', description: '摘要内容', type: 'string', required: true },
    { name: 'objectives', description: '研究目标列表', type: 'string[]', required: false },
    { name: 'findings', description: '研究发现', type: 'object', required: false },
    { name: 'conclusions', description: '结论列表', type: 'string[]', required: false },
    { name: 'recommendations', description: '建议列表', type: 'string[]', required: false },
    { name: 'resources', description: '参考资源', type: 'object', required: false },
    { name: 'pendingQuestions', description: '待调查问题', type: 'string[]', required: false },
    { name: 'metadata.startTime', description: '研究开始时间', type: 'string', required: false },
    { name: 'metadata.endTime', description: '研究结束时间', type: 'string', required: false },
    { name: 'metadata.version', description: '报告版本', type: 'number', required: false },
  ],
  content: `# {{title}}

> **调研主题**: {{topic}}
{{#if metadata.startTime}}
> **调研时间**: {{metadata.startTime}}{{#if metadata.endTime}} → {{metadata.endTime}}{{/if}}
{{/if}}
{{#if metadata.version}}
> **版本**: v{{metadata.version}}
{{/if}}

## 调研摘要

{{summary}}

{{#if objectives}}
## 调研目标

{{#each objectives}}
- [ ] {{this}}
{{/each}}
{{/if}}

{{#if findings}}
## 技术发现

{{#each findings}}
### {{title}}

{{description}}

{{#if source}}
**参考**: [{{source}}]({{source}})
{{/if}}
{{#if confidence}}
**可信度**: {{confidence}}
{{/if}}

---
{{/each}}
{{/if}}

{{#if conclusions}}
## 技术结论

{{#each conclusions}}
- {{this}}
{{/each}}
{{/if}}

{{#if recommendations}}
## 实施建议

{{#each recommendations}}
1. {{this}}
{{/each}}
{{/if}}

{{#if pendingQuestions}}
## 开放问题

{{#each pendingQuestions}}
- [ ] {{this}}
{{/each}}
{{/if}}

{{#if resources}}
## 参考资料

| 资源 | 链接 | 说明 |
|------|------|------|
{{#each resources}}
| {{name}} | [链接]({{url}}) | {{#if description}}{{description}}{{/if}} |
{{/each}}
{{/if}}
`,
};

/**
 * Briefing template — executive summary for decision-makers.
 */
const briefingTemplate: ReportTemplate = {
  id: 'briefing',
  name: '决策简报',
  description: '面向决策者的精炼简报，突出关键结论和建议',
  format: 'markdown',
  tags: ['executive', 'decision', 'brief'],
  variables: [
    { name: 'title', description: '报告标题', type: 'string', required: true },
    { name: 'topic', description: '研究主题', type: 'string', required: true },
    { name: 'summary', description: '摘要内容', type: 'string', required: true },
    { name: 'conclusions', description: '结论列表', type: 'string[]', required: false },
    { name: 'recommendations', description: '建议列表', type: 'string[]', required: false },
    { name: 'metadata.startTime', description: '研究开始时间', type: 'string', required: false },
    { name: 'metadata.endTime', description: '研究结束时间', type: 'string', required: false },
  ],
  content: `# 📋 {{title}}

> **主题**: {{topic}}
{{#if metadata.startTime}}
> **日期**: {{metadata.startTime}}
{{/if}}

---

## 📌 核心结论

{{summary}}

{{#if conclusions}}
## ✅ 关键发现

{{#each conclusions}}
- {{this}}
{{/each}}
{{/if}}

{{#if recommendations}}
## 🎯 行动建议

{{#each recommendations}}
1. {{this}}
{{/each}}
{{/if}}

---
*本简报由研究系统自动生成*
`,
};

/**
 * Map of all built-in templates by ID.
 */
const builtinTemplates: Map<string, ReportTemplate> = new Map([
  [summaryTemplate.id, summaryTemplate],
  [detailedTemplate.id, detailedTemplate],
  [technicalTemplate.id, technicalTemplate],
  [briefingTemplate.id, briefingTemplate],
]);

/**
 * Get a built-in template by type.
 *
 * @param type - Built-in template type identifier
 * @returns The template, or undefined if not found
 */
export function getBuiltinTemplate(type: BuiltinTemplateType): ReportTemplate | undefined {
  return builtinTemplates.get(type);
}

/**
 * Get all built-in templates.
 *
 * @returns Array of all built-in templates
 */
export function getAllBuiltinTemplates(): ReportTemplate[] {
  return Array.from(builtinTemplates.values());
}

/**
 * Check if a template ID corresponds to a built-in template.
 *
 * @param id - Template ID to check
 * @returns True if the template is a built-in
 */
export function isBuiltinTemplate(id: string): boolean {
  return builtinTemplates.has(id);
}

/**
 * List available built-in template types.
 *
 * @returns Array of available built-in template type identifiers
 */
export function listBuiltinTemplateTypes(): BuiltinTemplateType[] {
  return ['summary', 'detailed', 'technical', 'briefing'];
}
